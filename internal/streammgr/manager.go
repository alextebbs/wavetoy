package streammgr

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/filter"
	"github.com/sammy/sdr-radio/internal/kiwi"
	"github.com/sammy/sdr-radio/internal/models"
	"github.com/sammy/sdr-radio/internal/ringbuf"
)

var ErrStreamNotActive = errors.New("stream is not active")

type Manager struct {
	db         *db.DB
	runtimeCtx context.Context

	mu      sync.RWMutex
	streams map[string]*activeStream
}

type activeStream struct {
	id       string
	sourceID string

	mu           sync.RWMutex
	client       *kiwi.Client
	wfClient     *kiwi.WFClient
	generation   uint64
	reconnecting bool

	subscribers    map[chan []byte]struct{}
	wfSubscribers  map[chan kiwi.WFFrame]struct{}
	logSubscribers map[chan string]struct{}
	startedAt      time.Time
	ringBuf       *ringbuf.RingBuffer
	filterChain   *filter.Chain

	framesFromKiwi     atomic.Int64
	bytesFromKiwi      atomic.Int64
	fanoutDelivered    atomic.Int64
	fanoutDroppedFinal atomic.Int64
}

func New(database *db.DB) *Manager {
	return &Manager{
		db:         database,
		runtimeCtx: context.Background(),
		streams:    make(map[string]*activeStream),
	}
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
		gen := as.generation
		as.mu.Unlock()
		_ = m.db.UpdateStreamState(ctx, stream.ID, "active")
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
		log.Printf("[STREAM] reconfigure stream=%s not tracked, starting fresh", stream.ID)
		return m.startStream(ctx, stream)
	}

	existing.mu.RLock()
	currentClient := existing.client
	currentSourceID := existing.sourceID
	existing.mu.RUnlock()

	if currentClient != nil && currentSourceID == stream.SourceID {
		log.Printf("[STREAM] retuning in-place stream=%s freq=%.3fkHz mode=%s", stream.ID, stream.FrequencyKHz, stream.Mode)
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
		return nil
	}

	log.Printf("[STREAM] reconfigure stream=%s source changed %s->%s, reconnecting", stream.ID, currentSourceID, stream.SourceID)
	client, wfClient, err := m.connectClient(ctx, stream)
	if err != nil {
		_ = m.db.UpdateStreamState(ctx, stream.ID, "stopped")
		return err
	}

	existing.mu.Lock()
	oldClient := existing.client
	oldWFClient := existing.wfClient
	existing.client = client
	existing.wfClient = wfClient
	existing.sourceID = stream.SourceID
	existing.generation++
	gen := existing.generation
	existing.mu.Unlock()

	_ = m.db.UpdateStreamState(ctx, stream.ID, "active")
	existing.filterChain.Reconfigure(filter.BuildFilters(stream.Filters, client.SampleRate()))
	m.startPump(existing, client, gen)
	if wfClient != nil {
		m.startWFPump(existing, wfClient, gen)
	}
	if oldClient != nil {
		log.Printf("[STREAM] closing old kiwi connection stream=%s (source switch)", stream.ID)
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

	log.Printf("[STREAM] connecting stream=%s source=%s (%s:%d tls=%v) freq=%.3fkHz mode=%s",
		stream.ID, stream.SourceID, source.Host, source.Port, source.UseTLS, stream.FrequencyKHz, stream.Mode)

	_ = m.db.UpdateStreamState(ctx, stream.ID, "connecting")
	ts := kiwi.ConnectTimestamp()
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
	}, ts)
	if err != nil {
		log.Printf("[STREAM] connect failed stream=%s source=%s: %v", stream.ID, stream.SourceID, err)
		return nil, nil, err
	}
	log.Printf("[STREAM] connected SND stream=%s source=%s", stream.ID, stream.SourceID)

	wfClient, err := kiwi.ConnectWF(ctx, kiwi.WFConfig{
		Host:      source.Host,
		Port:      source.Port,
		UseTLS:    source.UseTLS,
		Name:      stream.Name,
		Zoom:      0,
		CenterKHz: 15000.0,
		Speed:     4,
		Compress:  false,
	}, ts)
	if err != nil {
		log.Printf("[STREAM] W/F connect failed stream=%s source=%s: %v (continuing without waterfall)", stream.ID, stream.SourceID, err)
		return client, nil, nil
	}
	log.Printf("[STREAM] connected W/F stream=%s source=%s (shared ts=%d)", stream.ID, stream.SourceID, ts)

	return client, wfClient, nil
}

