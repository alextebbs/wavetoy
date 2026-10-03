package streammgr

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"encoding/json"

	"github.com/sammy/sdr-radio/internal/chunkring"
	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/probe"
	"github.com/sammy/sdr-radio/internal/filter"
	"github.com/sammy/sdr-radio/internal/interpreter"
	"github.com/sammy/sdr-radio/internal/kiwi"
	"github.com/sammy/sdr-radio/internal/models"
	"github.com/sammy/sdr-radio/internal/quality"
	s3client "github.com/sammy/sdr-radio/internal/s3"
	"github.com/sammy/sdr-radio/internal/snr"
	"github.com/sammy/sdr-radio/internal/streamlog"
)

var ErrStreamNotActive = errors.New("stream is not active")

func (m *Manager) syncStreamLogLevel(streamID, logLevel string) {
	lvl := streamlog.LevelInfo
	if logLevel != "" {
		switch logLevel {
		case "debug":
			lvl = streamlog.LevelDebug
		case "warn":
			lvl = streamlog.LevelWarn
		case "error":
			lvl = streamlog.LevelError
		}
	}
	m.log.SetLevel(streamID, lvl)
}

type Manager struct {
	db         *db.DB
	log        *streamlog.Logger
	runtimeCtx context.Context
	s3Client   *s3client.Client

	mu      sync.RWMutex
	streams map[string]*activeStream

	onDegradedMu    sync.RWMutex
	onDegraded      func(streamID, reason string)
	onStateChangeMu sync.RWMutex
	onStateChange   func(streamID, state string, health []string)

	onInterpreterOutputMu sync.RWMutex
	onInterpreterOutput   func(streamID string, output interpreter.Output)

	onChunkCompleteMu sync.RWMutex
	onChunkComplete    func(streamID string, meta chunkring.ChunkMeta)

	onSuggSNRMu    sync.RWMutex
	onSuggSNR      func(streamID string) (float64, bool)
	onIsFavoriteMu sync.RWMutex
	onIsFavorite   func(streamID, sourceID string) bool
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
	chunkRing     *chunkring.ChunkRing
	filterChain  *filter.Chain
	autoProbe bool
	keepAlive bool
	listen       *listenSession

	idleSince        time.Time
	idleDisconnected bool

	reconnectBackoff  time.Duration
	reconnectAttempts int
	lastConnectedAt   time.Time

	interp     interpreter.Interpreter
	interpType string

	tuneFreqKHz   float32
	tunePassLo    int16
	tunePassHi    int16

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
	perfChunkUs     int64

	// WF pump performance tracking
	wfPerfMu          sync.Mutex
	wfPerfFrames      int64
	wfPerfTotalUs     int64
	wfPerfMaxUs       int64
	wfPerfBroadcastUs int64
	wfPerfChunkUs     int64

	audioStale atomic.Bool
	wfStale    atomic.Bool
	tooBusy    atomic.Bool

	reconnectTimes [8]time.Time
	reconnectIdx   int
	reconnectChurn atomic.Bool

	qualityMonitor *quality.Monitor
	lastWFFrame    atomic.Value // stores *snr.WFFrameData

	lastHealth atomic.Value // stores []string for dedup
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

func (m *Manager) SetOnStateChange(fn func(streamID, state string, health []string)) {
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

	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if ok {
		data, _ := json.Marshal(output)
		as.chunkRing.WriteEvent(time.Now(), "interpreter", data)
	}
}

func (m *Manager) SetOnSuggestionSNR(fn func(streamID string) (float64, bool)) {
	m.onSuggSNRMu.Lock()
	m.onSuggSNR = fn
	m.onSuggSNRMu.Unlock()
}

func (m *Manager) SetOnIsFavorite(fn func(streamID, sourceID string) bool) {
	m.onIsFavoriteMu.Lock()
	m.onIsFavorite = fn
	m.onIsFavoriteMu.Unlock()
}

func (m *Manager) SetOnChunkComplete(fn func(streamID string, meta chunkring.ChunkMeta)) {
	m.onChunkCompleteMu.Lock()
	m.onChunkComplete = fn
	m.onChunkCompleteMu.Unlock()
}

func (m *Manager) notifyChunkComplete(streamID string, meta chunkring.ChunkMeta) {
	m.onChunkCompleteMu.RLock()
	fn := m.onChunkComplete
	m.onChunkCompleteMu.RUnlock()
	if fn != nil {
		fn(streamID, meta)
	}
}

func (m *Manager) notifyStateChange(streamID, state string, health []string) {
	m.onStateChangeMu.RLock()
	fn := m.onStateChange
	m.onStateChangeMu.RUnlock()
	if fn != nil {
		fn(streamID, state, health)
	}
}

func (m *Manager) setStreamStateInDBAndNotify(ctx context.Context, streamID string, state StreamState) {
	_ = m.db.UpdateStreamState(ctx, streamID, string(state))
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if ok {
		as.audioStale.Store(false)
		as.wfStale.Store(false)
		as.tooBusy.Store(false)
		as.reconnectChurn.Store(false)
		as.lastHealth.Store([]string(nil))
	}
	m.notifyStateChange(streamID, string(state), nil)
}

func (m *Manager) syncHealth(streamID string) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return
	}

	var health []string
	if as.audioStale.Load() {
		health = append(health, HealthFlagAudioStale)
	}
	if as.wfStale.Load() {
		health = append(health, HealthFlagWFStale)
	}
	if as.tooBusy.Load() {
		health = append(health, HealthFlagTooBusy)
	}
	if as.reconnectChurn.Load() {
		health = append(health, HealthFlagReconnectChurn)
	}

	prev, _ := as.lastHealth.Load().([]string)
	if slicesEqual(prev, health) {
		return
	}
	as.lastHealth.Store(health)

	_ = m.db.UpdateStreamHealth(context.Background(), streamID, health)
	m.notifyStateChange(streamID, string(StateActive), health)
}

