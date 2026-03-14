# Ring Buffer Implementation Plan

## Overview

Add a continuous ring buffer per stream that captures audio (SND) data as it flows through the Go backend. The duration is controlled by the existing `BufferMinutes` field on the stream model (default: 5 minutes). When a user presses a "Capture" button on the frontend, the current contents of the ring buffer are snapshotted to disk as a WAV file, and the UI switches from live mode to a playback mode where the user can scrub/seek through the captured audio.

This is the foundation for a future automatic capture system where the backend detects transmission activity on a frequency and triggers captures without user intervention.

### Why Audio Only (No Waterfall Data)

The ring buffer deliberately excludes waterfall (W/F) data. W/F frames are tied to a specific zoom level and center frequency — the 1024 bins represent `MAX_FREQ / 2^zoom` kHz of spectrum. When the user changes zoom (15 levels, from full 30 MHz down to 1.83 kHz), the meaning of each bin changes completely. Historical W/F frames captured at zoom 0 are useless when the user is now viewing at zoom 8. Buffering W/F data would produce a patchwork of incompatible frames that can't be meaningfully replayed or displayed together.

Audio, by contrast, is zoom-independent. It's always the demodulated audio for the current frequency/mode, regardless of what the waterfall is showing. It's the actual data worth capturing.

---

## Current State

| Aspect | Status |
|--------|--------|
| Audio data flow | KiwiSDR → `kiwi.Client` → `streammgr.startPump()` → fan-out to subscriber channels |
| W/F data flow | KiwiSDR → `kiwi.WFClient` → `streammgr.startWFPump()` → fan-out to WF subscriber channels |
| Buffering | **None** — data is forwarded in real time, no history kept |
| `BufferMinutes` field | Exists in `models.Stream` and DB schema, defaults to 15 in `createStream`, but **unused** in the pipeline |
| Recording | **None** — no file storage, no capture API |
| Frontend playback | **None** — audio goes straight to AudioWorklet, no seek/scrub |

---

## Data Rate Analysis

Understanding data rates is critical for sizing the ring buffer and estimating disk usage.

### Audio (PCM16)

| Parameter | Value |
|-----------|-------|
| Sample rate | 12,000 Hz |
| Format | PCM16 (2 bytes/sample) |
| Bytes/sec | 24,000 |
| Frame size | ~1,024 bytes (~512 samples) |
| Frame rate | ~23.4 frames/sec |

| Period | Audio Size |
|--------|-----------|
| 1 second | 24 KB |
| 1 minute | 1.44 MB |
| 5 minutes | 7.2 MB |
| 15 minutes | 21.6 MB |

### `BufferMinutes` Default

The existing `BufferMinutes` field defaults to 15 in `createStream` (in `streams.go`). We should **change this default to 5** for the ring buffer use case. Users can increase `BufferMinutes` if they want longer captures, but 5 minutes is a sensible default.

A 5-minute audio-only ring buffer uses ~7.2 MB per stream. Even 20 concurrent streams would only use ~144 MB.

---

## Architecture

```
KiwiSDR
  ├─ /SND → kiwi.Client → pcm channel ──────────┐
  │                                               ▼
  │                                    ┌──────────────────────┐
  │                                    │ streammgr.startPump  │
  │                                    │                      │
  │                                    │  frame ──┬──→ broadcast(subscribers)
  │                                    │          │
  │                                    │          └──→ ringBuffer.WriteAudio(ts, frame)
  │                                    └──────────────────────┘
  │
  └─ /W/F → kiwi.WFClient → frames channel ─────┐
                                                  ▼
                                       ┌──────────────────────┐
                                       │ streammgr.startWFPump│
                                       │                      │
                                       │  frame ──→ broadcastWF(wfSubscribers)
                                       │           (no ring buffer — zoom-dependent)
                                       └──────────────────────┘

                                       ┌──────────────────────┐
                                       │ Capture Flow         │
                                       │                      │
                                       │ POST /api/streams/{id}/capture
                                       │   → ringBuffer.Snapshot()
                                       │   → write manifest.json
                                       │   → write audio.wav
                                       │   → return capture metadata
                                       └──────────────────────┘

                                       ┌──────────────────────┐
                                       │ Playback Flow        │
                                       │                      │
                                       │ GET /api/captures/{id}/manifest
                                       │ GET /api/captures/{id}/audio
                                       │   → frontend loads + plays
                                       └──────────────────────┘
```

