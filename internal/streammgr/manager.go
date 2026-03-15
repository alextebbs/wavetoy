package streammgr

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/fallback"
	"github.com/sammy/sdr-radio/internal/filter"
	"github.com/sammy/sdr-radio/internal/interpreter"
	"github.com/sammy/sdr-radio/internal/kiwi"
	"github.com/sammy/sdr-radio/internal/models"
	"github.com/sammy/sdr-radio/internal/ringbuf"
	"github.com/sammy/sdr-radio/internal/streamlog"
)

var ErrStreamNotActive = errors.New("stream is not active")

type Manager struct {
	db         *db.DB
	log        *streamlog.Logger
	runtimeCtx context.Context

	mu      sync.RWMutex
	streams map[string]*activeStream

	onDegradedMu    sync.RWMutex
	onDegraded      func(streamID, reason string)
	onStateChangeMu sync.RWMutex
	onStateChange   func(streamID, state string)

	onInterpreterOutputMu sync.RWMutex
	onInterpreterOutput   func(streamID string, output interpreter.Output)
}

type listenSession struct {
	sourceID  string
	startedAt time.Time
	gotSound  atomic.Bool
	gotWF     atomic.Bool
	committed atomic.Bool
}

type activeStream struct {
	id       string
	sourceID string

	mu           sync.RWMutex
	client       *kiwi.Client
	wfClient     *kiwi.WFClient
	generation   uint64
	reconnecting bool

	subscribers   map[chan []byte]struct{}
	wfSubscribers map[chan kiwi.WFFrame]struct{}
	startedAt     time.Time
	ringBuf       *ringbuf.RingBuffer
	filterChain   *filter.Chain
	autoFallback  bool
	qualityMon    *fallback.QualityMonitor
	listen        *listenSession

	interp interpreter.Interpreter

	framesFromKiwi     atomic.Int64
	bytesFromKiwi      atomic.Int64
	fanoutDelivered    atomic.Int64
	fanoutDroppedFinal atomic.Int64

	// Pump performance tracking (updated per-frame, read every 10s)
	perfMu          sync.Mutex
	perfFrames      int64
	perfTotalUs     int64
	perfMaxUs       int64
	perfFilterUs    int64
	perfInterpUs    int64
	perfBroadcastUs int64
}

func New(database *db.DB, logger *streamlog.Logger) *Manager {
	return &Manager{
		db:         database,
		log:        logger,
		runtimeCtx: context.Background(),
		streams:    make(map[string]*activeStream),
	}
}

func (m *Manager) SetOnDegraded(fn func(streamID, reason string)) {
	m.onDegradedMu.Lock()
	m.onDegraded = fn
	m.onDegradedMu.Unlock()
}

func (m *Manager) SetOnStateChange(fn func(streamID, state string)) {
	m.onStateChangeMu.Lock()
	m.onStateChange = fn
	m.onStateChangeMu.Unlock()
}

func (m *Manager) SetOnInterpreterOutput(fn func(streamID string, output interpreter.Output)) {
	m.onInterpreterOutputMu.Lock()
	m.onInterpreterOutput = fn
	m.onInterpreterOutputMu.Unlock()
}

func (m *Manager) notifyInterpreterOutput(streamID string, output interpreter.Output) {
	m.onInterpreterOutputMu.RLock()
	fn := m.onInterpreterOutput
	m.onInterpreterOutputMu.RUnlock()
	if fn != nil {
		fn(streamID, output)
	}
}

func (m *Manager) notifyStateChange(streamID, state string) {
	m.onStateChangeMu.RLock()
	fn := m.onStateChange
	m.onStateChangeMu.RUnlock()
	if fn != nil {
		fn(streamID, state)
	}
}

func newListenSession(sourceID string) *listenSession {
	return &listenSession{
		sourceID:  sourceID,
		startedAt: time.Now(),
	}
}

func (m *Manager) tryCommitListen(as *activeStream) {
	ls := as.listen
	if ls == nil {
		return
	}
	if !ls.gotSound.Load() || !ls.gotWF.Load() {
		return
	}
	if ls.committed.Swap(true) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := m.db.InsertRecentSource(ctx, as.id, ls.sourceID, ls.startedAt); err != nil {
			m.log.Warn(as.id, "recent.insert", fmt.Sprintf("err=%v", err))
		}
	}()
}