func (m *Manager) startStream(ctx context.Context, stream models.Stream) error {
	log.Printf("[STREAM] starting new stream=%s source=%s", stream.ID, stream.SourceID)
	client, wfClient, err := m.connectClient(ctx, stream)
	if err != nil {
		_ = m.db.UpdateStreamState(ctx, stream.ID, "stopped")
		return err
	}

	bufMinutes := stream.BufferMinutes
	if bufMinutes <= 0 {
		bufMinutes = 5
	}
	bufDuration := time.Duration(bufMinutes) * time.Minute
	// ~24 frames/sec * 60 sec * minutes, with headroom
	bufCapacity := 24 * 60 * bufMinutes * 2

	as := &activeStream{
		id:            stream.ID,
		sourceID:      stream.SourceID,
		client:        client,
		wfClient:      wfClient,
		generation:    1,
		subscribers:    make(map[chan []byte]struct{}),
		wfSubscribers:  make(map[chan kiwi.WFFrame]struct{}),
		logSubscribers: make(map[chan string]struct{}),
		startedAt:     time.Now(),
		ringBuf:       ringbuf.New(bufDuration, bufCapacity),
		filterChain:   filter.NewChain(stream.Filters, client.SampleRate()),
	}

	m.mu.Lock()
	if existing, exists := m.streams[stream.ID]; exists {
		m.mu.Unlock()
		log.Printf("[STREAM] stream=%s already tracked, discarding new connection", stream.ID)
		_ = client.Close()
		if wfClient != nil {
			_ = wfClient.Close()
		}
		if existing == nil {
			return nil
		}
		return nil
	}
	m.streams[stream.ID] = as
	m.mu.Unlock()

	_ = m.db.UpdateStreamState(ctx, stream.ID, "active")
	log.Printf("[STREAM] stream=%s active, starting audio pump gen=%d", stream.ID, as.generation)
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
	log.Printf("[STREAM] subscriber added stream=%s subscribers=%d", streamID, subCount)

	unsubscribe := func() {
		as.mu.Lock()
		if _, exists := as.subscribers[ch]; exists {
			delete(as.subscribers, ch)
			close(ch)
			log.Printf("[STREAM] subscriber removed stream=%s subscribers=%d", streamID, len(as.subscribers))
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
	log.Printf("[STREAM] reconfigure waterfall stream=%s zoom=%d center=%.1fkHz speed=%d", streamID, zoom, centerKHz, speed)
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
	log.Printf("[STREAM] wf subscriber added stream=%s wf_subscribers=%d", streamID, subCount)

	unsubscribe := func() {
		as.mu.Lock()
		if _, exists := as.wfSubscribers[ch]; exists {
			delete(as.wfSubscribers, ch)
			close(ch)
			log.Printf("[STREAM] wf subscriber removed stream=%s wf_subscribers=%d", streamID, len(as.wfSubscribers))
		}
		as.mu.Unlock()
	}

	return ch, unsubscribe, nil
}

func (m *Manager) SubscribeLogs(streamID string) (<-chan string, func(), error) {
	m.mu.RLock()
	as, ok := m.streams[streamID]
	m.mu.RUnlock()
	if !ok {
		return nil, nil, ErrStreamNotActive
	}

	ch := make(chan string, 16)
	as.mu.Lock()
	if as.logSubscribers == nil {
		as.logSubscribers = make(map[chan string]struct{})
	}
	as.logSubscribers[ch] = struct{}{}
	as.mu.Unlock()

	unsubscribe := func() {
		as.mu.Lock()
		if _, exists := as.logSubscribers[ch]; exists {
			delete(as.logSubscribers, ch)
			close(ch)
		}
		as.mu.Unlock()
	}

	return ch, unsubscribe, nil
}

func (as *activeStream) broadcastLog(msg string) {
	as.mu.RLock()
	defer as.mu.RUnlock()
	for ch := range as.logSubscribers {
		select {
		case ch <- msg:
		default:
		}
	}
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
	for ch := range as.logSubscribers {
		delete(as.logSubscribers, ch)
		close(ch)
	}
	as.mu.Unlock()

	log.Printf("[STREAM] removed stream=%s disconnecting_subscribers=%d wf_subscribers=%d", streamID, subCount, wfSubCount)
	if client != nil {
		_ = client.Close()
	}
	if wfClient != nil {
		_ = wfClient.Close()
	}
	return nil
}

func (m *Manager) startPump(as *activeStream, client *kiwi.Client, generation uint64) {
	go func() {
		log.Printf("[STREAM] pump started stream=%s gen=%d", as.id, generation)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()

		defer func() {
			as.mu.Lock()
			stillCurrent := as.client == client && as.generation == generation
			hasSubscribers := len(as.subscribers) > 0
			if stillCurrent {
				as.client = nil
			}
			as.mu.Unlock()

			if stillCurrent {
				log.Printf("[STREAM] pump exited stream=%s gen=%d subscribers=%d (will_reconnect=%v)",
					as.id, generation, boolToInt(hasSubscribers), hasSubscribers)
				_ = m.db.UpdateStreamState(context.Background(), as.id, "stopped")
				if hasSubscribers {
					m.ensureReconnect(as)
				}
			} else {
				log.Printf("[STREAM] pump exited stream=%s gen=%d (superseded by newer generation)", as.id, generation)
			}
		}()

		for {
			select {
			case <-m.runtimeCtx.Done():
				log.Printf("[STREAM] pump stopping stream=%s gen=%d (runtime context cancelled)", as.id, generation)
				return
			case <-client.Done():
				log.Printf("[STREAM] pump stopping stream=%s gen=%d (kiwi connection closed)", as.id, generation)
				return
			case <-ticker.C:
				m.logAudioMetrics(as, client, generation)
		case frame, ok := <-client.Samples():
			if !ok {
				log.Printf("[STREAM] pump stopping stream=%s gen=%d (sample channel closed)", as.id, generation)
				return
			}
			as.framesFromKiwi.Add(1)
			as.bytesFromKiwi.Add(int64(len(frame)))
			filtered := as.filterChain.Process(frame)
			if as.ringBuf != nil {
				as.ringBuf.Write(time.Now(), filtered)
			}
			as.broadcast(filtered)
			}
		}
	}()
}

func (m *Manager) startWFPump(as *activeStream, wfClient *kiwi.WFClient, generation uint64) {
	go func() {
		log.Printf("[STREAM] wf pump started stream=%s gen=%d", as.id, generation)
		defer func() {
			as.mu.Lock()
			if as.wfClient == wfClient {
				as.wfClient = nil
			}
			as.mu.Unlock()
			log.Printf("[STREAM] wf pump exited stream=%s gen=%d", as.id, generation)
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
					as.broadcastLog("waterfall connection closed before receiving data")
				}
				return
			case <-timer.C:
				if !gotFirstFrame {
					log.Printf("[STREAM] wf timeout stream=%s: no waterfall data received in %s", as.id, wfTimeout)
					as.broadcastLog("source is not sending waterfall data")
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

	log.Printf(
		"[AUDIO_PIPELINE] stream=%s gen=%d uptime_s=%d subscribers=%d kiwi_frames=%d kiwi_bytes=%d kiwi_compressed=%d kiwi_uncompressed=%d kiwi_queue_drops=%d frames_from_kiwi=%d bytes_from_kiwi=%d fanout_delivered=%d fanout_drop_final=%d",
		as.id,
		generation,
		uptimeSec,
		subscriberCount,
		kstats.SNDFramesIn,
		kstats.SNDBytesIn,
		kstats.SNDCompressedIn,
		kstats.SNDUncompressedIn,
		kstats.SNDQueueDropFrames,
		as.framesFromKiwi.Load(),
		as.bytesFromKiwi.Load(),
		as.fanoutDelivered.Load(),
		as.fanoutDroppedFinal.Load(),
	)
}

func (m *Manager) ensureReconnect(as *activeStream) {
	as.mu.Lock()
	if as.reconnecting {
		as.mu.Unlock()
		return
	}
	as.reconnecting = true
	as.mu.Unlock()

	log.Printf("[STREAM] reconnect starting stream=%s", as.id)

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
				log.Printf("[STREAM] reconnect aborted stream=%s (runtime context cancelled)", as.id)
				return
			default:
			}

			as.mu.RLock()
			hasSubscribers := len(as.subscribers) > 0
			alreadyRunning := as.client != nil
			as.mu.RUnlock()
			if !hasSubscribers || alreadyRunning {
				log.Printf("[STREAM] reconnect abandoned stream=%s (subscribers=%v running=%v)", as.id, hasSubscribers, alreadyRunning)
				return
			}

			attempt++
			log.Printf("[STREAM] reconnect attempt=%d stream=%s backoff=%s", attempt, as.id, backoff)

			stream, err := m.db.GetStreamByID(context.Background(), as.id)
			if err != nil || stream == nil {
				log.Printf("[STREAM] reconnect stream=%s db lookup failed: %v", as.id, err)
				time.Sleep(backoff)
				backoff = minDuration(backoff*2, 15*time.Second)
				continue
			}

			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			client, wfClient, err := m.connectClient(ctx, *stream)
			cancel()
			if err != nil {
				log.Printf("[STREAM] reconnect failed stream=%s attempt=%d: %v", as.id, attempt, err)
				time.Sleep(backoff)
				backoff = minDuration(backoff*2, 15*time.Second)
				continue
			}

			as.mu.Lock()
			if as.client != nil || len(as.subscribers) == 0 {
				as.mu.Unlock()
				log.Printf("[STREAM] reconnect discarded stream=%s (state changed during connect)", as.id)
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
			gen := as.generation
			as.mu.Unlock()

			log.Printf("[STREAM] reconnected stream=%s gen=%d after %d attempts", as.id, gen, attempt)
			_ = m.db.UpdateStreamState(context.Background(), as.id, "active")
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
	log.Printf("[STREAM] captured audio stream=%s entries=%d duration=%s sample_rate=%d",
		streamID, len(snap.Audio), snap.EndTime.Sub(snap.StartTime), sampleRate)
	return snap, nil
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
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
			// Drop oldest, enqueue newest for slow consumers
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