---

## Backend: In-Memory Ring Buffer

### `internal/ringbuf/ringbuf.go`

A circular buffer that stores timestamped audio frames.

```go
type AudioEntry struct {
    Timestamp time.Time
    PCM       []byte     // raw PCM16 frame (~1024 bytes)
}

type RingBuffer struct {
    mu       sync.RWMutex
    maxAge   time.Duration   // 5 minutes default

    head     int
    slots    []AudioEntry
    count    int
}
```

#### Sizing

Pre-allocate a fixed-capacity slice based on expected frame rate:

| Frame rate | 5 min capacity | Slot size | Total |
|-----------|----------------|-----------|-------|
| ~24/sec | 7,200 entries | ~1 KB each | ~7.2 MB |

#### Key Methods

| Method | Purpose |
|--------|---------|
| `New(maxAge time.Duration) *RingBuffer` | Create buffer with configured window |
| `Write(ts time.Time, pcm []byte)` | Append an audio frame, evict entries older than `maxAge` |
| `Snapshot() *Snapshot` | Copy current contents under read lock |
| `Oldest() time.Time` | Timestamp of the oldest entry |
| `Newest() time.Time` | Timestamp of the newest entry |
| `Duration() time.Duration` | Newest - Oldest |
| `Reset()` | Clear all entries |

#### Eviction Strategy

On every write, check if the oldest entry is older than `maxAge`. If so, advance the tail pointer. This is O(1) because the buffer is time-ordered — we only ever evict from the tail.

#### Snapshot

`Snapshot()` copies current entries into a contiguous `Snapshot` struct:

```go
type Snapshot struct {
    StreamID    string
    CapturedAt  time.Time
    StartTime   time.Time
    EndTime     time.Time
    SampleRate  int
    Audio       []AudioEntry
}
```

#### Snapshot Locking Strategy

A simple approach takes a read lock for the full ~7.2 MB copy, blocking writes from the pump for the duration (~3-5ms). At ~24 frames/sec one frame arrives every ~42ms, so at most one frame is briefly delayed. This is fine for user-initiated captures.

For future **auto-capture** (where the system may snapshot frequently), a segment-based approach bounds lock time further: split the buffer into fixed-size segments (e.g., 256 entries), take the lock per-segment, copy ~256 KB, release, repeat. This bounds the maximum write-blocking time to < 1ms per segment.

```go
func (rb *RingBuffer) Snapshot() *Snapshot {
    snap := &Snapshot{...}
    for _, seg := range rb.segments {
        seg.mu.RLock()
        snap.Audio = append(snap.Audio, seg.entries[:seg.count]...)
        seg.mu.RUnlock()
    }
    return snap
}
```

Start with the simple single-lock copy. Upgrade to segments when auto-capture is implemented.

### Integration with `streammgr`

Add a `ringBuf *ringbuf.RingBuffer` field to `activeStream`:

```go
type activeStream struct {
    // ... existing fields ...
    ringBuf *ringbuf.RingBuffer
}
```

Modify `startPump` to write into the ring buffer alongside the fan-out:

```go
// In startPump, after broadcast:
as.ringBuf.Write(time.Now(), frame)
```

No changes to `startWFPump` — waterfall data is not buffered (see "Why Audio Only" above).

The ring buffer is created when the stream starts and uses the stream's `BufferMinutes` field (finally putting it to use):

```go
as := &activeStream{
    // ...
    ringBuf: ringbuf.New(time.Duration(stream.BufferMinutes) * time.Minute),
}
```

---

## Persistent Storage: Directory-Based Capture Format

When the user captures, the snapshot is written to disk as a directory of standard-format files. This avoids a custom binary format, making captures debuggable, inspectable, and interoperable with existing tools (e.g., Audacity for audio, any hex viewer for bins).

### Why Not a Custom Binary Format?

An earlier version of this plan proposed a custom `.sdrx` binary format. The problems:

| Concern | Detail |
|---------|--------|
| Dual parsers | Must write and maintain binary parsers in both Go and TypeScript |
| Debugging | Opaque files — can't inspect with standard tools |
| Endianness | Must handle byte order explicitly in both languages |
| Versioning | Custom migration logic for format changes |
| Fragility | Any bug in offset math corrupts the entire file |

