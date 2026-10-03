package chunkring

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/sammy/sdr-radio/internal/snr"
)

// WFFrame is a single waterfall frame stored in a chunk.
// In addition to the raw bins and spatial params (XBin, Zoom), each frame
// records the tuning state at capture time so historical data can be
// correctly positioned and annotated during rewind.
type WFFrame struct {
	TimestampMs int64
	Bins        []byte
	XBin        uint32
	Zoom        uint16
	FreqKHz     float32
	PassbandLo  int16
	PassbandHi  int16
}

// Event is a timestamped event (interpreter output, log entry, etc.) stored in a chunk.
type Event struct {
	TimestampMs int64
	Type        string
	Data        json.RawMessage
}

// Chunk holds audio, waterfall, and event data for a 1-minute wall-clock window.
// A chunk may be sparse — it represents the full time window regardless of how
// much data actually arrived.
type Chunk struct {
	Index      int
	StartedAt  time.Time
	EndedAt    time.Time
	Complete   bool
	SourceID   string
	AudioPCM   []byte
	SampleRate int
	WFFrames   []WFFrame
	Events     []Event
	StateSnap  uint8
	HealthSnap uint8
}

// ChunkMeta is the metadata for a chunk, returned by Available().
type ChunkMeta struct {
	Index        int        `json:"index"`
	StartedAt    time.Time  `json:"started_at"`
	EndedAt      *time.Time `json:"ended_at"`
	Complete     bool       `json:"complete"`
	AudioBytes   int        `json:"audio_bytes"`
	WFFrames     int        `json:"wf_frames"`
	Events       int        `json:"events"`
	WFZoom        uint16     `json:"wf_zoom"`
	WFZoomChanged bool       `json:"wf_zoom_changed"`
	SourceID      string     `json:"source_id"`
	State         uint8      `json:"state"`
	Health        uint8      `json:"health"`
	InBandSNRdB   *float64   `json:"in_band_snr_db"`
}

func metaFromChunk(c *Chunk) ChunkMeta {
	m := ChunkMeta{
		Index:      c.Index,
		StartedAt:  c.StartedAt,
		Complete:   c.Complete,
		AudioBytes: len(c.AudioPCM),
		WFFrames:   len(c.WFFrames),
		Events:     len(c.Events),
		SourceID:   c.SourceID,
		State:      c.StateSnap,
		Health:     c.HealthSnap,
	}
	if c.Complete {
		m.EndedAt = &c.EndedAt
	}
	if len(c.WFFrames) > 0 {
		m.WFZoom = c.WFFrames[0].Zoom
		for i := 1; i < len(c.WFFrames); i++ {
			if c.WFFrames[i].Zoom != m.WFZoom {
				m.WFZoomChanged = true
				break
			}
		}
	}
	m.InBandSNRdB = ChunkSNR(c)
	return m
}

// ChunkSNR computes the aggregate in-band SNR from a chunk's waterfall frames.
// Returns nil if the computation fails (no WF frames, passband outside view, etc.).
func ChunkSNR(chunk *Chunk) *float64 {
	if len(chunk.WFFrames) == 0 {
		return nil
	}

	f := chunk.WFFrames[0]
	band := snr.BandConfig{
		CenterKHz:    float64(f.FreqKHz),
		PassbandLoHz: int(f.PassbandLo),
		PassbandHiHz: int(f.PassbandHi),
	}

	frames := make([]snr.WFFrameData, 0, len(chunk.WFFrames))
	for _, wf := range chunk.WFFrames {
		frames = append(frames, snr.WFFrameData{
			Bins: wf.Bins,
			XBin: wf.XBin,
			Zoom: wf.Zoom,
		})
	}

	result, err := snr.FromWFFrames(frames, band)
	if err != nil {
		return nil
	}

	v := result.InBandSNRdB
	return &v
}

// ChunkSink receives completed chunks (e.g. for S3 upload in monitoring mode).
type ChunkSink interface {
	OnChunkComplete(chunk *Chunk) error
}