func (m *Manager) SetAutoFallback(streamID string, enabled bool) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return
	}

	as.mu.Lock()
	as.autoFallback = enabled
	if enabled && as.qualityMon == nil {
		m.onDegradedMu.RLock()
		onDeg := m.onDegraded
		m.onDegradedMu.RUnlock()
		qm := fallback.NewQualityMonitor(func(reason string) {
			if onDeg != nil {
				onDeg(streamID, reason)
			}
		})
		qm.SetOnTransition(func(from, to fallback.DegradationState, reason string) {
			m.log.Info(streamID, "quality.change", fmt.Sprintf("%s → %s reason=%s", from, to, reason))
		})
		as.qualityMon = qm
	} else if !enabled {
		as.qualityMon = nil
	}
	as.mu.Unlock()
}

func (m *Manager) EnsureRunning(ctx context.Context, stream models.Stream) error {
	m.mu.RLock()
	as, ok := m.streams[stream.ID]
	m.mu.RUnlock()
	if ok {
		as.mu.RLock()
		running := as.client != nil
		as.mu.RUnlock()
		if running {
			return nil
		}
		client, wfClient, err := m.connectClient(ctx, stream)
		if err != nil {
			_ = m.db.UpdateStreamState(ctx, stream.ID, "stopped")
			m.notifyStateChange(stream.ID, "stopped")
			return err
		}
		as.mu.Lock()
		as.client = client
		as.wfClient = wfClient
		as.sourceID = stream.SourceID
		as.generation++
		if as.startedAt.IsZero() {
			as.startedAt = time.Now()
		}
		as.listen = newListenSession(stream.SourceID)
		gen := as.generation
		as.mu.Unlock()
		_ = m.db.UpdateStreamState(ctx, stream.ID, "active")
		m.notifyStateChange(stream.ID, "active")
		m.log.Info(stream.ID, "state.change", "connecting → active")
		m.startPump(as, client, gen)
		if wfClient != nil {
			m.startWFPump(as, wfClient, gen)
		}
		return nil
	}

	return m.startStream(ctx, stream)
}

func (m *Manager) Reconfigure(ctx context.Context, stream models.Stream) error {
	m.mu.RLock()
	existing, exists := m.streams[stream.ID]
	m.mu.RUnlock()
	if !exists {
		m.log.Info(stream.ID, "connect", "not tracked, starting fresh")
		return m.startStream(ctx, stream)
	}

	existing.mu.RLock()
	currentClient := existing.client
	currentSourceID := existing.sourceID
	existing.mu.RUnlock()

	if currentClient != nil && currentSourceID == stream.SourceID {
		if err := currentClient.Reconfigure(kiwi.Config{
			Name:          stream.Name,
			FrequencyKHz:  stream.FrequencyKHz,
			Mode:          stream.Mode,
			BandwidthLoHz: stream.BandwidthLowHz,
			BandwidthHiHz: stream.BandwidthHighHz,
			AGCOn:         stream.AGCOn,
			AGCGainDB:     stream.AGCGainDB,
		}); err != nil {
			return err
		}
		existing.filterChain.Reconfigure(filter.BuildFilters(stream.Filters, m.SampleRate(stream.ID)))
		m.reconfigureInterpreter(existing, stream)
		return nil
	}

	m.log.Wire(stream.ID, streamlog.LevelInfo, "source.switch", "wavetoy", "kiwi", fmt.Sprintf("%s → %s", currentSourceID, stream.SourceID))
	client, wfClient, err := m.connectClient(ctx, stream)
	if err != nil {
		_ = m.db.UpdateStreamState(ctx, stream.ID, "stopped")
		m.notifyStateChange(stream.ID, "stopped")
		return err
	}

	existing.mu.Lock()
	oldClient := existing.client
	oldWFClient := existing.wfClient
	existing.client = client
	existing.wfClient = wfClient
	existing.sourceID = stream.SourceID
	existing.generation++
	existing.listen = newListenSession(stream.SourceID)
	gen := existing.generation
	existing.mu.Unlock()

	_ = m.db.UpdateStreamState(ctx, stream.ID, "active")
	m.notifyStateChange(stream.ID, "active")
	existing.filterChain.Reconfigure(filter.BuildFilters(stream.Filters, client.SampleRate()))
	m.reconfigureInterpreter(existing, stream)
	m.startPump(existing, client, gen)
	if wfClient != nil {
		m.startWFPump(existing, wfClient, gen)
	}
	if oldClient != nil {
		m.log.Debug(stream.ID, "connect", "closing old kiwi connection (source switch)")
		_ = oldClient.Close()
	}
	if oldWFClient != nil {
		_ = oldWFClient.Close()
	}
	return nil
}

