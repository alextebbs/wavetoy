package ringbuf

import (
	"testing"
	"time"
)

func TestWriteAndSnapshot(t *testing.T) {
	rb := New(5*time.Minute, 100)
	now := time.Now()

	for i := 0; i < 10; i++ {
		pcm := []byte{byte(i), byte(i + 1)}
		rb.Write(now.Add(time.Duration(i)*time.Second), pcm)
	}

	snap := rb.Snapshot("test-stream", 12000)
	if len(snap.Audio) != 10 {
		t.Fatalf("expected 10 entries, got %d", len(snap.Audio))
	}
	if snap.StreamID != "test-stream" {
		t.Fatalf("expected stream id test-stream, got %s", snap.StreamID)
	}
	if snap.SampleRate != 12000 {
		t.Fatalf("expected sample rate 12000, got %d", snap.SampleRate)
	}
	if snap.Audio[0].PCM[0] != 0 || snap.Audio[9].PCM[0] != 9 {
		t.Fatal("entries not in order")
	}
}

func TestEviction(t *testing.T) {
	rb := New(2*time.Second, 100)
	now := time.Now()

	rb.Write(now, []byte{1})
	rb.Write(now.Add(1*time.Second), []byte{2})
	rb.Write(now.Add(3*time.Second), []byte{3})

	snap := rb.Snapshot("s", 12000)
	if len(snap.Audio) != 2 {
		t.Fatalf("expected 2 entries after eviction, got %d", len(snap.Audio))
	}
	if snap.Audio[0].PCM[0] != 2 {
		t.Fatalf("expected first surviving entry to be 2, got %d", snap.Audio[0].PCM[0])
	}
}

func TestWrapAround(t *testing.T) {
	rb := New(10*time.Second, 4)
	now := time.Now()

	for i := 0; i < 6; i++ {
		rb.Write(now.Add(time.Duration(i)*time.Millisecond*100), []byte{byte(i)})
	}

	snap := rb.Snapshot("s", 12000)
	if len(snap.Audio) != 4 {
		t.Fatalf("expected 4 entries (capacity), got %d", len(snap.Audio))
	}
	if snap.Audio[0].PCM[0] != 2 {
		t.Fatalf("expected oldest entry to be 2, got %d", snap.Audio[0].PCM[0])
	}
	if snap.Audio[3].PCM[0] != 5 {
		t.Fatalf("expected newest entry to be 5, got %d", snap.Audio[3].PCM[0])
	}
}

func TestEmptySnapshot(t *testing.T) {
	rb := New(5*time.Minute, 100)
	snap := rb.Snapshot("s", 12000)
	if len(snap.Audio) != 0 {
		t.Fatalf("expected 0 entries, got %d", len(snap.Audio))
	}
}

func TestDuration(t *testing.T) {
	rb := New(5*time.Minute, 100)
	if rb.Duration() != 0 {
		t.Fatal("expected 0 duration on empty buffer")
	}

	now := time.Now()
	rb.Write(now, []byte{1})
	rb.Write(now.Add(3*time.Second), []byte{2})

	d := rb.Duration()
	if d < 2*time.Second || d > 4*time.Second {
		t.Fatalf("expected ~3s duration, got %s", d)
	}
}

func TestDataIsolation(t *testing.T) {
	rb := New(5*time.Minute, 100)
	data := []byte{1, 2, 3}
	rb.Write(time.Now(), data)

	data[0] = 99
	snap := rb.Snapshot("s", 12000)
	if snap.Audio[0].PCM[0] != 1 {
		t.Fatal("ring buffer should copy data, not reference it")
	}
}