// OnRotate is called when a chunk rotation occurs, with the completed chunk's metadata.
// Used to notify WebSocket subscribers.
type OnRotate func(meta ChunkMeta)

// HealthSnapshotFunc returns a point-in-time (stateInt, healthBitmask) for embedding in chunk metadata.
type HealthSnapshotFunc func() (uint8, uint8)

// ChunkRing is a ring buffer of fixed-duration chunks that captures audio,
// waterfall, and events together. Rotation is wall-clock driven via a ticker.
type ChunkRing struct {
	streamID   string
	chunkDur   time.Duration
	sampleRate int

	mu        sync.RWMutex
	ring      []*Chunk
	ringSize  int
	ringHead  int
	ringCount int
	current   *Chunk

	sink     ChunkSink
	sinkCh   chan *Chunk
	sinkDone chan struct{}

	onRotate       OnRotate
	healthSnapshot HealthSnapshotFunc

	sourceID_ string

	ticker *time.Ticker
	done   chan struct{}

	totalChunks int64
}

// New creates a ChunkRing and starts the background rotation ticker.
// Caller must call Close() when the stream stops.
func New(streamID string, chunkDur time.Duration, ringSize int, sampleRate int) *ChunkRing {
	cr := &ChunkRing{
		streamID:   streamID,
		chunkDur:   chunkDur,
		sampleRate: sampleRate,
		ring:       make([]*Chunk, ringSize),
		ringSize:   ringSize,
		current:    newChunk(0, time.Now(), sampleRate, ""),
		sinkCh:     make(chan *Chunk, 3),
		done:       make(chan struct{}),
		ticker:     time.NewTicker(chunkDur),
	}
	go cr.runRotation()
	return cr
}

// ChunkDuration returns the configured rotation interval.
func (cr *ChunkRing) ChunkDuration() time.Duration {
	return cr.chunkDur
}

// SetSourceID updates the source ID stamped onto new chunks.
func (cr *ChunkRing) SetSourceID(id string) {
	cr.mu.Lock()
	cr.sourceID_ = id
	cr.current.SourceID = id
	cr.mu.Unlock()
}

func newChunk(index int, startedAt time.Time, sampleRate int, sourceID string) *Chunk {
	return &Chunk{
		Index:      index,
		StartedAt:  startedAt,
		SampleRate: sampleRate,
		SourceID:   sourceID,
		AudioPCM:   make([]byte, 0, sampleRate*2*60),
		WFFrames:   make([]WFFrame, 0, 512),
	}
}

func (cr *ChunkRing) runRotation() {
	for {
		select {
		case <-cr.ticker.C:
			cr.rotate()
		case <-cr.done:
			cr.ticker.Stop()
			return
		}
	}
}

func (cr *ChunkRing) rotate() {
	cr.mu.Lock()

	now := time.Now()
	cr.current.EndedAt = now
	cr.current.Complete = true
	completed := cr.current

	cr.ring[cr.ringHead] = completed
	cr.ringHead = (cr.ringHead + 1) % cr.ringSize
	if cr.ringCount < cr.ringSize {
		cr.ringCount++
	}
	cr.totalChunks++

	healthSnap := cr.healthSnapshot
	if healthSnap != nil {
		completed.StateSnap, completed.HealthSnap = healthSnap()
	}

	if cr.sink != nil {
		select {
		case cr.sinkCh <- completed:
		default:
			slog.Warn("chunkring: sink backed up, dropping chunk",
				"stream", cr.streamID, "index", completed.Index)
		}
	}

	cr.current = newChunk(int(cr.totalChunks), now, cr.sampleRate, cr.sourceID_)

	meta := metaFromChunk(completed)
	onRotate := cr.onRotate
	cr.mu.Unlock()

	if onRotate != nil {
		onRotate(meta)
	}
}

// WriteAudio appends PCM16 audio data to the current chunk.
func (cr *ChunkRing) WriteAudio(ts time.Time, pcm []byte) {
	cr.mu.Lock()
	cr.current.AudioPCM = append(cr.current.AudioPCM, pcm...)
	cr.mu.Unlock()
}

