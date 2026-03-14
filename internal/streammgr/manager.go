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
	"github.com/sammy/sdr-radio/internal/kiwi"
	"github.com/sammy/sdr-radio/internal/models"
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
	generation   uint64
	reconnecting bool

	subscribers map[chan []byte]struct{}
	startedAt   time.Time

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
		client, err := m.connectClient(ctx, stream)
		if err != nil {
			_ = m.db.UpdateStreamState(ctx, stream.ID, "stopped")
			return err
		}
		as.mu.Lock()
		as.client = client
		as.sourceID = stream.SourceID
		as.generation++
		if as.startedAt.IsZero() {
			as.startedAt = time.Now()
		}
		gen := as.generation
		as.mu.Unlock()
		_ = m.db.UpdateStreamState(ctx, stream.ID, "active")
		m.startPump(as, client, gen)
		return nil
	}

	return m.startStream(ctx, stream)
}

func (m *Manager) Reconfigure(ctx context.Context, stream models.Stream) error {
	m.mu.RLock()
	existing, exists := m.streams[stream.ID]
	m.mu.RUnlock()
	if !exists {
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
		return nil
	}

	client, err := m.connectClient(ctx, stream)
	if err != nil {
		_ = m.db.UpdateStreamState(ctx, stream.ID, "stopped")
		return err
	}

	existing.mu.Lock()
	oldClient := existing.client
	existing.client = client
	existing.sourceID = stream.SourceID
	existing.generation++
	gen := existing.generation
	existing.mu.Unlock()

	_ = m.db.UpdateStreamState(ctx, stream.ID, "active")
	m.startPump(existing, client, gen)
	if oldClient != nil {
		_ = oldClient.Close()
	}
	return nil
}

func (m *Manager) connectClient(ctx context.Context, stream models.Stream) (*kiwi.Client, error) {
	source, err := m.db.GetSourceByID(ctx, stream.SourceID)
	if err != nil {
		return nil, err
	}
	if source == nil {
		return nil, fmt.Errorf("source %s not found", stream.SourceID)
	}

	_ = m.db.UpdateStreamState(ctx, stream.ID, "connecting")
	return kiwi.Connect(ctx, kiwi.Config{
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
	})
}

func (m *Manager) startStream(ctx context.Context, stream models.Stream) error {
	client, err := m.connectClient(ctx, stream)
	if err != nil {
		_ = m.db.UpdateStreamState(ctx, stream.ID, "stopped")
		return err
	}

	as := &activeStream{
		id:          stream.ID,
		sourceID:    stream.SourceID,
		client:      client,
		generation:  1,
		subscribers: make(map[chan []byte]struct{}),
		startedAt:   time.Now(),
	}

	m.mu.Lock()
	if existing, exists := m.streams[stream.ID]; exists {
		m.mu.Unlock()
		_ = client.Close()
		if existing == nil {
			return nil
		}
		return nil
	}
	m.streams[stream.ID] = as
	m.mu.Unlock()

	_ = m.db.UpdateStreamState(ctx, stream.ID, "active")
	m.startPump(as, client, as.generation)
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
	as.mu.Unlock()

	unsubscribe := func() {
		as.mu.Lock()
		if _, exists := as.subscribers[ch]; exists {
			delete(as.subscribers, ch)
			close(ch)
		}
		as.mu.Unlock()
	}

	return ch, unsubscribe, nil
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
	as.client = nil
	as.generation++
	as.reconnecting = false
	for ch := range as.subscribers {
		delete(as.subscribers, ch)
		close(ch)
	}
	as.mu.Unlock()

	if client != nil {
		_ = client.Close()
	}
	return nil
}

func (m *Manager) startPump(as *activeStream, client *kiwi.Client, generation uint64) {
	go func() {
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
				_ = m.db.UpdateStreamState(context.Background(), as.id, "stopped")
				if hasSubscribers {
					m.ensureReconnect(as)
				}
			}
		}()

		for {
			select {
			case <-m.runtimeCtx.Done():
				return
			case <-client.Done():
				return
			case <-ticker.C:
				m.logAudioMetrics(as, client, generation)
			case frame, ok := <-client.Samples():
				if !ok {
					return
				}
				as.framesFromKiwi.Add(1)
				as.bytesFromKiwi.Add(int64(len(frame)))
				as.broadcast(frame)
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

	go func() {
		defer func() {
			as.mu.Lock()
			as.reconnecting = false
			as.mu.Unlock()
		}()

		backoff := time.Second
		for {
			select {
			case <-m.runtimeCtx.Done():
				return
			default:
			}

			as.mu.RLock()
			hasSubscribers := len(as.subscribers) > 0
			alreadyRunning := as.client != nil
			as.mu.RUnlock()
			if !hasSubscribers || alreadyRunning {
				return
			}

			stream, err := m.db.GetStreamByID(context.Background(), as.id)
			if err != nil || stream == nil {
				time.Sleep(backoff)
				backoff = minDuration(backoff*2, 15*time.Second)
				continue
			}

			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			client, err := m.connectClient(ctx, *stream)
			cancel()
			if err != nil {
				time.Sleep(backoff)
				backoff = minDuration(backoff*2, 15*time.Second)
				continue
			}

			as.mu.Lock()
			if as.client != nil || len(as.subscribers) == 0 {
				as.mu.Unlock()
				_ = client.Close()
				return
			}
			as.client = client
			as.sourceID = stream.SourceID
			as.generation++
			if as.startedAt.IsZero() {
				as.startedAt = time.Now()
			}
			gen := as.generation
			as.mu.Unlock()

			_ = m.db.UpdateStreamState(context.Background(), as.id, "active")
			m.startPump(as, client, gen)
			return
		}
	}()
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
			// Keep stream "live" by dropping oldest buffered frame,
			// then enqueueing the newest frame when subscribers are slow.
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