func (m *Manager) connectClient(ctx context.Context, stream models.Stream) (*kiwi.Client, *kiwi.WFClient, error) {
	source, err := m.db.GetSourceByID(ctx, stream.SourceID)
	if err != nil {
		return nil, nil, err
	}
	if source == nil {
		return nil, nil, fmt.Errorf("source %s not found", stream.SourceID)
	}

	m.log.Wire(stream.ID, streamlog.LevelDebug, "dial", "wavetoy", "kiwi",
		fmt.Sprintf("%s:%d tls=%v freq=%.3fkHz mode=%s", source.Host, source.Port, source.UseTLS, stream.FrequencyKHz, stream.Mode))

	_ = m.db.UpdateStreamState(ctx, stream.ID, "connecting")
	m.notifyStateChange(stream.ID, "connecting")
	ts := kiwi.ConnectTimestamp()

	logFn := m.log.MakeLogFunc(stream.ID)
	client, err := kiwi.Connect(ctx, kiwi.Config{
		Host:          source.Host,
		Port:          source.Port,
		UseTLS:        source.UseTLS,
		Name:          stream.Name,
		FrequencyKHz:  stream.FrequencyKHz,
		Mode:          stream.Mode,
		BandwidthLoHz: stream.BandwidthLowHz,
		BandwidthHiHz: stream.BandwidthHighHz,
		AGCOn:         stream.AGCOn,
		AGCGainDB:     stream.AGCGainDB,
	}, ts, logFn)
	if err != nil {
		m.log.Wire(stream.ID, streamlog.LevelError, "connect.fail", "wavetoy", "kiwi", fmt.Sprintf("source=%s:%d err=%v", source.Host, source.Port, err))
		return nil, nil, err
	}
	m.log.Wire(stream.ID, streamlog.LevelInfo, "connect", "wavetoy", "kiwi", fmt.Sprintf("source=%s:%d freq=%.3fkHz mode=%s", source.Host, source.Port, stream.FrequencyKHz, stream.Mode))

	wfZoom, wfCenter := wfParamsFromView(stream.WFViewStartKHz, stream.WFViewEndKHz)
	wfClient, err := kiwi.ConnectWF(ctx, kiwi.WFConfig{
		Host:      source.Host,
		Port:      source.Port,
		UseTLS:    source.UseTLS,
		Name:      stream.Name,
		Zoom:      wfZoom,
		CenterKHz: wfCenter,
		Speed:     4,
		Compress:  false,
	}, ts, logFn)
	if err != nil {
		m.log.Wire(stream.ID, streamlog.LevelWarn, "wf.connect.fail", "wavetoy", "kiwi", fmt.Sprintf("source=%s:%d err=%v (continuing without waterfall)", source.Host, source.Port, err))
		return client, nil, nil
	}
	m.log.Wire(stream.ID, streamlog.LevelInfo, "wf.connect", "wavetoy", "kiwi", fmt.Sprintf("source=%s:%d", source.Host, source.Port))

	return client, wfClient, nil
}

const kiwiBandwidthKHz = 30000.0

func wfParamsFromView(startKHz, endKHz float64) (zoom int, centerKHz float64) {
	if endKHz <= startKHz || (startKHz == 0 && endKHz == 0) {
		return 0, kiwiBandwidthKHz / 2
	}
	viewSpan := endKHz - startKHz
	centerKHz = (startKHz + endKHz) / 2
	desiredSpan := viewSpan * 1.3
	z := math.Log2(kiwiBandwidthKHz / desiredSpan)
	zoom = int(math.Floor(z))
	if zoom < 0 {
		zoom = 0
	} else if zoom > 14 {
		zoom = 14
	}
	return zoom, centerKHz
}