// WriteWF appends a waterfall frame to the current chunk.
func (cr *ChunkRing) WriteWF(ts time.Time, bins []byte, xBin uint32, zoom uint16,
	freqKHz float32, passLo, passHi int16) {
	b := make([]byte, len(bins))
	copy(b, bins)
	frame := WFFrame{
		TimestampMs: ts.UnixMilli(),
		Bins:        b,
		XBin:        xBin,
		Zoom:        zoom,
		FreqKHz:     freqKHz,
		PassbandLo:  passLo,
		PassbandHi:  passHi,
	}
	cr.mu.Lock()
	cr.current.WFFrames = append(cr.current.WFFrames, frame)
	cr.mu.Unlock()
}

// WriteEvent appends an event to the current chunk.
func (cr *ChunkRing) WriteEvent(ts time.Time, typ string, data json.RawMessage) {
	ev := Event{
		TimestampMs: ts.UnixMilli(),
		Type:        typ,
		Data:        data,
	}
	cr.mu.Lock()
	cr.current.Events = append(cr.current.Events, ev)
	cr.mu.Unlock()
}

// SetSink attaches or detaches a ChunkSink. A non-nil sink starts a worker
// goroutine that serially processes completed chunks. Passing nil detaches.
func (cr *ChunkRing) SetSink(sink ChunkSink) {
	cr.mu.Lock()
	defer cr.mu.Unlock()

	if cr.sink != nil && cr.sinkDone != nil {
		close(cr.sinkDone)
		cr.sinkDone = nil
	}

	cr.sink = sink
	if sink != nil {
		cr.sinkDone = make(chan struct{})
		go cr.runSinkWorker(cr.sinkDone)
	}
}

func (cr *ChunkRing) runSinkWorker(done chan struct{}) {
	for {
		select {
		case <-done:
			return
		case chunk, ok := <-cr.sinkCh:
			if !ok {
				return
			}
			cr.mu.RLock()
			sink := cr.sink
			cr.mu.RUnlock()
			if sink == nil {
				continue
			}
			if err := sink.OnChunkComplete(chunk); err != nil {
				slog.Warn("chunkring: sink failed, retrying once",
					"stream", cr.streamID, "index", chunk.Index, "err", err)
				if err := sink.OnChunkComplete(chunk); err != nil {
					slog.Error("chunkring: sink retry failed, dropping chunk",
						"stream", cr.streamID, "index", chunk.Index, "err", err)
				}
			}
		}
	}
}

// SetOnRotate registers a callback invoked (outside the lock) after each chunk rotation.
func (cr *ChunkRing) SetOnRotate(fn OnRotate) {
	cr.mu.Lock()
	cr.onRotate = fn
	cr.mu.Unlock()
}

// SetHealthSnapshot registers a function that returns (stateInt, healthBitmask)
// to be captured in chunk metadata at rotation time.
func (cr *ChunkRing) SetHealthSnapshot(fn HealthSnapshotFunc) {
	cr.mu.Lock()
	cr.healthSnapshot = fn
	cr.mu.Unlock()
}

// GetChunk returns a completed chunk by its global index. Returns nil if evicted.
func (cr *ChunkRing) GetChunk(index int) *Chunk {
	cr.mu.RLock()
	defer cr.mu.RUnlock()
	for i := 0; i < cr.ringCount; i++ {
		slot := (cr.ringHead - cr.ringCount + i + cr.ringSize) % cr.ringSize
		if cr.ring[slot] != nil && cr.ring[slot].Index == index {
			return cr.ring[slot]
		}
	}
	return nil
}

// GetChunkByTime returns a completed chunk whose StartedAt matches t
// at unix-second granularity. Returns nil if no match is found.
func (cr *ChunkRing) GetChunkByTime(t time.Time) *Chunk {
	cr.mu.RLock()
	defer cr.mu.RUnlock()
	target := t.Unix()
	for i := 0; i < cr.ringCount; i++ {
		slot := (cr.ringHead - cr.ringCount + i + cr.ringSize) % cr.ringSize
		c := cr.ring[slot]
		if c != nil && c.StartedAt.Unix() == target {
			return c
		}
	}
	return nil
}