func (m *Manager) healthSnapshot(as *activeStream) (uint8, uint8) {
	as.mu.RLock()
	reconnecting := as.reconnecting
	client := as.client
	as.mu.RUnlock()

	var state StreamState
	switch {
	case reconnecting:
		state = StateReconnecting
	case client != nil:
		state = StateActive
	default:
		state = StateIdle
	}

	var health []string
	if as.audioStale.Load() {
		health = append(health, HealthFlagAudioStale)
	}
	if as.wfStale.Load() {
		health = append(health, HealthFlagWFStale)
	}
	if as.tooBusy.Load() {
		health = append(health, HealthFlagTooBusy)
	}
	if as.reconnectChurn.Load() {
		health = append(health, HealthFlagReconnectChurn)
	}

	return StateInt[state], HealthToFlags(health)
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
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

const (
	churnWindow    = 5 * time.Minute
	churnThreshold = 3
)

// recordReconnect pushes a timestamp into the rolling ring buffer and
// evaluates whether the stream is experiencing reconnect churn (≥3
// short-lived connections within a 5-minute window).
func (m *Manager) recordReconnect(as *activeStream) {
	now := time.Now()
	as.mu.Lock()
	as.reconnectTimes[as.reconnectIdx%len(as.reconnectTimes)] = now
	as.reconnectIdx++
	as.mu.Unlock()

	as.mu.RLock()
	cutoff := now.Add(-churnWindow)
	count := 0
	for _, t := range as.reconnectTimes {
		if !t.IsZero() && t.After(cutoff) {
			count++
		}
	}
	lastConnected := as.lastConnectedAt
	as.mu.RUnlock()

	shortLived := !lastConnected.IsZero() && now.Sub(lastConnected) < reconnectStabilityThreshold
	if shortLived && count >= churnThreshold {
		if !as.reconnectChurn.Swap(true) {
			m.log.Warn(as.id, "health.reconnect_churn", fmt.Sprintf("detected: %d reconnects in %s window", count, churnWindow))
			m.syncHealth(as.id)
		}
	} else if as.reconnectChurn.Load() && count < churnThreshold {
		as.reconnectChurn.Store(false)
		m.syncHealth(as.id)
	}
}

func (m *Manager) SetAutoProbe(streamID string, enabled bool) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return
	}

	as.mu.Lock()
	as.autoProbe = enabled
	as.mu.Unlock()
}

func (m *Manager) SetQualityFallback(streamID string, enabled bool, stream models.Stream) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return
	}

	as.mu.Lock()
	hasMonitor := as.qualityMonitor != nil
	as.mu.Unlock()

	if enabled && !hasMonitor {
		m.startQualityMonitor(as, stream)
	} else if !enabled && hasMonitor {
		m.stopQualityMonitor(as)
	}
}

func (m *Manager) startQualityMonitor(as *activeStream, stream models.Stream) {
	bandCfg := snr.BandConfig{
		CenterKHz:    stream.FrequencyKHz,
		PassbandLoHz: stream.BandwidthLowHz,
		PassbandHiHz: stream.BandwidthHighHz,
	}

	getHealth := func() quality.HealthSnapshot {
		as.mu.RLock()
		reconnecting := as.reconnecting
		client := as.client
		as.mu.RUnlock()

		return quality.HealthSnapshot{
			AudioStale:     as.audioStale.Load(),
			WFStale:        as.wfStale.Load(),
			TooBusy:        as.tooBusy.Load(),
			ReconnectChurn: as.reconnectChurn.Load(),
			Reconnecting:   reconnecting,
			InErrorState:   client == nil && !reconnecting,
		}
	}

	getWFFrame := func() *snr.WFFrameData {
		v := as.lastWFFrame.Load()
		if v == nil {
			return nil
		}
		f, _ := v.(*snr.WFFrameData)
		return f
	}

	getSuggSNR := func() (float64, bool) {
		m.onSuggSNRMu.RLock()
		fn := m.onSuggSNR
		m.onSuggSNRMu.RUnlock()
		if fn == nil {
			return 0, false
		}
		return fn(as.id)
	}

	isFavorite := func(sourceID string) bool {
		m.onIsFavoriteMu.RLock()
		fn := m.onIsFavorite
		m.onIsFavoriteMu.RUnlock()
		if fn == nil {
			return false
		}
		return fn(as.id, sourceID)
	}

	mon := quality.NewMonitor(
		as.id,
		m.log,
		func(streamID, reason string) {
			m.onDegradedMu.RLock()
			fn := m.onDegraded
			m.onDegradedMu.RUnlock()
			if fn != nil {
				fn(streamID, reason)
			}
		},
		getHealth,
		getWFFrame,
		getSuggSNR,
		bandCfg,
		isFavorite,
	)

	as.mu.Lock()
	as.qualityMonitor = mon
	as.mu.Unlock()

	mon.Start()
	m.log.Info(as.id, "quality.enabled", "quality monitor started")
}