func (m *Manager) startStream(ctx context.Context, stream models.Stream) error {
	client, wfClient, err := m.connectClient(ctx, stream)
	if err != nil {
		_ = m.db.UpdateStreamState(ctx, stream.ID, "stopped")
		m.notifyStateChange(stream.ID, "stopped")
		return err
	}

	bufMinutes := stream.BufferMinutes
	if bufMinutes <= 0 {
		bufMinutes = 5
	}
	bufDuration := time.Duration(bufMinutes) * time.Minute
	bufCapacity := 24 * 60 * bufMinutes * 2

	as := &activeStream{
		id:            stream.ID,
		sourceID:      stream.SourceID,
		client:        client,
		wfClient:      wfClient,
		generation:    1,
		subscribers:   make(map[chan []byte]struct{}),
		wfSubscribers: make(map[chan kiwi.WFFrame]struct{}),
		startedAt:     time.Now(),
		ringBuf:       ringbuf.New(bufDuration, bufCapacity),
		filterChain:   filter.NewChain(stream.Filters, client.SampleRate()),
		interp:        interpreter.New(stream.Interpreter, client.SampleRate()),
		autoFallback:  stream.AutoFallback,
		listen:        newListenSession(stream.SourceID),
	}

	m.mu.Lock()
	if _, exists := m.streams[stream.ID]; exists {
		m.mu.Unlock()
		m.log.Debug(stream.ID, "startstream.race", "already tracked, closing new connection")
		_ = client.Close()
		if wfClient != nil {
			_ = wfClient.Close()
		}
		return nil
	}
	m.streams[stream.ID] = as
	m.mu.Unlock()

	_ = m.db.UpdateStreamState(ctx, stream.ID, "active")
	m.notifyStateChange(stream.ID, "active")
	m.log.Info(stream.ID, "state.change", "connecting → active")
	m.log.Info(stream.ID, "pump.start", fmt.Sprintf("gen=%d", as.generation))
	m.startPump(as, client, as.generation)
	if wfClient != nil {
		m.startWFPump(as, wfClient, as.generation)
	}
	return nil
}

func (m *Manager) Subscribe(streamID string) (<-chan []byte, func(), error) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return nil, nil, ErrStreamNotActive
	}
	as.mu.RLock()
	running := as.client != nil
	as.mu.RUnlock()
	if !running {
		return nil, nil, ErrStreamNotActive
	}

	ch := make(chan []byte, 256)
	as.mu.Lock()
	as.subscribers[ch] = struct{}{}
	subCount := len(as.subscribers)
	as.mu.Unlock()
	m.log.Info(streamID, "subscriber.add", fmt.Sprintf("total=%d", subCount))

	unsubscribe := func() {
		as.mu.Lock()
		if _, exists := as.subscribers[ch]; exists {
			delete(as.subscribers, ch)
			close(ch)
			m.log.Info(streamID, "subscriber.remove", fmt.Sprintf("total=%d", len(as.subscribers)))
		}
		as.mu.Unlock()
	}

	return ch, unsubscribe, nil
}

func (m *Manager) ReconfigureWaterfall(streamID string, zoom int, centerKHz float64, speed int) error {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return ErrStreamNotActive
	}
	as.mu.RLock()
	wf := as.wfClient
	as.mu.RUnlock()
	if wf == nil {
		return fmt.Errorf("no waterfall client for stream %s", streamID)
	}
	m.log.Debug(streamID, "wf.reconfig", fmt.Sprintf("zoom=%d center=%.1fkHz speed=%d", zoom, centerKHz, speed))
	return wf.Reconfigure(zoom, centerKHz, speed)
}

func (m *Manager) SubscribeWaterfall(streamID string) (<-chan kiwi.WFFrame, func(), error) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return nil, nil, ErrStreamNotActive
	}
	as.mu.RLock()
	hasWF := as.wfClient != nil
	as.mu.RUnlock()
	if !hasWF {
		return nil, nil, fmt.Errorf("waterfall not available for stream %s", streamID)
	}

	ch := make(chan kiwi.WFFrame, 32)
	as.mu.Lock()
	if as.wfSubscribers == nil {
		as.wfSubscribers = make(map[chan kiwi.WFFrame]struct{})
	}
	as.wfSubscribers[ch] = struct{}{}
	subCount := len(as.wfSubscribers)
	as.mu.Unlock()
	m.log.Info(streamID, "wf.subscriber.add", fmt.Sprintf("total=%d", subCount))

	unsubscribe := func() {
		as.mu.Lock()
		if _, exists := as.wfSubscribers[ch]; exists {
			delete(as.wfSubscribers, ch)
			close(ch)
			m.log.Info(streamID, "wf.subscriber.remove", fmt.Sprintf("total=%d", len(as.wfSubscribers)))
		}
		as.mu.Unlock()
	}

	return ch, unsubscribe, nil
}