// GetCurrent returns a snapshot of the in-progress chunk's data.
func (cr *ChunkRing) GetCurrent() *Chunk {
	cr.mu.RLock()
	defer cr.mu.RUnlock()
	c := cr.current
	snap := &Chunk{
		Index:      c.Index,
		StartedAt:  c.StartedAt,
		SampleRate: c.SampleRate,
		SourceID:   c.SourceID,
	}
	snap.AudioPCM = make([]byte, len(c.AudioPCM))
	copy(snap.AudioPCM, c.AudioPCM)
	snap.WFFrames = make([]WFFrame, len(c.WFFrames))
	copy(snap.WFFrames, c.WFFrames)
	snap.Events = make([]Event, len(c.Events))
	copy(snap.Events, c.Events)
	return snap
}

// Available returns metadata for all chunks in the ring plus the in-progress chunk.
func (cr *ChunkRing) Available() []ChunkMeta {
	cr.mu.RLock()
	defer cr.mu.RUnlock()

	result := make([]ChunkMeta, 0, cr.ringCount+1)
	for i := 0; i < cr.ringCount; i++ {
		slot := (cr.ringHead - cr.ringCount + i + cr.ringSize) % cr.ringSize
		if cr.ring[slot] != nil {
			result = append(result, metaFromChunk(cr.ring[slot]))
		}
	}
	result = append(result, metaFromChunk(cr.current))
	return result
}

// GetChunksInRange returns all completed chunks whose time range overlaps [from, to).
func (cr *ChunkRing) GetChunksInRange(from, to time.Time) []*Chunk {
	cr.mu.RLock()
	defer cr.mu.RUnlock()

	var result []*Chunk
	for i := 0; i < cr.ringCount; i++ {
		slot := (cr.ringHead - cr.ringCount + i + cr.ringSize) % cr.ringSize
		c := cr.ring[slot]
		if c != nil && c.StartedAt.Before(to) && c.EndedAt.After(from) {
			result = append(result, c)
		}
	}
	return result
}

// SnapshotAudio concatenates all audio from the ring + current chunk into a
// contiguous PCM buffer, for capture compatibility.
func (cr *ChunkRing) SnapshotAudio() (pcm []byte, sampleRate int) {
	cr.mu.RLock()
	defer cr.mu.RUnlock()

	totalLen := 0
	for i := 0; i < cr.ringCount; i++ {
		slot := (cr.ringHead - cr.ringCount + i + cr.ringSize) % cr.ringSize
		if cr.ring[slot] != nil {
			totalLen += len(cr.ring[slot].AudioPCM)
		}
	}
	totalLen += len(cr.current.AudioPCM)

	pcm = make([]byte, 0, totalLen)
	for i := 0; i < cr.ringCount; i++ {
		slot := (cr.ringHead - cr.ringCount + i + cr.ringSize) % cr.ringSize
		if cr.ring[slot] != nil {
			pcm = append(pcm, cr.ring[slot].AudioPCM...)
		}
	}
	pcm = append(pcm, cr.current.AudioPCM...)
	return pcm, cr.sampleRate
}

// Reset clears all chunks and resets the ring.
func (cr *ChunkRing) Reset() {
	cr.mu.Lock()
	defer cr.mu.Unlock()
	for i := range cr.ring {
		cr.ring[i] = nil
	}
	cr.ringHead = 0
	cr.ringCount = 0
	cr.totalChunks = 0
	cr.current = newChunk(0, time.Now(), cr.sampleRate, cr.sourceID_)
}

// Close stops the rotation ticker and cleans up. Must be called when the stream stops.
func (cr *ChunkRing) Close() {
	close(cr.done)
	cr.mu.Lock()
	if cr.sink != nil && cr.sinkDone != nil {
		close(cr.sinkDone)
		cr.sinkDone = nil
	}
	cr.mu.Unlock()
}