func (m *Manager) stopQualityMonitor(as *activeStream) {
	as.mu.Lock()
	mon := as.qualityMonitor
	as.qualityMonitor = nil
	as.mu.Unlock()

	if mon != nil {
		mon.Stop()
		m.log.Info(as.id, "quality.disabled", "quality monitor stopped")
	}
}

// GetQualityMonitor returns the active quality monitor for a stream, if any.
func (m *Manager) GetQualityMonitor(streamID string) *quality.Monitor {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return nil
	}
	as.mu.RLock()
	defer as.mu.RUnlock()
	return as.qualityMonitor
}

func (m *Manager) SetKeepAlive(streamID string, enabled bool) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return
	}

	as.mu.Lock()
	as.keepAlive = enabled
	as.mu.Unlock()
}

func (m *Manager) SetS3Client(c *s3client.Client) {
	m.s3Client = c
}

func (m *Manager) S3Available() bool {
	return m.s3Client != nil
}

func (m *Manager) S3Client() *s3client.Client {
	return m.s3Client
}

func (m *Manager) newS3Sink(streamID string) *chunkring.S3Sink {
	sink := chunkring.NewS3Sink(m.s3Client, m.db, streamID)
	sink.SetOnUpload(func(startedAt, endedAt time.Time, totalBytes int64) {
		m.log.Wire(streamID, streamlog.LevelInfo, "offload.chunk", "wavetoy", "storage",
			fmt.Sprintf("uploaded %d bytes (%s → %s)",
				totalBytes,
				startedAt.Format("15:04:05"),
				endedAt.Format("15:04:05")))
	})
	return sink
}

func (m *Manager) StartChunkOffload(ctx context.Context, streamID string) error {
	if m.s3Client == nil {
		return fmt.Errorf("S3 not configured")
	}

	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return ErrStreamNotActive
	}

	as.chunkRing.SetSink(m.newS3Sink(streamID))
	m.log.Info(streamID, "offload.start", "chunk offloading to S3 enabled")
	return nil
}

func (m *Manager) StopChunkOffload(ctx context.Context, streamID string) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return
	}

	as.chunkRing.SetSink(nil)
	m.log.Info(streamID, "offload.stop", "chunk offloading to S3 disabled")
}