func (m *Manager) MaxFreqKHz(streamID string) int64 {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return 30000
	}
	as.mu.RLock()
	wf := as.wfClient
	as.mu.RUnlock()
	if wf == nil {
		return 30000
	}
	return wf.MaxFreqKHz()
}

func (m *Manager) SampleRate(streamID string) int {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok || as == nil {
		return 12000
	}
	as.mu.RLock()
	client := as.client
	as.mu.RUnlock()
	if client == nil {
		return 12000
	}
	rate := client.SampleRate()
	if rate <= 0 {
		return 12000
	}
	return rate
}

func (m *Manager) Remove(streamID string) error {
	m.mu.Lock()
	as, ok := m.streams[streamID]
	if ok {
		delete(m.streams, streamID)
	}
	m.mu.Unlock()
	if !ok || as == nil {
		return nil
	}

	as.mu.Lock()
	client := as.client
	wfClient := as.wfClient
	as.client = nil
	as.wfClient = nil
	as.generation++
	as.reconnecting = false
	subCount := len(as.subscribers)
	for ch := range as.subscribers {
		delete(as.subscribers, ch)
		close(ch)
	}
	wfSubCount := len(as.wfSubscribers)
	for ch := range as.wfSubscribers {
		delete(as.wfSubscribers, ch)
		close(ch)
	}
	as.mu.Unlock()

	m.log.Info(streamID, "deleted", fmt.Sprintf("disconnected subs=%d wf_subs=%d", subCount, wfSubCount))
	if client != nil {
		_ = client.Close()
	}
	if wfClient != nil {
		_ = wfClient.Close()
	}
	m.log.Remove(streamID)
	return nil
}

func (m *Manager) startPump(as *activeStream, client *kiwi.Client, generation uint64) {
	go func() {
		m.log.Info(as.id, "pump.start", fmt.Sprintf("gen=%d", generation))
		metricsTicker := time.NewTicker(10 * time.Second)
		defer metricsTicker.Stop()

		qualityTicker := time.NewTicker(1 * time.Second)
		defer qualityTicker.Stop()

		defer func() {
			as.mu.Lock()
			stillCurrent := as.client == client && as.generation == generation
			hasSubscribers := len(as.subscribers) > 0
			keepAlive := as.autoFallback
			qm := as.qualityMon
			if stillCurrent {
				as.client = nil
			}
			as.mu.Unlock()

			if qm != nil && stillCurrent {
				qm.RecordDisconnect()
			}

			if stillCurrent {
				shouldReconnect := hasSubscribers || keepAlive
				m.log.Info(as.id, "pump.stop", fmt.Sprintf("gen=%d subs=%d auto_fb=%v will_reconnect=%v", generation, boolToInt(hasSubscribers), keepAlive, shouldReconnect))
				_ = m.db.UpdateStreamState(context.Background(), as.id, "stopped")
				m.notifyStateChange(as.id, "stopped")
				m.log.Info(as.id, "state.change", "active → stopped")
				if shouldReconnect {
					m.ensureReconnect(as)
				}
			} else {
				m.log.Debug(as.id, "pump.stop", fmt.Sprintf("gen=%d (superseded)", generation))
			}
		}()

		for {
			select {
			case <-m.runtimeCtx.Done():
				m.log.Info(as.id, "pump.stop", fmt.Sprintf("gen=%d reason=shutdown", generation))
				return
			case <-client.Done():
				m.log.Wire(as.id, streamlog.LevelWarn, "disconnect", "wavetoy", "kiwi", "kiwi connection closed")
				return
			case <-metricsTicker.C:
				m.logAudioMetrics(as, client, generation)
			case <-qualityTicker.C:
				as.mu.RLock()
				qm := as.qualityMon
				as.mu.RUnlock()
				if qm != nil {
					qm.CheckTimeout()
				}
		case frame, ok := <-client.Samples():
			if !ok {
				m.log.Wire(as.id, streamlog.LevelWarn, "disconnect", "wavetoy", "kiwi", "sample channel closed")
				return
			}
			frameStart := time.Now()

			as.framesFromKiwi.Add(1)
			as.bytesFromKiwi.Add(int64(len(frame)))

			t0 := time.Now()
			filtered := as.filterChain.Process(frame)
			filterElapsed := time.Since(t0)

			if as.ringBuf != nil {
				as.ringBuf.Write(time.Now(), filtered)
			}

			t1 := time.Now()
			as.broadcast(filtered)
			broadcastElapsed := time.Since(t1)

			as.mu.RLock()
			interp := as.interp
			as.mu.RUnlock()

			var interpElapsed time.Duration
			if interp != nil {
				t2 := time.Now()
				outputs := interp.Feed(filtered)
				interpElapsed = time.Since(t2)
				for _, o := range outputs {
					m.notifyInterpreterOutput(as.id, o)
				}
			}

			totalElapsed := time.Since(frameStart)
			as.perfMu.Lock()
			as.perfFrames++
			us := totalElapsed.Microseconds()
			as.perfTotalUs += us
			if us > as.perfMaxUs {
				as.perfMaxUs = us
			}
			as.perfFilterUs += filterElapsed.Microseconds()
			as.perfInterpUs += interpElapsed.Microseconds()
			as.perfBroadcastUs += broadcastElapsed.Microseconds()
			as.perfMu.Unlock()

			if ls := as.listen; ls != nil && !ls.gotSound.Load() {
				ls.gotSound.Store(true)
				m.tryCommitListen(as)
			}

			as.mu.RLock()
			frameQM := as.qualityMon
			as.mu.RUnlock()
			if frameQM != nil {
				frameQM.RecordFrame()
			}
			}
		}
	}()
}