The data we're storing is simple (PCM16 audio + metadata). Standard formats handle it fine.

### Capture Directory Layout

```
data/captures/
  {stream_id}/
    {capture_id}/
      manifest.json         # metadata + timing index
      audio.wav             # standard WAV file (PCM16, 12kHz, mono)
```

### `manifest.json`

```json
{
  "version": 1,
  "capture_id": "abc123",
  "stream_id": "stream-uuid",
  "captured_at": "2026-03-14T12:00:00.000Z",
  "start_time": "2026-03-14T11:55:00.000Z",
  "end_time": "2026-03-14T12:00:00.000Z",
  "duration_seconds": 300,
  "sample_rate": 12000,
  "frequency_khz": 7074.0,
  "mode": "usb",
  "audio": {
    "file": "audio.wav",
    "format": "pcm_s16le",
    "channels": 1,
    "total_samples": 3600000
  }
}
```

The manifest records what frequency/mode was being monitored at capture time. Audio seeking is done by byte offset math on the WAV file (sample N is at byte `44 + N * 2`), so no timestamp index is needed.

### `audio.wav`

Standard WAV file. PCM16, mono, 12,000 Hz sample rate. All audio frames from the ring buffer are concatenated as one continuous PCM stream. Can be opened in Audacity, VLC, or any audio tool for debugging.

The Go `encoding/binary` package writes WAV headers natively. No external dependencies needed.

### Why This Works

| Requirement | How Addressed |
|-------------|---------------|
| Fast write | Sequential write of raw PCM, WAV header is 44 bytes |
| Seekable | WAV: sample N at byte `44 + N * 2` — trivial offset math |
| Debuggable | WAV plays in any audio tool. Manifest is readable JSON. |
| No dual parsers | Go writes WAV + JSON, frontend reads WAV as ArrayBuffer + parses JSON |
| Future-proof | Manifest version field. Add new files to the directory without breaking old readers. |

### File Sizes

A 5-minute capture:
- `manifest.json`: ~500 bytes
- `audio.wav`: ~7.2 MB (44-byte header + raw PCM16)
- **Total: ~7.2 MB per capture**

### Storage Location

```
data/captures/
  {stream_id}/
    {capture_id}/
      manifest.json
      audio.wav
```

The backend enforces a configurable storage limit (e.g., 1 GB total) and evicts oldest captures when the limit is reached. At ~7 MB per capture, 1 GB holds ~140 captures.

### `internal/capture/writer.go`

| Function | Purpose |
|----------|---------|
| `WriteCapture(dir string, snap *Snapshot) (*CaptureManifest, error)` | Write manifest.json + audio.wav |
| `ReadManifest(dir string) (*CaptureManifest, error)` | Parse manifest.json |
| `CaptureSize(dir string) (int64, error)` | Total bytes on disk for a capture |

---

## API

### Capture

```
POST /api/streams/{id}/capture
```

Request body: none (captures current ring buffer contents).

Response:

```json
{
  "id": "abc123",
  "stream_id": "stream-uuid",
  "captured_at": "2026-03-14T12:00:00Z",
  "start_time": "2026-03-14T11:55:00Z",
  "end_time": "2026-03-14T12:00:00Z",
  "duration_seconds": 300,
  "size_bytes": 7200044,
  "sample_rate": 12000,
  "frequency_khz": 7074.0,
  "mode": "usb"
}
```

The capture is performed synchronously — snapshotting ~7 MB of memory and writing 2 files to disk takes < 50ms.

### List Captures

```
GET /api/streams/{id}/captures
```

Returns an array of capture metadata, sorted by `captured_at` descending.

### Download Capture Files

```
GET /api/captures/{id}/manifest     → manifest.json
GET /api/captures/{id}/audio        → audio.wav
```

The frontend fetches the manifest first (tiny, ~500 bytes), then loads the audio file. The audio endpoint supports `Accept-Ranges: bytes` for partial loading of long captures.

### Delete Capture

```
DELETE /api/captures/{id}
```

Removes the capture directory and database record.

### Database Table

