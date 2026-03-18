package chunkring

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"sync"
	"testing"
	"time"
)

func shortDur() time.Duration { return 100 * time.Millisecond }

func TestWriteAudioAndSnapshot(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	cr.WriteAudio(time.Now(), []byte{1, 2, 3, 4})
	cr.WriteAudio(time.Now(), []byte{5, 6})

	pcm, sr := cr.SnapshotAudio()
	if sr != 12000 {
		t.Fatalf("expected sample rate 12000, got %d", sr)
	}
	if !bytes.Equal(pcm, []byte{1, 2, 3, 4, 5, 6}) {
		t.Fatalf("unexpected PCM: %v", pcm)
	}
}

func TestWriteWF(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	cr.WriteWF(time.Now(), []byte{10, 20, 30}, 100, 8, 7100.0, -2800, 2800)

	snap := cr.GetCurrent()
	if len(snap.WFFrames) != 1 {
		t.Fatalf("expected 1 WF frame, got %d", len(snap.WFFrames))
	}
	f := snap.WFFrames[0]
	if f.XBin != 100 || f.Zoom != 8 {
		t.Fatalf("unexpected frame metadata: xbin=%d zoom=%d", f.XBin, f.Zoom)
	}
	if !bytes.Equal(f.Bins, []byte{10, 20, 30}) {
		t.Fatalf("unexpected bins: %v", f.Bins)
	}
	if f.FreqKHz != 7100.0 || f.PassbandLo != -2800 || f.PassbandHi != 2800 {
		t.Fatalf("unexpected tuning: freq=%f lo=%d hi=%d", f.FreqKHz, f.PassbandLo, f.PassbandHi)
	}
}

func TestWriteWFDataIsolation(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	bins := []byte{10, 20, 30}
	cr.WriteWF(time.Now(), bins, 100, 8, 7100, -2800, 2800)
	bins[0] = 99

	snap := cr.GetCurrent()
	if snap.WFFrames[0].Bins[0] != 10 {
		t.Fatal("WriteWF should copy bins, not reference them")
	}
}

func TestWriteEvent(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	data := json.RawMessage(`{"text":"hello"}`)
	cr.WriteEvent(time.Now(), "interpreter", data)

	snap := cr.GetCurrent()
	if len(snap.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(snap.Events))
	}
	if snap.Events[0].Type != "interpreter" {
		t.Fatalf("unexpected event type: %s", snap.Events[0].Type)
	}
}

func TestRotation(t *testing.T) {
	cr := New("test", shortDur(), 3, 12000)
	defer cr.Close()

	cr.WriteAudio(time.Now(), []byte{1, 2})

	time.Sleep(150 * time.Millisecond)
	cr.WriteAudio(time.Now(), []byte{3, 4})

	avail := cr.Available()
	if len(avail) < 2 {
		t.Fatalf("expected at least 2 chunks (1 completed + 1 in-progress), got %d", len(avail))
	}
	if !avail[0].Complete {
		t.Fatal("first chunk should be complete")
	}
	if avail[len(avail)-1].Complete {
		t.Fatal("last chunk should be in-progress")
	}
}

func TestRingEviction(t *testing.T) {
	cr := New("test", shortDur(), 2, 12000)
	defer cr.Close()

	// Write into first chunk, wait for rotation
	cr.WriteAudio(time.Now(), []byte{1, 2})
	time.Sleep(150 * time.Millisecond)

	// Write into second chunk, wait for rotation
	cr.WriteAudio(time.Now(), []byte{3, 4})
	time.Sleep(150 * time.Millisecond)

	// Write into third chunk, wait for rotation (should evict first)
	cr.WriteAudio(time.Now(), []byte{5, 6})
	time.Sleep(150 * time.Millisecond)

	avail := cr.Available()
	completed := 0
	for _, m := range avail {
		if m.Complete {
			completed++
		}
	}
	if completed > 2 {
		t.Fatalf("expected at most 2 completed chunks (ring size), got %d", completed)
	}

	// First chunk (index 0) should be evicted
	if cr.GetChunk(0) != nil {
		t.Fatal("chunk 0 should have been evicted")
	}
}

func TestGetChunk(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	cr.WriteAudio(time.Now(), []byte{1, 2})
	time.Sleep(150 * time.Millisecond)

	chunk := cr.GetChunk(0)
	if chunk == nil {
		t.Fatal("expected to find chunk 0")
	}
	if chunk.Index != 0 {
		t.Fatalf("expected index 0, got %d", chunk.Index)
	}
	if !bytes.Equal(chunk.AudioPCM, []byte{1, 2}) {
		t.Fatalf("unexpected audio: %v", chunk.AudioPCM)
	}
}