func (m *Manager) startWFPump(as *activeStream, wfClient *kiwi.WFClient, generation uint64) {
	go func() {
		m.log.Info(as.id, "wf.pump.start", fmt.Sprintf("gen=%d", generation))
		defer func() {
			as.mu.Lock()
			if as.wfClient == wfClient {
				as.wfClient = nil
			}
			as.mu.Unlock()
			m.log.Info(as.id, "wf.pump.stop", fmt.Sprintf("gen=%d", generation))
		}()

		const wfTimeout = 15 * time.Second
		timer := time.NewTimer(wfTimeout)
		defer timer.Stop()
		gotFirstFrame := false

		for {
			select {
			case <-m.runtimeCtx.Done():
				return
			case <-wfClient.Done():
				if !gotFirstFrame {
					m.log.Wire(as.id, streamlog.LevelWarn, "wf.disconnect", "wavetoy", "kiwi", "closed before receiving data")
				}
				return
			case <-timer.C:
				if !gotFirstFrame {
					m.log.Warn(as.id, "wf.timeout", fmt.Sprintf("no data in %s", wfTimeout))
				}
		case frame, ok := <-wfClient.Frames():
			if !ok {
				return
			}
			if !gotFirstFrame {
				gotFirstFrame = true
				timer.Stop()
			}
			as.broadcastWF(frame)

			if ls := as.listen; ls != nil && !ls.gotWF.Load() {
				ls.gotWF.Store(true)
				m.tryCommitListen(as)
			}
			}
		}
	}()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (m *Manager) logAudioMetrics(as *activeStream, client *kiwi.Client, generation uint64) {
	as.mu.RLock()
	current := as.client == client && as.generation == generation
	subscriberCount := len(as.subscribers)
	startedAt := as.startedAt
	as.mu.RUnlock()
	if !current {
		return
	}

	uptimeSec := int64(0)
	if !startedAt.IsZero() {
		uptimeSec = int64(time.Since(startedAt).Seconds())
	}
	kstats := client.Stats()

	m.log.Debug(as.id, "pump.metrics", fmt.Sprintf(
		"uptime=%ds subs=%d kiwi_frames=%d kiwi_bytes=%d kiwi_drops=%d fanout_ok=%d fanout_drop=%d",
		uptimeSec,
		subscriberCount,
		kstats.SNDFramesIn,
		kstats.SNDBytesIn,
		kstats.SNDQueueDropFrames,
		as.fanoutDelivered.Load(),
		as.fanoutDroppedFinal.Load(),
	))

	as.perfMu.Lock()
	frames := as.perfFrames
	totalUs := as.perfTotalUs
	maxUs := as.perfMaxUs
	filterUs := as.perfFilterUs
	interpUs := as.perfInterpUs
	broadcastUs := as.perfBroadcastUs
	as.perfFrames = 0
	as.perfTotalUs = 0
	as.perfMaxUs = 0
	as.perfFilterUs = 0
	as.perfInterpUs = 0
	as.perfBroadcastUs = 0
	as.perfMu.Unlock()

	if frames > 0 {
		avgUs := totalUs / frames
		avgFilterUs := filterUs / frames
		avgInterpUs := interpUs / frames
		avgBcastUs := broadcastUs / frames

		budgetUs := int64(10_000_000) / frames // per-frame budget based on observed rate
		maxPct := float64(0)
		if budgetUs > 0 {
			maxPct = float64(maxUs) * 100 / float64(budgetUs)
		}

		level := streamlog.LevelDebug
		if maxPct >= 100 {
			level = streamlog.LevelError
		} else if maxPct >= 80 {
			level = streamlog.LevelWarn
		}

		m.log.Log(as.id, level, "pump.perf", fmt.Sprintf(
			"frames=%d avg=%dµs max=%dµs filter=%dµs interp=%dµs broadcast=%dµs max_budget=%.1f%%",
			frames, avgUs, maxUs, avgFilterUs, avgInterpUs, avgBcastUs, maxPct,
		))
	}
}

func (m *Manager) ensureReconnect(as *activeStream) {
	as.mu.Lock()
	if as.reconnecting {
		as.mu.Unlock()
		return
	}
	as.reconnecting = true
	as.mu.Unlock()

	m.log.Wire(as.id, streamlog.LevelInfo, "reconnect.start", "wavetoy", "kiwi", "initiating reconnection")

	go func() {
		defer func() {
			as.mu.Lock()
			as.reconnecting = false
			as.mu.Unlock()
		}()

		backoff := time.Second
		attempt := 0
		for {
			select {
			case <-m.runtimeCtx.Done():
				m.log.Info(as.id, "reconnect.abandon", "runtime shutdown")
				return
			default:
			}

			as.mu.RLock()
			hasSubscribers := len(as.subscribers) > 0
			alreadyRunning := as.client != nil
			keepAlive := as.autoFallback
			as.mu.RUnlock()
			if alreadyRunning || (!hasSubscribers && !keepAlive) {
				m.log.Info(as.id, "reconnect.abandon", fmt.Sprintf("subs=%v auto_fb=%v running=%v", hasSubscribers, keepAlive, alreadyRunning))
				return
			}

			attempt++
			m.log.Info(as.id, "reconnect.start", fmt.Sprintf("attempt=%d backoff=%s", attempt, backoff))

			stream, err := m.db.GetStreamByID(context.Background(), as.id)
			if err != nil || stream == nil {
				m.log.Warn(as.id, "reconnect.start", fmt.Sprintf("db lookup failed: %v", err))
				time.Sleep(backoff)
				backoff = minDuration(backoff*2, 15*time.Second)
				continue
			}

			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			client, wfClient, err := m.connectClient(ctx, *stream)
			cancel()
			if err != nil {
				m.log.Warn(as.id, "reconnect.start", fmt.Sprintf("attempt=%d failed: %v", attempt, err))
				time.Sleep(backoff)
				backoff = minDuration(backoff*2, 15*time.Second)
				continue
			}

			as.mu.Lock()
			if as.client != nil || (len(as.subscribers) == 0 && !as.autoFallback) {
				as.mu.Unlock()
				m.log.Debug(as.id, "reconnect.race", "state changed during connect, discarding")
				_ = client.Close()
				if wfClient != nil {
					_ = wfClient.Close()
				}
				return
			}
			as.client = client
			as.wfClient = wfClient
			as.sourceID = stream.SourceID
			as.generation++
			if as.startedAt.IsZero() {
				as.startedAt = time.Now()
			}
			as.listen = newListenSession(stream.SourceID)
			gen := as.generation
			as.mu.Unlock()

			m.log.Wire(as.id, streamlog.LevelInfo, "reconnect.ok", "wavetoy", "kiwi", fmt.Sprintf("after %d attempts gen=%d", attempt, gen))
			_ = m.db.UpdateStreamState(context.Background(), as.id, "active")
			m.notifyStateChange(as.id, "active")
			m.log.Info(as.id, "state.change", "stopped → active")
			m.startPump(as, client, gen)
			if wfClient != nil {
				m.startWFPump(as, wfClient, gen)
			}
			return
		}
	}()
}

func (m *Manager) CaptureAudio(streamID string) (*ringbuf.Snapshot, error) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return nil, ErrStreamNotActive
	}
	if as.ringBuf == nil {
		return nil, fmt.Errorf("no ring buffer for stream %s", streamID)
	}
	sampleRate := m.SampleRate(streamID)
	snap := as.ringBuf.Snapshot(streamID, sampleRate)
	m.log.Info(streamID, "capture", fmt.Sprintf("entries=%d duration=%s sample_rate=%d", len(snap.Audio), snap.EndTime.Sub(snap.StartTime), sampleRate))
	return snap, nil
}