```sql
CREATE TABLE captures (
    id          TEXT PRIMARY KEY,
    stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    start_time  TIMESTAMPTZ NOT NULL,
    end_time    TIMESTAMPTZ NOT NULL,
    size_bytes    BIGINT NOT NULL,
    sample_rate   INT NOT NULL,
    frequency_khz DOUBLE PRECISION NOT NULL,
    mode          TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Frontend: Playback Mode

### State Machine

The stream player page operates in one of two modes:

```
┌──────────────┐     Capture      ┌──────────────┐
│              │    button press   │              │
│  LIVE mode   │ ───────────────→ │ PLAYBACK mode│
│              │                  │              │
│ Real-time    │  ← Back to Live  │ Historical   │
│ audio + WF   │    button press  │ audio only   │
└──────────────┘                  └──────────────┘
```

In **LIVE mode** (current behavior):
- WebSocket streams audio and W/F in real time
- Audio goes to AudioWorklet → speakers
- W/F goes to waterfall canvas

In **PLAYBACK mode**:
- WebSocket audio is muted (still flowing but not played; ring buffer keeps accumulating)
- W/F continues to render live (waterfall keeps scrolling in the background)
- The captured manifest and audio file are loaded
- Audio from the capture is fed to the AudioWorklet
- User can scrub, play/pause, and adjust playback speed

### Capture Button

A "Capture" button in the stream player toolbar. When pressed:

1. Sends `POST /api/streams/{id}/capture`
2. Receives capture metadata (including capture ID)
3. Fetches the manifest and audio file
4. Switches to PLAYBACK mode, starting at the end of the capture (most recent moment)

### Playback Controller

New component: `frontend/src/components/playback/playback-controller.tsx`

```
┌─────────────────────────────────────────────────────────────────────┐
│ [◄◄] [▶/❚❚] [►►]    ──────●──────────────────────    00:42 / 05:00 │
│                     [1x ▾]            [Back to Live]                │
└─────────────────────────────────────────────────────────────────────┘
```

Controls:
- **Play/Pause** — toggle playback
- **Skip back/forward** — jump 10 seconds
- **Scrub bar** — drag to seek to any point in the capture
- **Current time / total duration** — text display
- **Speed selector** — 0.5x, 1x, 2x, 4x
- **Back to Live** — exit playback mode, return to real-time

### Playback Engine

New file: `frontend/src/components/playback/playback-engine.ts`

The playback engine manages audio playback from a capture.

```typescript
interface PlaybackState {
  mode: 'stopped' | 'playing' | 'paused';
  currentTime: number;       // seconds from capture start
  duration: number;          // total capture duration in seconds
  speed: number;             // 1.0 = normal, 2.0 = double
}

class PlaybackEngine {
  private manifest: CaptureManifest;
  private audioBuffer: ArrayBuffer;     // audio.wav contents
  private state: PlaybackState;
  private audioClockTime: number;       // driven by AudioWorklet

  constructor(manifest: CaptureManifest, audio: ArrayBuffer);

  play(): void;
  pause(): void;
  seek(timeSeconds: number): void;
  setSpeed(speed: number): void;
  stop(): void;

  onStateChange: (state: PlaybackState) => void;
}
```

#### Audio-Driven Timing (Not rAF)

**This is the hardest part of the plan.** Audio playback has ruthless timing requirements — buffer underruns cause audible pops and clicks. `requestAnimationFrame` fires at ~60 Hz but gets throttled or paused entirely when the tab is backgrounded, making it unsuitable as the master clock for audio.

The correct approach: **the AudioWorklet is the timing master, and the scrub bar chases it.**

```
AudioWorklet (steady 128-sample callbacks at hardware rate)
  │
  ├──→ Consumes PCM from a playback ring buffer
  │
  └──→ Reports consumed sample count back to main thread via port.postMessage
        │
        ▼
  Main thread: currentTime = samplesConsumed / sampleRate
        │
        └──→ Updates scrub bar position