func TestGetChunkEvicted(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	if cr.GetChunk(999) != nil {
		t.Fatal("expected nil for non-existent chunk")
	}
}

func TestAvailable(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	avail := cr.Available()
	if len(avail) != 1 {
		t.Fatalf("expected 1 chunk (in-progress), got %d", len(avail))
	}
	if avail[0].Complete {
		t.Fatal("in-progress chunk should not be complete")
	}
}

func TestChunkMetaZoomChanged(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	cr.WriteWF(time.Now(), []byte{1}, 0, 8, 7100, -2800, 2800)
	cr.WriteWF(time.Now(), []byte{2}, 0, 10, 7100, -2800, 2800) // different zoom

	avail := cr.Available()
	last := avail[len(avail)-1]
	if !last.WFZoomChanged {
		t.Fatal("expected WFZoomChanged=true when zoom differs")
	}
}

func TestOnRotateCallback(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	var called bool
	var mu sync.Mutex
	cr.SetOnRotate(func(meta ChunkMeta) {
		mu.Lock()
		called = true
		mu.Unlock()
	})

	cr.WriteAudio(time.Now(), []byte{1, 2})
	time.Sleep(150 * time.Millisecond)

	mu.Lock()
	if !called {
		t.Fatal("expected OnRotate to be called")
	}
	mu.Unlock()
}

func TestSourceIDTracking(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	cr.SetSourceID("source-a")
	snap := cr.GetCurrent()
	if snap.SourceID != "source-a" {
		t.Fatalf("expected source-a on current chunk, got %q", snap.SourceID)
	}

	cr.WriteAudio(time.Now(), []byte{1, 2})
	time.Sleep(150 * time.Millisecond)
	cr.WriteAudio(time.Now(), []byte{3, 4})

	// After rotation the completed chunk keeps source-a, and the new
	// current chunk also inherits it.
	avail := cr.Available()
	if avail[0].SourceID != "source-a" {
		t.Fatalf("expected completed chunk source-a, got %q", avail[0].SourceID)
	}
	cur := avail[len(avail)-1]
	if cur.SourceID != "source-a" {
		t.Fatalf("expected current chunk source-a, got %q", cur.SourceID)
	}

	// Switch source mid-stream; only the current chunk should change.
	cr.SetSourceID("source-b")
	avail2 := cr.Available()
	if avail2[0].SourceID != "source-a" {
		t.Fatalf("completed chunk should still be source-a, got %q", avail2[0].SourceID)
	}
	cur2 := avail2[len(avail2)-1]
	if cur2.SourceID != "source-b" {
		t.Fatalf("expected current chunk source-b after switch, got %q", cur2.SourceID)
	}
}

func TestReset(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	cr.WriteAudio(time.Now(), []byte{1, 2})
	time.Sleep(150 * time.Millisecond)
	cr.Reset()

	avail := cr.Available()
	if len(avail) != 1 {
		t.Fatalf("expected 1 chunk after reset, got %d", len(avail))
	}
	if avail[0].AudioBytes != 0 {
		t.Fatal("expected empty audio after reset")
	}
}

func TestSnapshotAudioConcatenation(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	cr.WriteAudio(time.Now(), []byte{1, 2})
	time.Sleep(150 * time.Millisecond)
	cr.WriteAudio(time.Now(), []byte{3, 4})

	pcm, _ := cr.SnapshotAudio()
	if !bytes.Equal(pcm, []byte{1, 2, 3, 4}) {
		t.Fatalf("expected concatenated PCM [1,2,3,4], got %v", pcm)
	}
}

func TestConcurrentWrites(t *testing.T) {
	cr := New("test", shortDur(), 5, 12000)
	defer cr.Close()

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			cr.WriteAudio(time.Now(), []byte{1, 2})
		}()
		go func() {
			defer wg.Done()
			cr.WriteWF(time.Now(), []byte{1, 2, 3}, 0, 8, 7100, -2800, 2800)
		}()
		go func() {
			defer wg.Done()
			cr.WriteEvent(time.Now(), "test", json.RawMessage(`{}`))
		}()
	}
	wg.Wait()

	pcm, _ := cr.SnapshotAudio()
	if len(pcm) == 0 {
		t.Fatal("expected non-empty audio after concurrent writes")
	}
}

// --- Serialization tests ---

