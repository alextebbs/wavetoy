package ringbuf

import (
	"sync"
	"time"
)

type AudioEntry struct {
	Timestamp time.Time
	PCM       []byte
}

type Snapshot struct {
	StreamID   string
	CapturedAt time.Time
	StartTime  time.Time
	EndTime    time.Time
	SampleRate int
	Audio      []AudioEntry
}

type RingBuffer struct {
	mu     sync.RWMutex
	maxAge time.Duration

	slots []AudioEntry
	head  int
	count int
}

func New(maxAge time.Duration, capacity int) *RingBuffer {
	if capacity <= 0 {
		capacity = 9000 // ~6 min at ~24 fps, generous default
	}
	return &RingBuffer{
		maxAge: maxAge,
		slots:  make([]AudioEntry, capacity),
	}
}

func (rb *RingBuffer) Write(ts time.Time, pcm []byte) {
	buf := make([]byte, len(pcm))
	copy(buf, pcm)

	rb.mu.Lock()
	defer rb.mu.Unlock()

	rb.slots[rb.head] = AudioEntry{Timestamp: ts, PCM: buf}
	rb.head = (rb.head + 1) % len(rb.slots)
	if rb.count < len(rb.slots) {
		rb.count++
	}

	rb.evict(ts)
}

func (rb *RingBuffer) evict(now time.Time) {
	cutoff := now.Add(-rb.maxAge)
	tail := rb.tail()
	for rb.count > 0 {
		if !rb.slots[tail].Timestamp.Before(cutoff) {
			break
		}
		rb.slots[tail] = AudioEntry{}
		tail = (tail + 1) % len(rb.slots)
		rb.count--
	}
}

func (rb *RingBuffer) tail() int {
	t := rb.head - rb.count
	if t < 0 {
		t += len(rb.slots)
	}
	return t
}

func (rb *RingBuffer) Snapshot(streamID string, sampleRate int) *Snapshot {
	rb.mu.RLock()
	defer rb.mu.RUnlock()

	if rb.count == 0 {
		return &Snapshot{
			StreamID:   streamID,
			CapturedAt: time.Now(),
			SampleRate: sampleRate,
		}
	}

	entries := make([]AudioEntry, rb.count)
	tail := rb.tail()
	for i := 0; i < rb.count; i++ {
		idx := (tail + i) % len(rb.slots)
		entries[i] = rb.slots[idx]
	}

	return &Snapshot{
		StreamID:   streamID,
		CapturedAt: time.Now(),
		StartTime:  entries[0].Timestamp,
		EndTime:    entries[len(entries)-1].Timestamp,
		SampleRate: sampleRate,
		Audio:      entries,
	}
}

func (rb *RingBuffer) Duration() time.Duration {
	rb.mu.RLock()
	defer rb.mu.RUnlock()
	if rb.count < 2 {
		return 0
	}
	tail := rb.tail()
	newest := (rb.head - 1 + len(rb.slots)) % len(rb.slots)
	return rb.slots[newest].Timestamp.Sub(rb.slots[tail].Timestamp)
}

func (rb *RingBuffer) Count() int {
	rb.mu.RLock()
	defer rb.mu.RUnlock()
	return rb.count
}