func (m *Manager) CollectSnapshot(ctx context.Context, streamID string, duration time.Duration, stream models.Stream) (fallback.SnapshotResult, error) {
	audioCh, audioUnsub, err := m.Subscribe(streamID)
	if err != nil {
		return fallback.SnapshotResult{Snapshot: fallback.AudioSnapshot{SilenceRatio: 1}}, err
	}
	defer audioUnsub()

	sampleRate := m.SampleRate(streamID)

	var wfCh <-chan kiwi.WFFrame
	var wfUnsub func()
	wfCh, wfUnsub, err = m.SubscribeWaterfall(streamID)
	if err == nil {
		defer wfUnsub()
	} else {
		wfCh = nil
	}

	deadline := time.After(duration)
	var audioFrames [][]byte
	var wfFrames []kiwi.WFFrame

	finalize := func() fallback.SnapshotResult {
		snap := fallback.CaptureReferenceSnapshot(audioFrames, wfFrames, duration, stream)
		totalLen := 0
		for _, f := range audioFrames {
			totalLen += len(f)
		}
		raw := make([]byte, 0, totalLen)
		for _, f := range audioFrames {
			raw = append(raw, f...)
		}
		return fallback.SnapshotResult{Snapshot: snap, RawPCM: raw, SampleRate: sampleRate}
	}

	for {
		select {
		case <-ctx.Done():
			return finalize(), ctx.Err()
		case <-deadline:
			return finalize(), nil
		case frame, ok := <-audioCh:
			if !ok {
				return finalize(), nil
			}
			buf := make([]byte, len(frame))
			copy(buf, frame)
			audioFrames = append(audioFrames, buf)
		case wfFrame, ok := <-wfCh:
			if ok {
				wfFrames = append(wfFrames, wfFrame)
			}
		}
	}
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func (m *Manager) reconfigureInterpreter(as *activeStream, stream models.Stream) {
	sampleRate := m.SampleRate(stream.ID)
	as.mu.Lock()
	defer as.mu.Unlock()

	if stream.Interpreter.Enabled {
		if as.interp != nil && stream.Interpreter.Type != "" {
			as.interp.Reconfigure(stream.Interpreter)
		} else {
			as.interp = interpreter.New(stream.Interpreter, sampleRate)
		}
	} else {
		if as.interp != nil {
			as.interp.Reset()
			as.interp = nil
		}
	}
}

func (as *activeStream) broadcast(frame []byte) {
	as.mu.RLock()
	defer as.mu.RUnlock()

	for ch := range as.subscribers {
		select {
		case ch <- frame:
			as.fanoutDelivered.Add(1)
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- frame:
				as.fanoutDelivered.Add(1)
			default:
				as.fanoutDroppedFinal.Add(1)
			}
		}
	}
}

func (as *activeStream) broadcastWF(frame kiwi.WFFrame) {
	as.mu.RLock()
	defer as.mu.RUnlock()

	for ch := range as.wfSubscribers {
		select {
		case ch <- frame:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- frame:
			default:
			}
		}
	}
}