func TestSerializeAudioWAV(t *testing.T) {
	chunk := &Chunk{
		AudioPCM:   []byte{0, 0, 1, 0, 2, 0, 3, 0},
		SampleRate: 12000,
	}
	var buf bytes.Buffer
	if err := SerializeAudioWAV(&buf, chunk); err != nil {
		t.Fatal(err)
	}
	data := buf.Bytes()
	if len(data) != 44+8 {
		t.Fatalf("expected 52 bytes, got %d", len(data))
	}
	if string(data[0:4]) != "RIFF" {
		t.Fatal("missing RIFF header")
	}
	if string(data[8:12]) != "WAVE" {
		t.Fatal("missing WAVE marker")
	}
	sr := binary.LittleEndian.Uint32(data[24:28])
	if sr != 12000 {
		t.Fatalf("expected sample rate 12000 in header, got %d", sr)
	}
}

func TestSerializeWF(t *testing.T) {
	chunk := &Chunk{
		WFFrames: []WFFrame{
			{TimestampMs: 1000, Bins: []byte{10, 20, 30}, XBin: 100, Zoom: 8,
				FreqKHz: 7100.0, PassbandLo: -2800, PassbandHi: 2800},
			{TimestampMs: 2000, Bins: []byte{40, 50}, XBin: 200, Zoom: 10,
				FreqKHz: 14200.0, PassbandLo: -1500, PassbandHi: 1500},
		},
	}
	var buf bytes.Buffer
	if err := SerializeWF(&buf, chunk); err != nil {
		t.Fatal(err)
	}
	data := buf.Bytes()

	// Frame 1: 24 header + 3 bins = 27 bytes
	// Frame 2: 24 header + 2 bins = 26 bytes
	expected := 27 + 26
	if len(data) != expected {
		t.Fatalf("expected %d bytes, got %d", expected, len(data))
	}

	ts := binary.LittleEndian.Uint64(data[0:8])
	if ts != 1000 {
		t.Fatalf("expected timestamp 1000, got %d", ts)
	}
	xbin := binary.LittleEndian.Uint32(data[8:12])
	if xbin != 100 {
		t.Fatalf("expected xbin 100, got %d", xbin)
	}
	zoom := binary.LittleEndian.Uint16(data[12:14])
	if zoom != 8 {
		t.Fatalf("expected zoom 8, got %d", zoom)
	}
	numBins := binary.LittleEndian.Uint16(data[14:16])
	if numBins != 3 {
		t.Fatalf("expected 3 bins, got %d", numBins)
	}
	freqBits := binary.LittleEndian.Uint32(data[16:20])
	freqKHz := math.Float32frombits(freqBits)
	if freqKHz != 7100.0 {
		t.Fatalf("expected freqKHz 7100.0, got %f", freqKHz)
	}
	passLo := int16(binary.LittleEndian.Uint16(data[20:22]))
	if passLo != -2800 {
		t.Fatalf("expected passLo -2800, got %d", passLo)
	}
	passHi := int16(binary.LittleEndian.Uint16(data[22:24]))
	if passHi != 2800 {
		t.Fatalf("expected passHi 2800, got %d", passHi)
	}
}

func TestSerializeEvents(t *testing.T) {
	chunk := &Chunk{
		Events: []Event{
			{TimestampMs: 1000, Type: "log", Data: json.RawMessage(`{"msg":"hello"}`)},
			{TimestampMs: 2000, Type: "interpreter", Data: json.RawMessage(`{"text":"cq cq"}`)},
		},
	}
	var buf bytes.Buffer
	if err := SerializeEvents(&buf, chunk); err != nil {
		t.Fatal(err)
	}

	lines := bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte{'\n'})
	if len(lines) != 2 {
		t.Fatalf("expected 2 JSONL lines, got %d", len(lines))
	}

	var obj map[string]any
	if err := json.Unmarshal(lines[0], &obj); err != nil {
		t.Fatal(err)
	}
	if obj["type"] != "log" {
		t.Fatalf("expected type 'log', got %v", obj["type"])
	}
}

func TestSerializeAudioWAVOddLength(t *testing.T) {
	chunk := &Chunk{
		AudioPCM:   []byte{0, 0, 1}, // 3 bytes = odd, should round down to 2
		SampleRate: 12000,
	}
	var buf bytes.Buffer
	if err := SerializeAudioWAV(&buf, chunk); err != nil {
		t.Fatal(err)
	}
	data := buf.Bytes()
	dataSize := binary.LittleEndian.Uint32(data[40:44])
	if dataSize != 2 {
		t.Fatalf("expected data size 2 (rounded down), got %d", dataSize)
	}
}