```

**How it works:**

1. On `play()`, the engine pre-fills the AudioWorklet's ring buffer with the first chunk of PCM data from `audio.wav`.

2. A **playback-mode AudioWorklet** pulls samples from its ring buffer at the hardware sample rate. As it consumes samples, it posts the running sample count back to the main thread. This is rock-steady timing — the AudioWorklet runs on a dedicated thread at hardware interrupt rate, unaffected by main thread GC pauses or tab visibility.

3. The main thread receives sample-count updates and computes `currentTime = samplesConsumed / sampleRate * speed`. It keeps the AudioWorklet's ring buffer topped up by pushing more PCM data ahead of the read cursor.

4. A `requestAnimationFrame` loop on the main thread reads `currentTime` and updates the scrub bar position.

5. On `seek()`, the engine resets the AudioWorklet's ring buffer, refills it from the new position in the WAV file, and resets the sample counter.

6. On speed change, the engine resamples the PCM data to match the adjusted rate before sending it to the AudioWorklet (e.g., 2x speed = resample 12kHz to 6kHz, then let the AudioWorklet play at its normal rate, or alternatively skip/duplicate samples).

This means the existing `SdrAudioProcessor` worklet needs a small extension to support a "playback mode" where it reports consumed-sample counts back to the main thread. The live-mode behavior remains unchanged.

#### Seeking

WAV audio is trivially seekable by byte offset: sample at time T is at byte `44 + floor(T * sampleRate) * 2`. No index tables needed.

### File Loading Strategy

The frontend loads the manifest and audio:

```typescript
const manifest = await fetch(`/api/captures/${id}/manifest`).then(r => r.json());
const audioBuffer = await fetch(`/api/captures/${id}/audio`).then(r => r.arrayBuffer());
const engine = new PlaybackEngine(manifest, audioBuffer);
```

For a 5-minute capture, this is ~500 bytes + ~7.2 MB = ~7.2 MB. Fast enough to load in a single fetch.

For future longer captures (e.g., 30+ minutes), the WAV endpoint supports range requests so the engine can stream audio in chunks during playback instead of loading the full file upfront.

### Integration with Existing Components

In playback mode, only the audio source changes. The waterfall and spectrum continue to display live data from the WebSocket — they are unaffected by playback mode.

```typescript
// In stream-player-page.tsx, the WebSocket handler becomes:
if (playbackMode) {
  // Discard live audio (playback engine is driving the AudioWorklet)
  // But still forward W/F data — waterfall keeps scrolling live
  if (packet[0] === WATERFALL_TYPE && packet.length > 9) {
    waterfallRef.current?.pushBins(new Uint8Array(ev.data, 9));
  }
  return;
}
// ... existing live handling ...
```

This means during playback, the user hears historical audio but sees the live waterfall. This is a reasonable tradeoff — the waterfall shows what's happening right now on the spectrum, while the audio lets you listen to what happened in the past. The visual context is still useful even if it doesn't match the audio timeline.

---

## Future: Automatic Capture

The ring buffer architecture is designed to support automatic capture in the future. The flow would be:

```
Audio frames → Activity Detector → threshold crossed → ringBuffer.Snapshot()
```

### Activity Detection (Sketch)

The `activeStream` already has `ActivityDetectionEnabled` and `ActivitySensitivity` fields in the model. A future activity detector would:

1. Monitor audio RMS or peak levels in a sliding window
2. When the level exceeds `ActivitySensitivity` threshold, start a "detection window"
3. When the level drops below threshold for N seconds, end the detection window
4. Snapshot the ring buffer, trimmed to the detection window (plus configurable pre/post padding)

This requires no changes to the ring buffer itself — `Snapshot()` already copies the full buffer, and the auto-capture logic would just add time-range trimming.

### Considerations for Auto-Capture

| Concern | Approach |
|---------|----------|
| Storage limits | Configurable max captures per stream, max total disk, evict oldest |
| Rapid fire | Minimum cooldown between auto-captures (e.g., 30 seconds) |
| Notification | WebSocket event to frontend: `{"type": "auto_capture", "capture": {...}}` |
| Pre-roll | Ring buffer naturally provides pre-roll — the snapshot includes data before the trigger |

---

## New Files

### Backend

| File | Purpose |
|------|---------|
| `internal/ringbuf/ringbuf.go` | Audio ring buffer implementation |
| `internal/ringbuf/ringbuf_test.go` | Tests for ring buffer |
| `internal/capture/writer.go` | Capture writer (manifest.json + audio.wav) |
| `internal/capture/writer_test.go` | Tests for capture writing |
| `internal/db/captures.go` | Capture CRUD operations |
| `internal/api/captures.go` | Capture REST endpoints |
| `migrations/NNNN_create_captures.up.sql` | Database migration |
| `migrations/NNNN_create_captures.down.sql` | Rollback migration |

### Frontend

| File | Purpose |
|------|---------|
| `frontend/src/components/playback/playback-engine.ts` | Audio playback engine (AudioWorklet-driven timing) |
| `frontend/src/components/playback/playback-controller.tsx` | Playback UI component (scrub bar, controls) |

---

## Implementation Order

| Step | Task | Scope | Depends On |
|------|------|-------|------------|
| 1 | `ringbuf.go` — audio ring buffer with `Write`, `Snapshot` | Backend | Nothing |
| 2 | Wire ring buffer into `streammgr` — write audio frames from pump, use `BufferMinutes` | Backend | Step 1 |
| 3 | `writer.go` — write manifest.json + audio.wav from snapshot | Backend | Step 1 |
| 4 | `captures.go` (DB) — create, list, get, delete captures | Backend | Nothing |
| 5 | Database migration for `captures` table | Backend | Nothing |
| 6 | `captures.go` (API) — POST capture, GET manifest/audio, DELETE | Backend | Steps 2-5 |
| 7 | Change `BufferMinutes` default from 15 to 5 in `createStream` | Backend | Nothing |
| 8 | `playback-engine.ts` — AudioWorklet-driven playback, seek | Frontend | Step 6 |
| 9 | `playback-controller.tsx` — scrub bar, play/pause, speed, back-to-live | Frontend | Step 8 |
| 10 | Integrate into `stream-player-page.tsx` — capture button, mode switching | Frontend | Steps 8-9 |

Steps 1, 4, 5, and 7 can be done in parallel. Steps 8-9 can begin once step 6 is done.

**Recommended sequencing:** Build steps 1-7 first. Get the ring buffer accumulating and captures writing to disk. Verify by downloading the WAV and playing it in Audacity, check the manifest JSON. Then tackle the frontend playback (steps 8-10), starting with basic 1x playback before adding speed control.

---

## Performance Budget

| Operation | Target | Notes |
|-----------|--------|-------|
| Ring buffer write (per frame) | < 1 μs | Single slice write + pointer advance |
| Snapshot (5 min buffer) | < 20 ms | ~7.2 MB copy under read lock |
| Capture write to disk | < 50 ms | WAV header + sequential PCM write |
| Manifest fetch (frontend) | < 10 ms | ~500 bytes JSON |
| Audio fetch (frontend) | < 300 ms | ~7.2 MB single fetch |
| Seek | < 0.1 ms | Direct byte offset math, no search needed |

---

## Known Hard Parts

These are the areas most likely to cause trouble during implementation:

1. **AudioWorklet playback timing.** The worklet must consume PCM at a steady rate and report its position back to the main thread. Getting the ring buffer management, speed changes, and seek right without audio glitches will take iteration. Start with 1x speed playback only, add speed control later.

2. **AudioWorklet state transition.** The existing `SdrAudioProcessor` worklet handles live audio. Playback mode needs it to switch between "accept live data from WebSocket" and "accept playback data from engine, report sample count." This state transition must be glitch-free — no pops when entering/exiting playback mode.

---

## Open Questions

1. **Compression** — Should we compress audio in the WAV file? Raw PCM16 is simple and fast but FLAC would cut size ~40%. For 5-minute captures (~7 MB), raw is fine. Worth revisiting if capture durations grow.

2. **Capture while in playback** — Should the ring buffer keep accumulating live data during playback? Yes — it runs independently. The user can capture again after returning to live.

3. **Multiple captures** — Should the UI allow browsing and replaying past captures? Yes, but the list/browse UI is a separate feature. This plan covers the capture + immediate playback flow.

4. **Shared captures** — In multi-user sessions (peers), should one user's capture be visible to others? Initially no — captures are per-session.

5. **Max capture duration** — The capture is always a snapshot of whatever is currently in the ring buffer (up to `BufferMinutes`). No continuous recording beyond the buffer window.

6. **Streaming playback for long captures** — For captures longer than ~30 minutes (~43 MB), loading the full WAV into an ArrayBuffer gets heavy. The audio endpoint supports range requests for future chunk-based streaming. Not needed for the default 5-minute window.