func (m *Manager) EnsureRunning(ctx context.Context, stream models.Stream) error {
	m.syncStreamLogLevel(stream.ID, stream.LogLevel)

	m.mu.RLock()
	as, ok := m.streams[stream.ID]
	m.mu.RUnlock()
	if ok {
		as.mu.RLock()
		running := as.client != nil
		reconnecting := as.reconnecting
		as.mu.RUnlock()
		if running || reconnecting {
			return nil
		}
		client, wfClient, err := m.connectClient(ctx, stream)
		if err != nil {
			m.setStreamStateInDBAndNotify(ctx, stream.ID, StateError)
			return err
		}
		as.mu.Lock()
		oldWF := as.wfClient
		as.client = client
		as.wfClient = wfClient
		as.sourceID = stream.SourceID
		as.generation++
		if as.startedAt.IsZero() {
			as.startedAt = time.Now()
		}
		as.lastConnectedAt = time.Now()
		as.reconnectBackoff = 0
		as.reconnectAttempts = 0
		as.listen = newListenSession(stream.SourceID)
		gen := as.generation
		as.mu.Unlock()
		if oldWF != nil {
			_ = oldWF.Close()
		}
		client.SetOnTooBusy(func(busy bool) {
			as.tooBusy.Store(busy)
			m.syncHealth(stream.ID)
		})
		m.setStreamStateInDBAndNotify(ctx, stream.ID, StateActive)
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
		existing.filterChain.Reconfigure(stream.Filters, m.SampleRate(stream.ID))
		m.reconfigureInterpreter(existing, stream)
		existing.mu.Lock()
		existing.tuneFreqKHz = float32(stream.FrequencyKHz)
		existing.tunePassLo = int16(stream.BandwidthLowHz)
		existing.tunePassHi = int16(stream.BandwidthHighHz)
		existing.mu.Unlock()
		return nil
	}

	m.log.Wire(stream.ID, streamlog.LevelInfo, "source.switch", "wavetoy", "kiwi", fmt.Sprintf("%s → %s", currentSourceID, stream.SourceID))
	client, wfClient, err := m.connectClient(ctx, stream)
	if err != nil {
		m.setStreamStateInDBAndNotify(ctx, stream.ID, StateError)
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

	client.SetOnTooBusy(func(busy bool) {
		existing.tooBusy.Store(busy)
		m.syncHealth(stream.ID)
	})
	m.setStreamStateInDBAndNotify(ctx, stream.ID, StateActive)
	existing.chunkRing.SetSourceID(stream.SourceID)
	existing.filterChain.Reconfigure(stream.Filters, client.SampleRate())
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

	m.setStreamStateInDBAndNotify(ctx, stream.ID, StateConnecting)
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
const idleDisconnectTimeout = 10 * time.Minute
const maxReconnectBeforeFallback = 3
const reconnectStabilityThreshold = 30 * time.Second
const maxUnstableReconnects = 10

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
		m.setStreamStateInDBAndNotify(ctx, stream.ID, StateError)
		return err
	}

	bufMinutes := stream.BufferMinutes
	if bufMinutes <= 0 {
		bufMinutes = 5
	}

	m.syncStreamLogLevel(stream.ID, stream.LogLevel)

	now := time.Now()
	as := &activeStream{
		id:              stream.ID,
		sourceID:        stream.SourceID,
		client:          client,
		wfClient:        wfClient,
		generation:      1,
		subscribers:     make(map[chan []byte]struct{}),
		wfSubscribers:   make(map[chan kiwi.WFFrame]struct{}),
		startedAt:       now,
		lastConnectedAt: now,
		chunkRing:       chunkring.New(stream.ID, 1*time.Minute, bufMinutes, client.SampleRate()),
		filterChain:     filter.NewChain(stream.Filters, client.SampleRate()),
		interp:          interpreter.New(normalizeInterpConfig(stream.Interpreter), client.SampleRate(), m.interpLogFunc(stream.ID)),
		interpType:      stream.Interpreter.Type,
		autoProbe:       stream.AutoProbe,
		keepAlive:       stream.KeepAlive,
		listen:          newListenSession(stream.SourceID),
		tuneFreqKHz:     float32(stream.FrequencyKHz),
		tunePassLo:      int16(stream.BandwidthLowHz),
		tunePassHi:      int16(stream.BandwidthHighHz),
	}
	m.wireAsyncInterpreter(as)
	as.chunkRing.SetSourceID(stream.SourceID)
	as.chunkRing.SetOnRotate(func(meta chunkring.ChunkMeta) {
		m.notifyChunkComplete(stream.ID, meta)
	})
	as.chunkRing.SetHealthSnapshot(func() (uint8, uint8) {
		return m.healthSnapshot(as)
	})
	client.SetOnTooBusy(func(busy bool) {
		as.tooBusy.Store(busy)
		m.syncHealth(stream.ID)
	})
	m.log.SetOnEmit(stream.ID, func(entry streamlog.Entry) {
		data, _ := json.Marshal(entry)
		as.chunkRing.WriteEvent(entry.Time, "log", data)
	})

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

	m.setStreamStateInDBAndNotify(ctx, stream.ID, StateActive)
	m.log.Info(stream.ID, "state.change", "connecting → active")
	m.log.Info(stream.ID, "pump.start", fmt.Sprintf("gen=%d", as.generation))
	m.startPump(as, client, as.generation)
	if wfClient != nil {
		m.startWFPump(as, wfClient, as.generation)
	}

	if stream.OffloadChunks && m.s3Client != nil {
		as.chunkRing.SetSink(m.newS3Sink(stream.ID))
		m.log.Info(stream.ID, "offload.start", "chunk offloading to S3 resumed on stream start")
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
	as.idleSince = time.Time{}
	subCount := len(as.subscribers)
	as.mu.Unlock()
	m.log.Info(streamID, "subscriber.add", fmt.Sprintf("total=%d", subCount))

	unsubscribe := func() {
		as.mu.Lock()
		if _, exists := as.subscribers[ch]; exists {
			delete(as.subscribers, ch)
			close(ch)
			remaining := len(as.subscribers)
			if remaining == 0 && len(as.wfSubscribers) == 0 {
				as.idleSince = time.Now()
			}
			m.log.Info(streamID, "subscriber.remove", fmt.Sprintf("total=%d", remaining))
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
	as.idleSince = time.Time{}
	subCount := len(as.wfSubscribers)
	as.mu.Unlock()
	m.log.Info(streamID, "wf.subscriber.add", fmt.Sprintf("total=%d", subCount))

	unsubscribe := func() {
		as.mu.Lock()
		if _, exists := as.wfSubscribers[ch]; exists {
			delete(as.wfSubscribers, ch)
			close(ch)
			remaining := len(as.wfSubscribers)
			if remaining == 0 && len(as.subscribers) == 0 {
				as.idleSince = time.Now()
			}
			m.log.Info(streamID, "wf.subscriber.remove", fmt.Sprintf("total=%d", remaining))
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

	m.stopQualityMonitor(as)

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
	if as.chunkRing != nil {
		as.chunkRing.Close()
	}
	m.log.Remove(streamID)
	return nil
}

func (m *Manager) startPump(as *activeStream, client *kiwi.Client, generation uint64) {
	go func() {
		m.log.Info(as.id, "pump.start", fmt.Sprintf("gen=%d", generation))
		metricsTicker := time.NewTicker(10 * time.Second)
		defer metricsTicker.Stop()

		const staleThreshold = 10 * time.Second
		staleTicker := time.NewTicker(staleThreshold)
		defer staleTicker.Stop()
		audioStale := false
		lastFrameAt := time.Now()

		defer func() {
			if audioStale {
				as.audioStale.Store(false)
				m.syncHealth(as.id)
			}

			as.mu.Lock()
			stillCurrent := as.client == client && as.generation == generation
			wasIdleDisconnect := as.idleDisconnected
			if stillCurrent {
				as.client = nil
				as.idleDisconnected = false
			}
			as.mu.Unlock()

			if stillCurrent {
				if wasIdleDisconnect {
					m.log.Info(as.id, "pump.stop", fmt.Sprintf("gen=%d reason=idle", generation))
					m.setStreamStateInDBAndNotify(context.Background(), as.id, StateIdle)
				} else {
					m.log.Info(as.id, "pump.stop", fmt.Sprintf("gen=%d reason=disconnected", generation))
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
		case <-staleTicker.C:
			gap := time.Since(lastFrameAt)
			if gap >= staleThreshold {
				if !audioStale {
					audioStale = true
					as.audioStale.Store(true)
					m.syncHealth(as.id)
				}
				m.log.Warn(as.id, "pump.audio.stale", fmt.Sprintf("no frames for %.0fs", gap.Seconds()))
			}
			case <-metricsTicker.C:
				m.logAudioMetrics(as, client, generation)

				as.mu.RLock()
				shouldIdleDisconnect := !as.keepAlive &&
					as.qualityMonitor == nil &&
					!as.idleSince.IsZero() &&
					time.Since(as.idleSince) >= idleDisconnectTimeout &&
					len(as.subscribers) == 0 && len(as.wfSubscribers) == 0
				as.mu.RUnlock()

				if shouldIdleDisconnect {
					as.mu.Lock()
					as.idleDisconnected = true
					as.mu.Unlock()
					m.log.Info(as.id, "idle.disconnect", fmt.Sprintf("no subscribers for %s", idleDisconnectTimeout))
					_ = client.Close()
					return
				}
		case frame, ok := <-client.Samples():
			if !ok {
				m.log.Wire(as.id, streamlog.LevelWarn, "disconnect", "wavetoy", "kiwi", "sample channel closed")
				return
			}
			frameStart := time.Now()
			lastFrameAt = frameStart
			if audioStale {
				audioStale = false
				as.audioStale.Store(false)
				m.log.Info(as.id, "pump.audio.resumed", "receiving frames again")
				m.syncHealth(as.id)
			}

			as.framesFromKiwi.Add(1)
			as.bytesFromKiwi.Add(int64(len(frame)))

			t0 := time.Now()
			filtered := as.filterChain.Process(frame)
			filterElapsed := time.Since(t0)

			tc := time.Now()
			as.chunkRing.WriteAudio(time.Now(), filtered)
			chunkElapsed := time.Since(tc)

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
			as.perfChunkUs += chunkElapsed.Microseconds()
			as.perfMu.Unlock()

			if totalElapsed >= 50*time.Millisecond {
				m.log.Warn(as.id, "pump.slow_frame", fmt.Sprintf(
					"total=%dµs filter=%dµs chunk=%dµs broadcast=%dµs interp=%dµs",
					totalElapsed.Microseconds(), filterElapsed.Microseconds(),
					chunkElapsed.Microseconds(), broadcastElapsed.Microseconds(),
					interpElapsed.Microseconds(),
				))
			}

			if ls := as.listen; ls != nil && !ls.gotSound.Load() {
				ls.gotSound.Store(true)
				m.tryCommitListen(as)
			}

			}
		}
	}()
}

func (m *Manager) startWFPump(as *activeStream, wfClient *kiwi.WFClient, generation uint64) {
	go func() {
		m.log.Info(as.id, "wf.pump.start", fmt.Sprintf("gen=%d", generation))

		const staleThreshold = 10 * time.Second
		staleTicker := time.NewTicker(staleThreshold)
		defer staleTicker.Stop()
		wfStale := false
		lastFrameAt := time.Now()

		defer func() {
			if wfStale {
				as.wfStale.Store(false)
				m.syncHealth(as.id)
			}
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
		zoomSettled := false
		droppedStaleFrames := 0

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
	case <-staleTicker.C:
		gap := time.Since(lastFrameAt)
		if gap >= staleThreshold {
			if !wfStale {
				wfStale = true
				as.wfStale.Store(true)
				m.syncHealth(as.id)
			}
			m.log.Warn(as.id, "pump.wf.stale", fmt.Sprintf("no frames for %.0fs", gap.Seconds()))
		}
	case frame, ok := <-wfClient.Frames():
			if !ok {
				return
			}

			if !zoomSettled {
				expectedZoom := wfClient.ConfiguredZoom()
				if int(frame.Zoom) != expectedZoom {
					droppedStaleFrames++
					continue
				}
				zoomSettled = true
				if droppedStaleFrames > 0 {
					m.log.Info(as.id, "wf.zoom_settled", fmt.Sprintf("dropped %d stale frames before zoom=%d matched", droppedStaleFrames, expectedZoom))
				}
			}

			wfFrameStart := time.Now()
			lastFrameAt = wfFrameStart
			if wfStale {
				wfStale = false
				as.wfStale.Store(false)
				m.log.Info(as.id, "pump.wf.resumed", "receiving frames again")
				m.syncHealth(as.id)
			}
			if !gotFirstFrame {
				gotFirstFrame = true
				timer.Stop()
			}
			wfBandwidthKHz := 30000.0
			if wfClient.MaxFreqKHz() > 0 {
				wfBandwidthKHz = float64(wfClient.MaxFreqKHz())
			}
			as.lastWFFrame.Store(&snr.WFFrameData{
				Bins:         append([]byte(nil), frame.Bins...),
				XBin:         frame.XBin,
				Zoom:         frame.Zoom,
				BandwidthKHz: wfBandwidthKHz,
			})

			tb := time.Now()
			as.broadcastWF(frame)
			wfBroadcastElapsed := time.Since(tb)

			as.mu.RLock()
			fk, pl, ph := as.tuneFreqKHz, as.tunePassLo, as.tunePassHi
			as.mu.RUnlock()
			tc := time.Now()
			as.chunkRing.WriteWF(time.Now(), frame.Bins, frame.XBin, frame.Zoom, fk, pl, ph)
			wfChunkElapsed := time.Since(tc)

			wfTotalElapsed := time.Since(wfFrameStart)
			as.wfPerfMu.Lock()
			as.wfPerfFrames++
			wfUs := wfTotalElapsed.Microseconds()
			as.wfPerfTotalUs += wfUs
			if wfUs > as.wfPerfMaxUs {
				as.wfPerfMaxUs = wfUs
			}
			as.wfPerfBroadcastUs += wfBroadcastElapsed.Microseconds()
			as.wfPerfChunkUs += wfChunkElapsed.Microseconds()
			as.wfPerfMu.Unlock()

			if wfTotalElapsed >= 50*time.Millisecond {
				m.log.Warn(as.id, "pump.wf.slow_frame", fmt.Sprintf(
					"total=%dµs broadcast=%dµs chunk=%dµs",
					wfTotalElapsed.Microseconds(), wfBroadcastElapsed.Microseconds(),
					wfChunkElapsed.Microseconds(),
				))
			}

			if ls := as.listen; ls != nil && !ls.gotWF.Load() {
				ls.gotWF.Store(true)
				m.tryCommitListen(as)
			}
			}
		}
	}()
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
	chunkUs := as.perfChunkUs
	as.perfFrames = 0
	as.perfTotalUs = 0
	as.perfMaxUs = 0
	as.perfFilterUs = 0
	as.perfInterpUs = 0
	as.perfBroadcastUs = 0
	as.perfChunkUs = 0
	as.perfMu.Unlock()

	if frames > 0 {
		avgUs := totalUs / frames
		avgFilterUs := filterUs / frames
		avgInterpUs := interpUs / frames
		avgBcastUs := broadcastUs / frames
		avgChunkUs := chunkUs / frames

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
			"frames=%d avg=%dµs max=%dµs filter=%dµs interp=%dµs broadcast=%dµs chunk=%dµs max_budget=%.1f%%",
			frames, avgUs, maxUs, avgFilterUs, avgInterpUs, avgBcastUs, avgChunkUs, maxPct,
		))
	}

	as.wfPerfMu.Lock()
	wfFrames := as.wfPerfFrames
	wfTotalUs := as.wfPerfTotalUs
	wfMaxUs := as.wfPerfMaxUs
	wfBcastUs := as.wfPerfBroadcastUs
	wfChunkUs := as.wfPerfChunkUs
	as.wfPerfFrames = 0
	as.wfPerfTotalUs = 0
	as.wfPerfMaxUs = 0
	as.wfPerfBroadcastUs = 0
	as.wfPerfChunkUs = 0
	as.wfPerfMu.Unlock()

	if wfFrames > 0 {
		wfAvgUs := wfTotalUs / wfFrames
		wfAvgBcastUs := wfBcastUs / wfFrames
		wfAvgChunkUs := wfChunkUs / wfFrames

		level := streamlog.LevelDebug
		if wfMaxUs >= 50_000 {
			level = streamlog.LevelWarn
		}

		m.log.Log(as.id, level, "pump.wf.perf", fmt.Sprintf(
			"frames=%d avg=%dµs max=%dµs broadcast=%dµs chunk=%dµs",
			wfFrames, wfAvgUs, wfMaxUs, wfAvgBcastUs, wfAvgChunkUs,
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

	wasStable := !as.lastConnectedAt.IsZero() && time.Since(as.lastConnectedAt) >= reconnectStabilityThreshold
	if wasStable {
		as.reconnectBackoff = time.Second
		as.reconnectAttempts = 0
	}
	backoff := as.reconnectBackoff
	if backoff < time.Second {
		backoff = time.Second
	}
	attempt := as.reconnectAttempts
	as.mu.Unlock()

	m.recordReconnect(as)
	m.log.Wire(as.id, streamlog.LevelInfo, "reconnect.start", "wavetoy", "kiwi", "initiating reconnection")
	m.setStreamStateInDBAndNotify(context.Background(), as.id, StateReconnecting)

	go func() {
		defer func() {
			as.mu.Lock()
			as.reconnecting = false
			as.mu.Unlock()
		}()
		for {
			select {
			case <-m.runtimeCtx.Done():
				m.log.Info(as.id, "reconnect.abandon", "runtime shutdown")
				return
			default:
			}

			as.mu.RLock()
			alreadyRunning := as.client != nil
			idle := !as.keepAlive && !as.idleSince.IsZero() && time.Since(as.idleSince) >= idleDisconnectTimeout
			as.mu.RUnlock()
			if alreadyRunning {
				m.log.Info(as.id, "reconnect.abandon", fmt.Sprintf("running=%v", alreadyRunning))
				return
			}
			if idle {
				m.log.Info(as.id, "reconnect.abandon", "idle timeout expired")
				return
			}

			if attempt >= maxUnstableReconnects {
				m.log.Wire(as.id, streamlog.LevelError, "reconnect.abandon", "wavetoy", "kiwi",
					fmt.Sprintf("giving up after %d unstable reconnects", attempt))
				m.setStreamStateInDBAndNotify(context.Background(), as.id, StateError)
				return
			}

			attempt++
			m.log.Info(as.id, "reconnect.start", fmt.Sprintf("attempt=%d backoff=%s", attempt, backoff))

			if attempt > 1 {
				time.Sleep(backoff)
				backoff = minDuration(backoff*2, 30*time.Second)
			}

			stream, err := m.db.GetStreamByID(context.Background(), as.id)
			if err != nil || stream == nil {
				m.log.Warn(as.id, "reconnect.start", fmt.Sprintf("db lookup failed: %v", err))
				continue
			}

			// Auto-fallback: after enough unstable reconnects, try a probe suggestion
			fallbackSource := ""
			if attempt >= maxReconnectBeforeFallback {
				as.mu.RLock()
				currentSource := as.sourceID
				hasAutoProbe := as.autoProbe
				as.mu.RUnlock()

				if hasAutoProbe {
					suggestions, sugErr := m.db.ListProbeSuggestions(context.Background(), as.id)
					if sugErr == nil && len(suggestions) > 0 && suggestions[0].SourceID != currentSource {
						fallbackSource = suggestions[0].SourceID
						stream.SourceID = fallbackSource
						m.log.Wire(as.id, streamlog.LevelWarn, "reconnect.fallback", "wavetoy", "kiwi",
							fmt.Sprintf("trying probe suggestion %s:%d (score=%.3f) after %d unstable reconnects",
								suggestions[0].SourceHost, suggestions[0].SourcePort, suggestions[0].ScoreEMA, attempt))
					}
				}
			}

			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			client, wfClient, err := m.connectClient(ctx, *stream)
			cancel()
			if err != nil {
				m.log.Warn(as.id, "reconnect.start", fmt.Sprintf("attempt=%d failed: %v", attempt, err))
				continue
			}

			as.mu.Lock()
			idleExpired := !as.keepAlive && !as.idleSince.IsZero() && time.Since(as.idleSince) >= idleDisconnectTimeout
			alreadyRunning = as.client != nil
			if alreadyRunning || idleExpired {
				as.mu.Unlock()
				m.log.Debug(as.id, "reconnect.race", "state changed during connect, discarding")
				_ = client.Close()
				if wfClient != nil {
					_ = wfClient.Close()
				}
				if alreadyRunning {
					m.setStreamStateInDBAndNotify(context.Background(), as.id, StateActive)
				}
				return
			}
			oldWF := as.wfClient
			as.client = client
			as.wfClient = wfClient
			as.sourceID = stream.SourceID
			as.generation++
			if as.startedAt.IsZero() {
				as.startedAt = time.Now()
			}
			as.listen = newListenSession(stream.SourceID)
			as.lastConnectedAt = time.Now()
			as.reconnectBackoff = backoff
			as.reconnectAttempts = attempt
			gen := as.generation
			as.mu.Unlock()
			if oldWF != nil {
				_ = oldWF.Close()
			}

			client.SetOnTooBusy(func(busy bool) {
				as.tooBusy.Store(busy)
				m.syncHealth(as.id)
			})
			if fallbackSource != "" {
				as.chunkRing.SetSourceID(fallbackSource)
				if dbErr := m.db.SwitchStreamSource(context.Background(), as.id, fallbackSource); dbErr != nil {
					m.log.Warn(as.id, "reconnect.fallback", fmt.Sprintf("db update failed: %v", dbErr))
				}
				m.log.Wire(as.id, streamlog.LevelInfo, "reconnect.fallback.ok", "wavetoy", "kiwi",
					fmt.Sprintf("switched source to %s gen=%d", fallbackSource, gen))
				as.reconnectChurn.Store(false)
				m.syncHealth(as.id)
			}

			m.log.Wire(as.id, streamlog.LevelInfo, "reconnect.ok", "wavetoy", "kiwi", fmt.Sprintf("after %d attempts gen=%d", attempt, gen))
			m.setStreamStateInDBAndNotify(context.Background(), as.id, StateActive)
			m.log.Info(as.id, "state.change", "reconnecting → active")
			m.startPump(as, client, gen)
			if wfClient != nil {
				m.startWFPump(as, wfClient, gen)
			}
			return
		}
	}()
}

// CaptureAudioPCM returns the concatenated PCM audio from the ChunkRing.
func (m *Manager) CaptureAudioPCM(streamID string) (pcm []byte, sampleRate int, err error) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return nil, 0, ErrStreamNotActive
	}
	pcm, sampleRate = as.chunkRing.SnapshotAudio()
	m.log.Info(streamID, "capture", fmt.Sprintf("bytes=%d sample_rate=%d", len(pcm), sampleRate))
	return pcm, sampleRate, nil
}

// ChunkRing returns the ChunkRing for a stream, or nil if not active.
func (m *Manager) ChunkRing(streamID string) *chunkring.ChunkRing {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return nil
	}
	return as.chunkRing
}

func (m *Manager) CollectSnapshot(ctx context.Context, streamID string, duration time.Duration, stream models.Stream) (probe.SnapshotResult, error) {
	audioCh, audioUnsub, err := m.Subscribe(streamID)
	if err != nil {
		return probe.SnapshotResult{Snapshot: probe.AudioSnapshot{SilenceRatio: 1}}, err
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

	bandwidthKHz := 30000.0
	m.mu.RLock()
	if as, ok := m.streams[streamID]; ok && as.wfClient != nil {
		if bw := as.wfClient.MaxFreqKHz(); bw > 0 {
			bandwidthKHz = float64(bw)
		}
	}
	m.mu.RUnlock()

	deadline := time.After(duration)
	var audioFrames [][]byte
	var wfFrames []kiwi.WFFrame

	finalize := func() probe.SnapshotResult {
		snap := probe.CaptureReferenceSnapshot(audioFrames, wfFrames, duration, stream, bandwidthKHz)
		raw := probe.TruncateAudio(audioFrames, sampleRate, probe.ProbeStoredAudio)
		return probe.SnapshotResult{Snapshot: snap, RawPCM: raw, SampleRate: sampleRate}
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

	interpCfg := normalizeInterpConfig(stream.Interpreter)
	if interpCfg.Enabled {
		if as.interp != nil && interpCfg.Type == as.interpType {
			as.interp.Reconfigure(interpCfg)
		} else {
			if as.interp != nil {
				as.interp.Reset()
			}
			as.interp = interpreter.New(interpCfg, sampleRate, m.interpLogFunc(stream.ID))
			as.interpType = stream.Interpreter.Type
			m.wireAsyncInterpreter(as)
		}
	} else {
		if as.interp != nil {
			as.interp.Reset()
			as.interp = nil
			as.interpType = ""
		}
	}
}

func normalizeInterpConfig(cfg interpreter.Config) interpreter.Config {
	cfg.ModelSize = "small"
	cfg.SourceLang = ""
	return cfg
}

func (m *Manager) interpLogFunc(streamID string) interpreter.LogFunc {
	return func(level, action, msg string) {
		var lvl streamlog.LogLevel
		switch level {
		case "error":
			lvl = streamlog.LevelError
		case "warn":
			lvl = streamlog.LevelWarn
		case "debug":
			lvl = streamlog.LevelDebug
		default:
			lvl = streamlog.LevelInfo
		}
		m.log.Log(streamID, lvl, action, msg)
	}
}

func (m *Manager) wireAsyncInterpreter(as *activeStream) {
	if async, ok := as.interp.(interpreter.AsyncInterpreter); ok {
		streamID := as.id
		async.SetOutputCallback(func(o interpreter.Output) {
			m.notifyInterpreterOutput(streamID, o)
		})
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
