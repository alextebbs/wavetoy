# ChunkRing: Unified Streaming Buffer

## What It Does

ChunkRing replaces the existing audio-only `ringbuf.RingBuffer` with a unified buffer that captures **audio, waterfall, and events** together in fixed-duration chunks. Every active stream gets a ChunkRing. It serves two purposes:

1. **For any stream:** a rolling 5-minute window of rewindable data, served to the frontend via HTTP. The user can scrub backwards through audio and waterfall history, and the waterfall is pre-populated on page load instead of starting blank.

2. **For monitored streams (MONITOR.md):** the same rolling window, plus completed chunks are uploaded to Tigris S3. The ChunkRing IS the recording pipeline — monitoring doesn't bolt on a separate recorder, it attaches an S3 sink to the existing buffer. The vertical timeline extends to represent hours or days of monitoring history.

### What changes for the user

**Today:** Open a stream page → blank waterfall fills from the bottom, row by row, over minutes. No way to rewind. The "Capture" button snapshots audio into a downloadable WAV file.

**After ChunkRing:** Open a stream page → waterfall is pre-populated with the last 5 minutes of history. A timeline bar lets you scrub backwards to hear audio and see waterfall data from any point in that window. When monitoring is later enabled (MONITOR.md), the same timeline extends to show hours or days of recorded history from S3.

---

## Why This Matters

### Problem 1: The blank waterfall

When a user opens a stream, the waterfall canvas is empty. It takes minutes of accumulation before the display shows useful context. If the stream has been running for 10 minutes with interesting signals, the user who just arrived sees none of it. The backend has been receiving those frames the entire time — it just throws them away after broadcasting to current subscribers.

### Problem 2: No rewind

Users frequently see something on the waterfall and want to hear what it sounded like. Currently, the only option is the "Capture" button, which downloads a WAV file from the audio ring buffer. There's no way to scrub backwards through the waterfall, no way to correlate audio with a specific moment on the waterfall display, and no integrated rewind experience.

### Problem 3: MONITOR.md needs a recording pipeline

MONITOR.md describes a recorder (`internal/monitor/recorder.go`) that subscribes to audio, waterfall, interpreter, and log channels, accumulates data into 5-minute chunks, and uploads them to S3. This is essentially the same thing as a ring buffer that retains chunks — the only difference is where completed chunks go (evicted from memory vs. uploaded to S3).

Building these as separate systems means duplicated accumulation logic, duplicated chunk formats, and duplicated serialization code. Building ChunkRing first means the monitoring recorder collapses into a ~100-line `S3Sink` implementation.

### The unified answer

| Capability | Old `ringbuf` | ChunkRing | ChunkRing + Monitoring |
|---|---|---|---|
| Audio buffering | Yes (5 min) | Yes (5 min) | Yes (5 min + S3) |
| Waterfall buffering | No | Yes (5 min) | Yes (5 min + S3) |
| Event buffering | No | Yes (5 min) | Yes (5 min + S3) |
| WF pre-fill on page load | No | Yes | Yes |
| Audio rewind | Capture → WAV download | Scrub in timeline | Scrub in timeline |
| WF rewind | No | Scrub in timeline | Scrub in timeline |
| Duration | Ring buffer only | Ring buffer | Ring buffer + S3 (30 days) |
| Capture (WAV download) | Snapshot from ring | Snapshot from chunks | Snapshot from chunks |

---

## Current State

| Component | Status |
|---|---|
| Audio ring buffer | `internal/ringbuf/ringbuf.go` — stores `AudioEntry{Timestamp, PCM}` frames, evicts by `maxAge` |
| WF buffering | None — `startWFPump()` broadcasts `kiwi.WFFrame` directly, no history kept |
| Event buffering | None — interpreter output and logs are forwarded via callbacks, no history in the stream pipeline |
| Capture | `POST /streams/{id}/capture` → `ringBuf.Snapshot()` → `capture.WriteWAV()` → downloads WAV |
| Frontend waterfall | `WaterfallRenderer.pushFrame(bins, xBin, zoom)` renders to canvas, frames scroll off the top and are gone |
| Frontend audio | PCM → resample → AudioWorklet ring buffer (3 sec at 48 kHz), no history |
| `BufferMinutes` field | Exists on `models.Stream`, defaults to 5, used to size the audio ring buffer |
| RINGBUFFER.md | Explicitly decided against WF buffering because frames are zoom-dependent |

### Why RINGBUFFER.md's WF objection doesn't apply

RINGBUFFER.md says: *"W/F frames are tied to a specific zoom level and center frequency. When the user changes zoom, historical W/F frames are useless."*

This is true for a pure-replay system where old frames must render at the new zoom level. But it's overblown for a rewind buffer, for two reasons:

1. **The common case is zoom stability.** When a user is actively monitoring a frequency, they've settled on a zoom level. The last 5 minutes of frames are almost always at the same zoom. The edge case (zoom changed mid-buffer) is rare during active listening.

2. **Each frame carries its own metadata.** `WFFrame` includes `XBin` and `Zoom`. During rewind, frames matching the current zoom render normally. Frames at a different zoom can be rendered with coordinate mapping, or that region can show a "zoom changed" indicator. Audio plays through regardless.

3. **Monitoring locks zoom entirely.** For monitored streams (MONITOR.md), zoom is fixed for the entire session. Every frame in every chunk is uniform. The WF rewind problem vanishes.

---

## Architecture

### Chunk model

Data is accumulated into fixed-duration **chunks**. Each chunk represents a 1-minute **wall-clock window** — it starts and ends on the rotation ticker regardless of how much data actually arrived. A chunk may contain less than a full minute of audio or fewer than ~480 WF frames if data was sparse or interrupted. The chunk's `StartedAt`/`EndedAt` timestamps define the window; the actual data within may have gaps.

During rewind playback, gaps within a chunk are rendered faithfully: missing WF rows appear as black space, missing audio is silence. The UI may show chunk boundaries as subtle markers on the timeline.

Typical chunk contents (full data):

```
Chunk (1-minute wall-clock window)
├── AudioPCM      []byte         ~1.44 MB   (PCM16, 12 kHz, mono)
├── WFFrames      []WFFrame      ~480 KB    (~8 fps × 1 KB/frame)
└── Events        []Event        ~few KB    (interpreter output + logs)

Total per chunk: ~2 MB (typical), less if data was sparse
```

### Ring behavior

The ChunkRing maintains a ring of completed chunks plus one in-progress chunk:

```
Ring (5 completed chunks + 1 in-progress):

   evicted ←  [chunk 0] [chunk 1] [chunk 2] [chunk 3] [chunk 4]  [chunk 5 ···]
               1 min ago  2 min    3 min     4 min     5 min ago   in-progress
               ▲ newest completed                      ▲ oldest    ▲ accumulating
```

When the in-progress chunk reaches 1 minute of elapsed time:

1. Finalize it (set end timestamp).
2. Push into the ring (evict the oldest completed chunk if full).
3. If an S3 sink is attached (monitoring): `sink.OnChunkComplete(chunk)`.
4. Allocate a new in-progress chunk.

### Data flow

```
KiwiSDR
  ├─ /SND → kiwi.Client → pcm channel ──────────┐
  │                                               ▼
  │                                    ┌──────────────────────┐
  │                                    │ streammgr.startPump  │
  │                                    │                      │
  │                                    │  filtered ──┬──→ broadcast(subscribers)
  │                                    │             │
  │                                    │             └──→ chunkRing.WriteAudio(ts, filtered)
  │                                    └──────────────────────┘
  │
  └─ /W/F → kiwi.WFClient → frames channel ─────┐
                                                  ▼
                                       ┌──────────────────────┐
                                       │ streammgr.startWFPump│
                                       │                      │
                                       │  frame ──┬──→ broadcastWF(wfSubscribers)
                                       │          │
                                       │          └──→ chunkRing.WriteWF(ts, frame)  ← NEW
                                       └──────────────────────┘

  Interpreter output callback ──→ chunkRing.WriteEvent(ts, ...)  ← NEW
  Stream log callback ──────────→ chunkRing.WriteEvent(ts, ...)  ← NEW
```

Compared to the old `ringbuf`, the only changes in `streammgr` are:
- Replace `ringBuf *ringbuf.RingBuffer` with `chunkRing *chunkring.ChunkRing`.
- Add `chunkRing.WriteWF()` in `startWFPump()` (the WF pump currently does no buffering).
- Add `chunkRing.WriteEvent()` in the interpreter output and log callbacks.

### Serving data

```
Frontend                          Backend                        Tigris S3
   │                                │                               │
   │  GET /streams/{id}/rewind      │                               │
   │ ─────────────────────────────→ │                               │
   │  (chunk metadata)              │                               │
   │ ←───────────────────────────── │                               │
   │                                │                               │
   │  GET /streams/{id}/rewind/     │                               │
   │      {index}/audio             │                               │
   │ ─────────────────────────────→ │                               │
   │  (WAV from ring)               │  (serves from memory)        │
   │ ←───────────────────────────── │                               │
   │                                │                               │
   │  (monitoring: older chunks)    │                               │
   │  GET /monitor/sessions/        │                               │
   │      {id}/chunks?from=N        │                               │
   │ ─────────────────────────────→ │                               │
   │  (pre-signed S3 URLs)          │                               │
   │ ←───────────────────────────── │                               │
   │                                                                │
   │  fetch(pre-signed URL)                                         │
   │ ─────────────────────────────────────────────────────────────→ │
   │  (WAV from S3)                                                 │
   │ ←───────────────────────────────────────────────────────────── │
```

The frontend uses the same chunk format regardless of source. It doesn't need to know whether a chunk came from the in-memory ring or from S3.

### Extension to monitoring

When monitoring starts on a stream, the only change is attaching an S3 sink:

```
Regular stream:

    chunkRing.WriteAudio() ──→ accumulate ──→ rotate ──→ ring (keep last 5)
    chunkRing.WriteWF()                                    └── evict oldest

Monitored stream:

    chunkRing.WriteAudio() ──→ accumulate ──→ rotate ──→ ring (keep last 5)
    chunkRing.WriteWF()                                    ├── evict oldest
                                                           └── sinkCh <- chunk (non-blocking)
                                                                └── sink worker goroutine
                                                                     └── S3 PutObject
                                                                     └── UPDATE monitor_sessions
```

The MONITOR.md recorder (`AudioChunkWriter`, `WFChunkWriter`, `EventChunkWriter`, `SessionUpdater`) collapses into a single `S3Sink` implementation. All accumulation, chunking, rotation, and serialization logic lives in ChunkRing and is shared with the rewind feature.

---

## Chunk Duration: 1 Minute

MONITOR.md specified 5-minute chunks for S3 upload efficiency. ChunkRing uses 1-minute chunks instead. This is better for both the rewind feature and monitoring:

| | 1-min chunks | 5-min chunks |
|---|---|---|
| Chunk size | ~2 MB | ~10 MB |
| Fetch latency (over internet) | < 200ms | < 500ms |
| Ring memory (5-min window) | 5 × 2 MB = 10 MB | 1 × 10 MB = 10 MB |
| Near-live gap (monitoring) | 0–60 sec | 0–5 min |
| Seek granularity | 1 minute | 5 minutes |
| S3 PUTs/day (monitoring) | 4,320 | 864 |
| S3 PUT cost/month/stream | ~$0.65 | ~$0.13 |

Same memory. Better UX. The S3 cost difference ($0.52/month/stream) is negligible against Tigris pricing ($0.005/1000 Class A requests, first 10K free/month).

The near-live gap improvement is significant. MONITOR.md's known hard part #7 noted that the DVR timeline's right edge is the last completed S3 chunk — up to 5 minutes behind live. With 1-minute chunks served from the ring, the gap shrinks to at most 60 seconds. And the in-progress chunk can be served too (see "Serving the in-progress chunk" below), eliminating the gap entirely.

---

## Data Rates

### Audio (PCM16, 12 kHz mono)

| Period | Size |
|---|---|
| 1 second | 24 KB |
| 1 minute (1 chunk) | 1.44 MB |
| 5 minutes (full ring) | 7.2 MB |

### Waterfall (~8 fps, ~1 KB/frame)

| Period | Size |
|---|---|
| 1 second | ~8 KB |
| 1 minute (1 chunk) | ~480 KB |
| 5 minutes (full ring) | ~2.4 MB |

### Events (interpreter output + logs)

Negligible — tens of KB per hour at most.

### Total per chunk

| Component | Size |
|---|---|
| Audio | 1.44 MB |
| Waterfall | ~480 KB |
| Events | < 10 KB |
| **Total** | **~2 MB** |

### Memory budget per stream

5 completed chunks + 1 in-progress ≈ 12 MB per active stream. For 5 concurrent streams (tenant cap): ~60 MB. Well within a Fly machine's memory.

---

## Backend: `internal/chunkring/`

New package. Replaces `internal/ringbuf/`.

### `chunkring.go` — core types and ring management

```go
type WFFrame struct {
    TimestampMs int64
    Bins        []byte
    XBin        uint32
    Zoom        uint16
}

type Event struct {
    TimestampMs int64
    Type        string          // "log", "interpreter", "source_switch"
    Data        json.RawMessage
}

type Chunk struct {
    Index      int
    StartedAt  time.Time
    EndedAt    time.Time
    Complete   bool

    AudioPCM   []byte    // contiguous PCM16 samples
    SampleRate int

    WFFrames   []WFFrame
    Events     []Event
}
```

```go
type ChunkSink interface {
    OnChunkComplete(chunk *Chunk) error
}

type ChunkRing struct {
    streamID   string
    chunkDur   time.Duration   // 1 minute
    sampleRate int

    mu        sync.RWMutex
    ring      []*Chunk         // completed chunks, circular
    ringSize  int              // 5
    ringHead  int
    ringCount int
    current   *Chunk           // in-progress, accumulating

    sink      ChunkSink        // nil for regular streams, S3Sink for monitoring
    sinkCh    chan *Chunk       // buffered channel for async sink delivery (cap 3)

    ticker    *time.Ticker     // fires every chunkDur for wall-clock rotation
    done      chan struct{}     // signals the rotation goroutine to stop

    // Stats
    totalChunks   int64
    totalBytes    int64
}
```

#### Key methods

| Method | Purpose |
|---|---|
| `New(streamID string, chunkDur time.Duration, ringSize int, sampleRate int) *ChunkRing` | Create a ring and start the background rotation ticker. Caller must call `Close()` when done. |
| `WriteAudio(ts time.Time, pcm []byte)` | Append PCM16 to the current chunk. |
| `WriteWF(ts time.Time, bins []byte, xBin uint32, zoom uint16)` | Append a waterfall frame to the current chunk. |
| `WriteEvent(ts time.Time, typ string, data json.RawMessage)` | Append an event (interpreter output, log entry, source switch). |
| `SetSink(sink ChunkSink)` | Attach/detach an S3 sink. When a non-nil sink is set, starts the sink worker goroutine. |
| `GetChunk(index int) *Chunk` | Get a completed chunk by index. Returns nil if evicted. |
| `GetCurrent() *Chunk` | Get the in-progress chunk (snapshot under read lock). |
| `Available() []ChunkMeta` | Metadata for all available chunks (completed + in-progress). |
| `SnapshotAudio() []byte` | Concatenate all audio from the ring into a contiguous PCM buffer (for capture compatibility). |
| `Reset()` | Clear all chunks. |
| `Close()` | Stop the rotation ticker, close the sink channel, wait for the sink worker to drain. Must be called when the stream stops. |

#### Rotation

Chunks represent fixed 1-minute wall-clock windows. Rotation is driven by a background `time.Ticker`, not by data arrival. This guarantees chunks are finalized on schedule even if audio or waterfall data stalls or stops entirely. A chunk that received no data during its window is still finalized (as an empty chunk) and pushed into the ring.

`New()` starts a background goroutine that owns the ticker:

```go
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
    defer cr.mu.Unlock()

    now := time.Now()
    cr.current.EndedAt = now
    cr.current.Complete = true

    // Push into ring
    cr.ring[cr.ringHead] = cr.current
    cr.ringHead = (cr.ringHead + 1) % cr.ringSize
    if cr.ringCount < cr.ringSize {
        cr.ringCount++
    }
    cr.totalChunks++

    // Deliver to sink via buffered channel (non-blocking — drop if full)
    if cr.sink != nil {
        select {
        case cr.sinkCh <- cr.current:
        default:
            // Sink is backed up — drop chunk. S3Sink logs the drop.
        }
    }

    // Start new chunk with pre-allocated buffers
    cr.current = &Chunk{
        Index:      int(cr.totalChunks),
        StartedAt:  now,
        SampleRate: cr.sampleRate,
        AudioPCM:   make([]byte, 0, cr.sampleRate*2*60),
        WFFrames:   make([]WFFrame, 0, 512),
    }
}
```

The sink channel is consumed by a dedicated worker goroutine (started on `SetSink` when a non-nil sink is provided):

```go
func (cr *ChunkRing) runSinkWorker() {
    for chunk := range cr.sinkCh {
        if err := cr.sink.OnChunkComplete(chunk); err != nil {
            if err := cr.sink.OnChunkComplete(chunk); err != nil {
                // Log and discard — matches MONITOR.md's failure policy
            }
        }
    }
}
```

This bounds S3 upload concurrency to 1, provides natural backpressure, and drops chunks cleanly when the sink can't keep up. `Close()` closes the `done` channel (stopping the ticker goroutine) and closes `sinkCh` (draining the sink worker).

### `serialize.go` — chunk serialization

Chunks are serialized **on demand** when served via HTTP or uploaded to S3. The in-memory representation is raw (no WAV headers, no binary framing during accumulation). Serialization is lazy.

#### Audio → WAV

```go
func SerializeAudioWAV(chunk *Chunk) []byte
```

Writes a standard PCM16 mono WAV: 44-byte header + `chunk.AudioPCM`. Same format as `internal/capture/wav.go`, but operates on a `Chunk` instead of a `Snapshot`.

For the in-progress chunk, the WAV header's `data` size is computed from the current length of `AudioPCM`. The resulting WAV is valid but shorter than a full-duration chunk.

#### Waterfall → binary

```go
func SerializeWF(chunk *Chunk) []byte
```

Writes the binary format from MONITOR.md:

```
For each frame:
  [timestamp_ms  uint64 LE]   8 bytes
  [xbin          uint32 LE]   4 bytes
  [zoom          uint16 LE]   2 bytes
  [num_bins      uint16 LE]   2 bytes
  [bins          uint8[]]     num_bins bytes
```

This is the same format that S3 waterfall chunks will use in monitoring mode. The frontend has a single parser for both sources.

Adding `xbin` and `zoom` per frame (vs. MONITOR.md's simpler format without them) is necessary because regular streams may change zoom. For monitoring, where zoom is locked, these fields are constant across all frames but still present for format uniformity.

#### Events → JSONL

```go
func SerializeEvents(chunk *Chunk) []byte
```

Newline-delimited JSON. Same format as MONITOR.md's event chunks:

```json
{"t": 1710500000123, "type": "log", "level": "info", "action": "connected", "msg": "Connected to KiwiSDR"}
{"t": 1710500005456, "type": "interpreter", "interpreter": "voice", "text": "CQ CQ CQ this is..."}
```

### `s3sink.go` — monitoring extension (built later, for MONITOR.md)

```go
type S3Sink struct {
    s3Client  *s3.Client
    prefix    string          // e.g. "prod/sessions/{id}/"
    db        *db.Queries
    sessionID string
}

func (s *S3Sink) OnChunkComplete(chunk *Chunk) error {
    // Serialize audio, WF, events
    // PutObject for each
    // UPDATE monitor_sessions SET chunks, size_bytes, duration_sec
}
```

This is the entirety of MONITOR.md's recording pipeline. ~100 lines. All the hard work (subscribing to channels, accumulating frames, timing rotations, serializing formats) already happened in ChunkRing.

---

## Serving the In-Progress Chunk

The in-progress chunk (`current`) is being actively written to. It can still be served:

1. Take `RLock` on the ChunkRing.
2. Copy `current.AudioPCM`, `current.WFFrames`, `current.Events`.
3. Release lock.
4. Serialize the copies (WAV header computed from the actual data length).
5. Serve.

Lock contention: `WriteAudio` appends a ~1 KB frame under the lock (~1 μs). Copying the in-progress chunk's data (~1 MB worst case) takes < 1ms. At ~24 audio frames/sec, one frame arrives every ~42ms. No meaningful contention.

This eliminates the near-live gap entirely. The frontend can fetch the in-progress chunk to get data up to the most recent second, not just the most recent completed chunk.

---

## Integration with `streammgr`

### Replacing `ringBuf`

In `activeStream`:

```go
type activeStream struct {
    // ...
    chunkRing *chunkring.ChunkRing  // replaces ringBuf
    // ringBuf *ringbuf.RingBuffer  — REMOVED
}
```

### Creation (in stream startup)

```go
bufMinutes := stream.BufferMinutes
if bufMinutes <= 0 {
    bufMinutes = 5
}
chunkDur := 1 * time.Minute
ringSize := bufMinutes  // 5 chunks for 5-minute window

as := &activeStream{
    // ...
    chunkRing: chunkring.New(stream.ID, chunkDur, ringSize, sampleRate),
}
```

### Audio pump (`startPump`)

Replace:

```go
if as.ringBuf != nil {
    as.ringBuf.Write(time.Now(), filtered)
}
```

With:

```go
as.chunkRing.WriteAudio(time.Now(), filtered)
```

### Waterfall pump (`startWFPump`)

After `as.broadcastWF(frame)`, add:

```go
as.chunkRing.WriteWF(time.Now(), frame.Bins, frame.XBin, frame.Zoom)
```

This is the key new line. WF frames are now buffered for the first time.

### Interpreter output

In `notifyInterpreterOutput`, also forward to ChunkRing:

```go
func (m *Manager) notifyInterpreterOutput(streamID string, output interpreter.Output) {
    // existing callback...
    if as, ok := m.streams[streamID]; ok {
        data, _ := json.Marshal(output)
        as.chunkRing.WriteEvent(time.Now(), "interpreter", data)
    }
}
```

### Stream logs

Wire the stream log callback to also forward to ChunkRing:

```go
streamLog.SetOnEmit(func(entry streamlog.Entry) {
    data, _ := json.Marshal(entry)
    as.chunkRing.WriteEvent(time.Now(), "log", data)
})
```

This requires adding a per-stream emit callback to `streamlog.Logger` (currently it only has subscriber channels). A simple `OnEmit func(Entry)` field on `streamLog` suffices.

### Capture compatibility

The existing `CaptureAudio()` method is reimplemented:

```go
func (m *Manager) CaptureAudio(streamID string) (*ringbuf.Snapshot, error) {
    // ...
    pcm := as.chunkRing.SnapshotAudio()
    // Build a Snapshot from the concatenated PCM for capture.WriteWAV compatibility
}
```

The `POST /streams/{id}/capture` endpoint continues to work unchanged. It still downloads a WAV file. The backing store is different (ChunkRing instead of RingBuffer), but the API and output format are identical.

---

## API

### Rewind metadata

```
GET /api/streams/{id}/rewind
```

Returns what's available in the ring:

```json
{
  "stream_id": "stream-uuid",
  "sample_rate": 12000,
  "chunks": [
    {
      "index": 42,
      "started_at": "2026-03-17T10:00:00.000Z",
      "ended_at": "2026-03-17T10:01:00.000Z",
      "complete": true,
      "audio_bytes": 1440000,
      "wf_frames": 482,
      "events": 3,
      "wf_zoom": 10,
      "wf_zoom_changed": false
    },
    {
      "index": 43,
      "started_at": "2026-03-17T10:01:00.000Z",
      "ended_at": "2026-03-17T10:02:00.000Z",
      "complete": true,
      "audio_bytes": 1440000,
      "wf_frames": 479,
      "events": 0,
      "wf_zoom": 10,
      "wf_zoom_changed": false
    },
    {
      "index": 47,
      "started_at": "2026-03-17T10:05:12.000Z",
      "ended_at": null,
      "complete": false,
      "audio_bytes": 720000,
      "wf_frames": 241,
      "events": 1,
      "wf_zoom": 10,
      "wf_zoom_changed": false
    }
  ]
}
```

The `wf_zoom` and `wf_zoom_changed` fields let the frontend decide whether to render WF data for a chunk. If `wf_zoom_changed` is true, the chunk contains frames at multiple zoom levels — the frontend can still render them but should expect resolution changes.

### Chunk data

```
GET /api/streams/{id}/rewind/{index}/audio    → audio/wav
GET /api/streams/{id}/rewind/{index}/wf       → application/octet-stream
GET /api/streams/{id}/rewind/{index}/events   → application/x-ndjson
```

Serves from the in-memory ring. Works for both completed and in-progress chunks. Returns 404 if the chunk index has been evicted from the ring.

Response headers include `X-Chunk-StartedAt` and `X-Chunk-Complete` for the frontend to track freshness.

### WebSocket notification

When a new chunk completes, broadcast to stream subscribers:

```json
{
  "type": "chunk_complete",
  "index": 43,
  "started_at": "2026-03-17T10:01:00.000Z",
  "ended_at": "2026-03-17T10:02:00.000Z"
}
```

The frontend uses this to know when new chunk data is available for the rewind timeline without polling.

---

## Frontend

### Waterfall pre-fill on page load

When a stream page loads:

1. WebSocket connects, live audio + WF frames start flowing.
2. In parallel, fetch `GET /api/streams/{id}/rewind` → chunk metadata.
3. Fetch WF chunks for available history: `GET /api/streams/{id}/rewind/{index}/wf`.
4. Parse the binary WF format into an array of frames.
5. Render historical frames onto the waterfall canvas **above** the live frames.
6. Live frames continue seamlessly from where the chunks end.

The user sees a full, populated waterfall from the moment the page opens. No blank canvas.

This also naturally solves **reconnection gaps**. If the WebSocket drops for 30 seconds and reconnects, the frontend can fetch the chunk(s) covering the gap from the ring and stitch them in. No more blank bands from network hiccups.

### Vertical rewind timeline

The rewind control is a **vertical timeline** alongside the waterfall, sharing its Y axis. The waterfall is inherently temporal — time flows downward, new frames appear at the bottom, old frames scroll up. The rewind timeline matches this axis rather than introducing a separate horizontal bar.

```
Regular stream (5-min rewind window):

                    Waterfall                    │ Timeline
  ┌─────────────────────────────────────────────┐│
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││ 5m ago
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││ 4m ago
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││ 3m ago
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││ 2m ago
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││ 1m ago
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││
  │  ░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░░░░░░░░  ││ ● LIVE
  └─────────────────────────────────────────────┘│
```

The timeline is a thin vertical track (8–12px wide) on the right edge of the waterfall. It shows:

- **A filled region** representing the available history (how much data the ring holds).
- **A handle/indicator** showing the current playback position.
- **"LIVE" label** at the bottom edge when the handle is at the present.
- **Time labels** at intervals along the track (e.g., "1m ago", "3m ago").

**Interaction:**
- **Drag the handle upward** to rewind. The waterfall scrolls to show historical data at that position. Audio plays from the corresponding chunk.
- **Scroll wheel on the waterfall** also scrubs through time — scrolling up enters rewind mode, revealing older data above. This is the natural gesture: "scroll up to see the past" matches the waterfall's existing visual metaphor.
- **Click anywhere on the timeline track** to jump to that time position.
- **"LIVE" button** at the bottom snaps back to the present.

For monitoring mode (MONITOR.md), this same vertical timeline extends to represent hours or days of session data. The track becomes a minimap of the full recording history — sessions as solid regions, gaps as hatched regions — maintaining the same vertical orientation.

### State machine

```
                  user scrolls up / drags handle
    LIVE ──────────────────────────────────────→ REWIND
     │                                              │
     │     user clicks "LIVE" or scrolls to bottom  │
     ◄──────────────────────────────────────────────┘
```

**LIVE mode** (current behavior):
- Live audio plays through speakers (WebSocket → AudioWorklet).
- Live waterfall renders from WebSocket frames, scrolling downward.
- Timeline handle sits at the bottom edge.

**REWIND mode:**
- The waterfall shows historical frames from chunk data at the selected position.
- Recorded audio plays from the chunk at that position (or is paused).
- Live data continues to flow in the background (WebSocket stays open, the ChunkRing keeps accumulating, the ring keeps rotating). The live edge of the timeline continues to grow downward.
- A "LIVE" pill glows at the bottom to invite the user back.
- Play/pause button for recorded audio appears in the waterfall area.
- Clicking "LIVE" or scrolling to the bottom snaps back to real-time, crossfades to live audio, and resumes live waterfall rendering.

### Chunk loader

A unified chunk loader that abstracts the data source:

```typescript
interface ChunkSource {
  fetchAudio(index: number): Promise<ArrayBuffer>;
  fetchWF(index: number): Promise<ArrayBuffer>;
  fetchEvents(index: number): Promise<string>;
}

class RingBufferSource implements ChunkSource {
  // Fetches from /api/streams/{id}/rewind/{index}/...
}

class S3Source implements ChunkSource {
  // Fetches from pre-signed Tigris URLs (monitoring, added later)
}
```

The chunk loader maintains a sliding window: current chunk ± 1 neighbor loaded. Prefetch the next chunk when playback reaches 80% of the current chunk. Evict chunks more than 2 positions away.

For the in-progress chunk (at the right edge of the timeline), the loader re-fetches periodically to get updated data, or waits for the `chunk_complete` WebSocket event.

### Chunk parsers

**Audio:** Skip 44-byte WAV header, read PCM16 samples. Seeking within a chunk: sample at time T is at byte `44 + floor(T × sampleRate) × 2`.

**Waterfall:** Parse the binary format frame by frame:

```typescript
function parseWFChunk(buffer: ArrayBuffer): WFFrame[] {
  const view = new DataView(buffer);
  const frames: WFFrame[] = [];
  let offset = 0;
  while (offset < buffer.byteLength) {
    const timestampMs = Number(view.getBigUint64(offset, true));
    const xBin = view.getUint32(offset + 8, true);
    const zoom = view.getUint16(offset + 12, true);
    const numBins = view.getUint16(offset + 14, true);
    const bins = new Uint8Array(buffer, offset + 16, numBins);
    frames.push({ timestampMs, xBin, zoom, bins: new Uint8Array(bins) });
    offset += 16 + numBins;
  }
  return frames;
}
```

**Events:** Split by newline, `JSON.parse` each line.

These parsers are identical regardless of whether the chunk came from the ring buffer or S3.

### Waterfall renderer rewrite: virtualized tiles

The current `WaterfallRenderer` cannot support rewind. It must be substantially rewritten. Here's why, and what replaces it.

#### Why the current renderer can't be extended

The current renderer (`waterfall-renderer.ts`) is a fixed-size scroll buffer:

1. **Single offscreen canvas** (`historySize = 4096` rows, 1024 bins wide). New frames are rendered by shifting the entire canvas down 1px via `drawImage` self-copy, then drawing the new row at y=0.
2. **No viewport offset.** The visible canvas always shows the most recent rows from the top of the offscreen canvas. There's no scroll position — the renderer has no concept of "show me rows from 3 minutes ago."
3. **`rawBins` array** stores raw bin data for re-rendering when color levels change, but it's bounded to `historySize` and indexed from the top of the offscreen canvas. It's not addressable by timestamp.
4. **Background layers** handle zoom changes by freezing the current offscreen as a `WFLayer`. These layers are composited during `blitToVisible()` and pruned when they scroll off the bottom. They're not designed for random access.
5. **Self-copy shift** (`drawImage` of the canvas onto itself, offset by 1px) runs on every frame. For a 1024×4096 canvas, this copies ~4 MB per frame at ~8 fps = ~32 MB/s of GPU memory bandwidth. It works, but it's an inherently live-only pattern.

Bolting rewind onto this would require: adding a scroll offset to `blitToVisible`, making `rawBins` addressable by time, loading historical bins from chunk data, and handling the case where the viewport spans both live and historical data. Every one of these changes conflicts with the existing architecture's assumptions. A rewrite is cleaner than a retrofit.

#### Replacement: tile-based virtualized renderer

The new renderer uses a **tile system** inspired by map renderers (Leaflet, Mapbox) and virtualized list renderers (react-virtuoso). The waterfall has a virtual height spanning all available history. Only tiles near the viewport are rendered into canvases. Everything else is evicted.

```
Virtual waterfall (all available history):

  Row 0    ┌─────────────┐  ← oldest row in ring buffer (5 min ago)
           │  Tile 0     │  256 rows, rendered from chunk data
           │             │
  Row 256  ├─────────────┤
           │  Tile 1     │  256 rows, rendered from chunk data
           │             │
  Row 512  ├─────────────┤
           │  Tile 2     │  (not rendered — off-screen, evicted)
           │             │
  Row 768  ├─────────────┤
           │  Tile 3     │  (not rendered — off-screen, evicted)
           │             │
           │    ...       │
           │             │
  Row 2048 ├─────────────┤
           │  Tile 8     │  256 rows, rendered (near viewport)
           │  ┌────────┐ │
           │  │VIEWPORT│ │  ← visible area (~300-500 rows at rowScale=3)
           │  │        │ │
           │  └────────┘ │
  Row 2304 ├─────────────┤
           │  Tile 9     │  256 rows, live tile — new frames append here
           │  (partial)  │
  Row ~2400└─────────────┘  ← live edge (present moment)
```

**Core concepts:**

- **Virtual row space.** The virtual space is time-based: each row corresponds to a fixed time increment (125ms, matching the ~8fps nominal frame rate). Row positions are derived from timestamps, not from frame arrival order. A chunk's 1-minute wall-clock window maps to a fixed 480 rows regardless of how many frames actually arrived. Rows with no corresponding frame data render as black. Row 0 is the oldest available time. The live edge is the highest row index, advancing with wall-clock time. Chunk boundaries fall on predictable row positions (every 480 rows), and the UI may render them as subtle horizontal markers.
- **Tiles.** The virtual space is divided into fixed-height tiles (e.g., 256 rows). Each tile is an offscreen canvas (1024 × 256 pixels) plus a `rawBins` array for re-rendering when levels change. Tiles are rendered once from their source data (raw bins from live frames or parsed from chunk binary data), then cached. Rows within a tile that have no frame data are left black.
- **Viewport.** The visible area is defined by a scroll offset (measured in rows from the live edge). Offset 0 = LIVE. Offset 480 = showing data from ~60 seconds ago (at the nominal 8fps row rate). The viewport height in rows = `visibleCanvas.height / rowScale`.
- **Tile loading.** Only tiles that overlap the viewport (plus ±1 tile buffer zone) are rendered. When the viewport moves (scroll or live advance), newly visible tiles are rendered and off-screen tiles are evicted. For historical tiles, the raw bins come from parsed WF chunk data fetched from the backend. Each frame carries a timestamp, and the tile renderer places it at the correct row position within the tile using `(frame.timestampMs - tileStartMs) / 125`.
- **Live tile.** The bottommost tile receives new frames via `pushFrame()`. Unlike the old renderer, new frames are appended at their timestamp-derived row position within the tile — no canvas self-copy shift. When the tile fills up (256 rows of wall-clock time = 32 seconds), it becomes a completed tile and a new live tile starts.

**Key differences from current renderer:**

| Aspect | Current renderer | Virtualized renderer |
|---|---|---|
| History capacity | 4096 rows (~8 min) | Unlimited (constrained by ring buffer / S3) |
| Offscreen canvas | 1 × 1024×4096 (4 MB) | N × 1024×256 tiles (~256 KB each), loaded on demand |
| New frame rendering | Self-copy shift entire canvas + draw at y=0 | Append at next row in live tile, no shifting |
| Viewport | Always at live edge | Scroll offset, 0 = live, >0 = history |
| Random access | Not possible | Tile at any position, loaded from chunk data |
| Re-render (level change) | Re-render all 4096 rows from `rawBins` | Re-render only visible tiles |
| Zoom change | Freeze canvas as background layer | Tile boundary aligns with zoom change; old tiles carry zoom metadata |
| Memory | Fixed ~4 MB + rawBins | Proportional to loaded tiles, ~2-5 MB typical |

**What is preserved:**

- `pushFrame(bins, xBin, zoom)` — same public API for live frames. Internally dispatches to the live tile.
- `colorMapLine(bins)` — same LUT-based bin → RGBA conversion.
- `blitToVisible()` — same compositing concept, but now composites visible tiles onto the visible canvas with the viewport offset.
- `setView(startKHz, endKHz)` — same frequency-axis viewport mapping.
- `autoLevel` / `setLevels` — same level detection and color mapping logic.
- Time labels — same concept, positioned by row offset.

**What changes:**

- `renderToOffscreen` → gone. Replaced by tile append + per-tile `renderRow`.
- `rawBins` (monolithic array) → per-tile `rawBins` arrays.
- Background layers (`WFLayer[]`) → gone. Zoom changes are handled by tile metadata — each tile knows its `xBin`/`zoom`, and tiles at different zooms coexist in the virtual space.
- `flush()` → still drains the live queue, but appends to the live tile instead of shifting the canvas.
- `blitToVisible()` → iterates over tiles overlapping the viewport, composites each tile's canvas into the visible canvas at the correct offset.
- `resize()` → may trigger loading/evicting tiles based on new viewport size.

#### Tile lifecycle

```
  Chunk data fetched     ┌──────────┐     Tile rendered     ┌──────────┐
  from backend       ──→ │ rawBins  │ ──→ (colorMapLine     │  canvas  │
  (parseWFChunk)         │ per tile │     per row)           │ 1024×256 │
                         └──────────┘                        └──────────┘
                                                                  │
                         Viewport moves away ──→ canvas evicted, rawBins kept
                         Viewport returns    ──→ re-render from rawBins
                         Too far from viewport ──→ rawBins also evicted
                         Level change        ──→ re-render visible tiles from rawBins
```

Tiles near the viewport keep both `rawBins` and the rendered canvas. Tiles further out keep only `rawBins` (for fast re-render if the user scrolls back). Tiles very far out are fully evicted and must be re-fetched from chunk data if needed again.

#### Integration with chunk loader

The tile system needs raw bin data to render historical tiles. This data comes from WF chunks fetched from the backend:

1. User scrolls up → viewport moves into historical territory.
2. The tile manager identifies which tiles need rendering.
3. For each needed tile, determine which chunk(s) contain the relevant frames (by timestamp → chunk index → frame offset within chunk).
4. Request the chunk from the chunk loader (which may already have it cached).
5. Parse the binary WF format into `WFFrame[]`.
6. Map frames to tile rows, populate `rawBins`, render the tile canvas.

The chunk loader is shared between the waterfall tile system and the audio playback engine. Both fetch from the same chunks — the tile system uses the WF data, the playback engine uses the audio data.

#### Scroll behavior

- **Scroll wheel on the waterfall** adjusts the viewport offset. Scrolling up increases the offset (further into history). Scrolling down decreases it. When the offset reaches 0, the renderer snaps to LIVE mode and the viewport tracks the live edge.
- **During audio playback in rewind mode**, the viewport scrolls downward automatically at the recorded frame rate, following the audio playback position. The waterfall scrolls exactly as it does in live mode — same visual speed — but fed from historical tile data.
- **The vertical timeline** reflects the viewport's scroll position within the total available history. Dragging the timeline handle sets the viewport offset directly.

### Audio playback in rewind mode

The same AudioWorklet challenge identified in RINGBUFFER.md. The worklet needs to switch between two modes:

**Live mode:** receives PCM via `port.postMessage` from the WebSocket handler.

**Playback mode:** receives PCM from the chunk loader. The playback engine:
1. Loads the WAV chunk, skips the 44-byte header.
2. Queues PCM samples into the AudioWorklet's ring buffer.
3. The worklet reports consumed sample count back to the main thread via `port.postMessage`.
4. Main thread updates the timeline position: `currentTime = samplesConsumed / sampleRate`.
5. When the current chunk's audio is exhausted, load the next chunk and continue queuing.

The transition from live to playback (and back) must be glitch-free — brief fade-out of live audio, fade-in of recorded audio (and vice versa).

---

## Zoom Change Handling

During rewind, the waterfall may contain frames at different zoom levels if the user changed zoom within the buffer window.

### Detection

Each chunk's metadata includes `wf_zoom` (the zoom level at chunk start) and `wf_zoom_changed` (whether zoom changed during the chunk). The rewind metadata endpoint provides this per-chunk, so the frontend knows before fetching whether a chunk has mixed zoom data.

### Rendering strategy

1. **Same zoom as current view:** render the frame normally using `pushFrame(bins, xBin, zoom)` — the existing renderer already handles `xBin` and `zoom` per frame.
2. **Different zoom from current view:** the frame covers a different frequency range and resolution. Two options:
   - **Option A (simple):** show a hatched/dimmed band for that row with a label "zoom was different." Audio still plays.
   - **Option B (better):** render the frame at its native zoom, which means it covers a different frequency width in the waterfall. The renderer maps the frame's frequency range to pixel coordinates using the existing `frameStart`/`frameEnd` calculation in `pushFrame()`. The result is a row that's either wider or narrower than the current view — wider means some bins are off-screen (clipped), narrower means gaps on the sides. This is what the renderer already does when `setDataCoverage` is called with new values.

Option B works with zero renderer changes — `pushFrame` already computes `frameStart` and `frameEnd` from `xBin` and `zoom`, and calls `setDataCoverage` when they change. The historical frames would trigger `setDataCoverage` on each zoom change, and the renderer would handle it. The visual result is imperfect (resolution changes in the waterfall image) but accurate and functional.

For the MVP, option A is simpler. For monitoring (zoom locked), this entire section is irrelevant.

---

## Migration from `ringbuf`

### Backend

| Before | After |
|---|---|
| `internal/ringbuf/ringbuf.go` | `internal/chunkring/chunkring.go` |
| `internal/ringbuf/ringbuf_test.go` | `internal/chunkring/chunkring_test.go` |
| `internal/capture/wav.go` | `internal/chunkring/serialize.go` (WAV serialization moves here) |
| `as.ringBuf *ringbuf.RingBuffer` | `as.chunkRing *chunkring.ChunkRing` |
| `as.ringBuf.Write(ts, filtered)` | `as.chunkRing.WriteAudio(ts, filtered)` |
| `as.ringBuf.Snapshot(...)` | `as.chunkRing.SnapshotAudio()` |

The `internal/ringbuf/` package is deleted after migration. The `internal/capture/` package retains only `WriteWAV` if needed for the capture endpoint, or it can call `chunkring.SerializeAudioWAV()` directly.

### Capture endpoint

`POST /streams/{id}/capture` continues to work. Internally, instead of calling `ringBuf.Snapshot()`, it calls `chunkRing.SnapshotAudio()` which concatenates audio from all available chunks. The output is the same: a WAV file download. The API contract is unchanged.

### Frontend

No breaking changes. The existing capture button continues to work. The rewind timeline and playback engine are additive — new components, not modifications to existing ones.

---

## Implementation Order

### Phase 1: Backend ChunkRing (replaces ringbuf)

| # | Task | Notes |
|---|---|---|
| 1 | `internal/chunkring/chunkring.go` — `ChunkRing` struct, `New`, `WriteAudio`, `WriteWF`, `WriteEvent`, ring management, rotation | Core data structure. Tests. |
| 2 | `internal/chunkring/serialize.go` — `SerializeAudioWAV`, `SerializeWF`, `SerializeEvents` | Chunk → wire format. Tests. |
| 3 | `internal/chunkring/chunkring.go` — `SnapshotAudio`, `GetChunk`, `GetCurrent`, `Available` | Read methods for serving and capture compat. |
| 4 | Wire into `streammgr` — replace `ringBuf`, add `WriteWF` in WF pump, add `WriteEvent` in interpreter/log callbacks | Plumbing. Delete `internal/ringbuf/`. |
| 5 | HTTP endpoints — `GET /streams/{id}/rewind`, `GET /streams/{id}/rewind/{index}/{audio,wf,events}` | Serve chunks from ring. |
| 6 | Update capture endpoint — `CaptureAudio()` uses `SnapshotAudio()` | Preserve existing capture feature. |
| 7 | WebSocket `chunk_complete` event — broadcast on rotation | Frontend notification. |

**Verification:** Start a stream, let it run for 6+ minutes. Hit `GET /rewind` — see 5 completed chunks + 1 in-progress. Fetch a chunk's audio — confirm it's a valid WAV (`ffprobe`). Fetch a chunk's WF — confirm the binary format parses correctly. Hit `POST /capture` — confirm the WAV download still works.

### Phase 2: Virtualized waterfall renderer

| # | Task | Notes |
|---|---|---|
| 8 | Tile data structure — `WFTile` with per-tile canvas, rawBins, row management | Core of the new renderer |
| 9 | Tile-based `VirtualWaterfallRenderer` — viewport offset, tile loading/eviction, `pushFrame()` to live tile, `blitToVisible()` compositing from tiles | Replaces `WaterfallRenderer`. Preserve LUT color mapping, frequency-axis viewport, auto-level. |
| 10 | Swap into `stream-player-page.tsx` — same `pushFrame()` API, same `setView()` / `setLevels()` API | Drop-in replacement. Verify live rendering works identically. |

**Milestone:** Waterfall renders identically to before, but uses tiles internally. No user-visible change. Scroll offset is always 0 (LIVE). This is a pure refactor.

### Phase 3: Waterfall pre-fill + history

| # | Task | Notes |
|---|---|---|
| 11 | Chunk parsers — WAV, binary WF, JSONL | `frontend/src/lib/chunk-parser.ts` |
| 12 | Chunk loader — `RingBufferSource`, sliding window, prefetch | `frontend/src/components/rewind/chunk-loader.ts` |
| 13 | Tile loading from chunks — fetch WF chunk, parse, populate tile rawBins, render | Wire chunk loader into tile system |
| 14 | Waterfall pre-fill on page load — load ring buffer chunks, pre-render history tiles above live | Major UX improvement: full waterfall on arrival |
| 15 | Reconnection gap fill — on WS reconnect, fetch chunks covering the gap and fill missing tiles | Piggybacks on pre-fill infrastructure |

**Milestone:** Page opens with a fully populated waterfall. Scrolling up reveals history. No rewind controls yet — just the scrollable waterfall.

### Phase 4: Rewind timeline + audio playback

| # | Task | Notes |
|---|---|---|
| 16 | Vertical rewind timeline — thin track alongside waterfall, drag handle, scroll-to-scrub, LIVE pill | `frontend/src/components/rewind/rewind-timeline.tsx` |
| 17 | Playback engine — AudioWorklet playback from chunked WAV, play/pause/seek | `frontend/src/components/rewind/playback-engine.ts` |
| 18 | Spectrum rewind — render recorded spectrum in rewind mode | Extension to `SpectrumRenderer` |
| 19 | LIVE/REWIND state machine — mode switching, crossfade, mute/unmute live audio, scroll-to-rewind | Integration in `stream-player-page.tsx` |
| 20 | Keyboard shortcuts — scroll up/down ±30s, `L` for live | |

**Milestone:** User can scrub backwards through 5 minutes of history, hear recorded audio, see recorded waterfall.

### Phase 5: Monitoring extension (MONITOR.md)

| # | Task | Notes |
|---|---|---|
| 21 | `S3Sink` — `OnChunkComplete` uploads to Tigris, updates DB | `internal/chunkring/s3sink.go` |
| 22 | `MonitorSession` DB model + CRUD | `internal/db/monitor.go` |
| 23 | Monitoring start/stop in `streammgr` — attach/detach `S3Sink`, lock settings, enable fallback | |
| 24 | REST endpoints for monitoring — start, stop, get, timeline, chunk URLs | |
| 25 | `S3Source` in frontend chunk loader | Pre-signed URL fetching |
| 26 | Multi-session DVR timeline — extend vertical timeline with session segments, gap rendering | |

**Milestone:** Full MONITOR.md functionality, built on ChunkRing infrastructure.

---

## Known Hard Parts

1. **AudioWorklet dual-mode.** The existing `SdrAudioProcessor` handles live PCM from WebSocket via `port.onmessage`. Playback mode needs it to accept PCM from the chunk loader instead, and report consumed sample count back to the main thread. The state transition (entering/exiting rewind mode) must be glitch-free — no pops, no silence gaps. Start with a brief fade-out/fade-in crossfade (128 samples) on mode switch.

2. **Waterfall renderer rewrite.** The current `WaterfallRenderer` must be substantially rewritten as a tile-based virtualized renderer (see "Waterfall renderer rewrite" section). This is the largest single piece of frontend work. The core rendering logic (LUT color mapping, frequency-axis viewport, level detection) is preserved, but the frame management, offscreen canvas, and compositing are new. The live tile (receiving `pushFrame()` data) must seamlessly adjoin historical tiles (loaded from chunk data) at the viewport boundary.

3. **Chunk boundary audio.** When playback crosses from chunk N to chunk N+1, there must be no audible gap. The chunk loader prefetches the next chunk, and when the playback engine exhausts the current chunk's PCM, it immediately continues into the next chunk's PCM. If there's a real time gap (a chunk was lost due to recording failure), insert 100ms of silence and continue.

4. **In-progress chunk serving.** Serving a chunk under active writes requires a read lock. The WAV header must have the correct `data` size computed on the fly. The response represents a point-in-time snapshot — the chunk will have grown by the time the frontend processes it. This is fine; the frontend will re-fetch when the `chunk_complete` event arrives.

5. **WF pre-fill via tile pre-loading.** On page load, the tile system pre-loads tiles for the available ring buffer history. This happens in the background — the viewport starts at LIVE, and tiles above the viewport are rendered asynchronously. When the user scrolls up, the tiles are already there. The boundary between pre-filled tiles and the live tile must be seamless (no gap, no overlap, timestamps align).

6. **Memory pressure from WF frame copies.** Each `WriteWF` call copies the bins slice (~1 KB). At ~8 fps, that's ~480 KB/min. The ring holds 5 chunks ≈ 2.4 MB of WF data. Trivial. But if `BufferMinutes` is set high (e.g., 15), it's ~7.2 MB. Still fine, but worth tracking.

---

## Edge Cases

### Decided

1. **Chunk indices are globally sequential per stream.** Index 0 is the first chunk ever produced. Indices monotonically increase. When a chunk is evicted from the ring, its index is gone — the ring might hold indices [42, 43, 44, 45, 46]. Fetching index 41 returns 404.

2. **Zoom changes mid-chunk.** The chunk stores all frames with their individual metadata. The `wf_zoom_changed` flag on chunk metadata tells the frontend to expect mixed frames. Audio is unaffected — it always plays regardless of zoom.

3. **Stream restart.** When a stream disconnects and reconnects (e.g., KiwiSDR reboot), the ChunkRing continues accumulating. If there's a time gap between the last frame before disconnect and the first frame after reconnect, the in-progress chunk at the time of disconnect is finalized early (with whatever data it has) and pushed into the ring. The time gap appears as a discontinuity in the chunk timestamps.

4. **`BufferMinutes` determines ring size.** The ring holds `BufferMinutes` completed chunks (1 chunk per minute). Changing `BufferMinutes` on a running stream takes effect on the next stream restart — the ring size is fixed at creation.

5. **Concurrent chunk fetches.** Multiple clients can fetch the same chunk simultaneously. Serialization happens per-request (no caching). At ~2 MB per chunk and typical client counts (1-5), this is negligible load.

6. **ChunkRing is always running.** Every active stream has a ChunkRing, even if no one ever uses the rewind feature. The overhead is ~12 MB memory and negligible CPU per stream. This is justified because: (a) waterfall pre-fill on page load is always useful, (b) the rewind feature should be available without opt-in, and (c) monitoring needs it to already be running when enabled.

### Noted for implementation

7. **Chunk serving during rotation.** If a client requests a chunk that's being evicted at that exact moment, the read lock prevents the eviction until the serve completes. No data corruption risk.

8. **S3 sink failure isolation.** If `OnChunkComplete` fails (S3 down, network error), the ChunkRing continues rotating normally. The failed chunk is lost from S3 but may still be in the ring briefly. The sink handles its own retry logic (MONITOR.md says: retry once, then discard).

9. **WAV header for partial chunks.** The in-progress chunk may have an odd number of bytes if a frame boundary is mid-sample. Unlikely (PCM16 frames are always even-length from KiwiSDR), but `SerializeAudioWAV` should round down to the nearest sample boundary.

10. **Pre-fill races with live frames.** When the frontend fetches historical chunks on page load, live frames are also arriving via WebSocket. The pre-fill renderer must account for overlap: historical frames whose timestamps fall within the "already rendered live" window should be skipped.

---

## Relationship to MONITOR.md

ChunkRing replaces MONITOR.md's recording pipeline architecture. Here's the mapping:

| MONITOR.md concept | ChunkRing equivalent |
|---|---|
| `internal/monitor/recorder.go` | `ChunkRing` + `S3Sink` |
| `AudioChunkWriter` | `ChunkRing.WriteAudio()` + `SerializeAudioWAV()` |
| `WFChunkWriter` | `ChunkRing.WriteWF()` + `SerializeWF()` |
| `EventChunkWriter` | `ChunkRing.WriteEvent()` + `SerializeEvents()` |
| `SessionUpdater` | `S3Sink.OnChunkComplete()` (updates DB) |
| 5-minute chunk rotation | 1-minute chunk rotation |
| Local temp files → S3 upload → delete local | In-memory chunk → S3 upload → stays in ring until evicted |
| Recorder isolation (buffered channels, drop on backpressure) | ChunkRing writes are in-line with the pump (sub-microsecond), S3 upload is async |
| Crash recovery (check for active sessions, resume) | Unchanged — but the ring buffer is in-memory, so only S3 chunks survive a crash |

MONITOR.md's session model, retention policy, and API are unchanged. Only the recording pipeline implementation changes — from a standalone recorder goroutine to ChunkRing with an S3 sink.

The 5-minute chunk size in MONITOR.md should be updated to 1-minute to match ChunkRing's chunk duration. MONITOR.md's cost estimates scale by 5x for S3 requests but remain negligible.

### DVR timeline orientation

MONITOR.md described the DVR timeline as a horizontal bar below the waterfall. ChunkRing changes this to a **vertical timeline alongside the waterfall**, sharing the waterfall's Y axis (time). This is a better fit because the waterfall is inherently a temporal display — time flows downward. Putting the timeline on the same axis means rewind is "scroll up to see the past," which matches the waterfall's visual metaphor.

For monitoring, the vertical timeline becomes a minimap of the full recording history: sessions appear as solid regions, gaps between sessions as hatched regions, and the ring buffer at the bottom (the most recent data). The same scroll/drag interaction works at any time scale — 5 minutes of ring buffer or 30 days of monitoring history. MONITOR.md's UI layouts should be updated to reflect this vertical orientation.

---

## Performance Budget

| Operation | Target | Notes |
|---|---|---|
| `WriteAudio` (per frame) | < 5 μs | Append ~1 KB to a pre-allocated byte slice |
| `WriteWF` (per frame) | < 5 μs | Append `WFFrame` to slice |
| `WriteEvent` (per event) | < 5 μs | Append `Event` to slice |
| Chunk rotation | < 100 μs | Push into ring, allocate pre-sized new chunk. S3 delivery via buffered channel (non-blocking). |
| Serialize audio (1-min chunk) | < 5 ms | WAV header + 1.44 MB copy |
| Serialize WF (1-min chunk) | < 5 ms | Binary encode ~480 frames |
| Serve chunk via HTTP | < 10 ms | Serialize + write to response |
| GetCurrent snapshot | < 2 ms | Read-lock + copy in-progress data |
| WF pre-fill (5 chunks) | < 200 ms | 5 × fetch ~500 KB + parse + render |

---

## New Files

### Backend

| File | Purpose |
|---|---|
| `internal/chunkring/chunkring.go` | ChunkRing struct, Write methods, ring management, rotation |
| `internal/chunkring/serialize.go` | WAV, binary WF, JSONL serialization |
| `internal/chunkring/chunkring_test.go` | Tests |
| `internal/api/stream_rewind.go` | Rewind HTTP endpoints |

### Frontend

| File | Purpose |
|---|---|
| `frontend/src/lib/chunk-parser.ts` | WAV, binary WF, JSONL chunk parsers |
| `frontend/src/components/rewind/rewind-timeline.tsx` | Vertical timeline track alongside waterfall |
| `frontend/src/components/rewind/chunk-loader.ts` | Chunk fetching with sliding window and prefetch |
| `frontend/src/components/rewind/playback-engine.ts` | AudioWorklet-driven playback from chunk data |

### Deleted

| File | Reason |
|---|---|
| `internal/ringbuf/ringbuf.go` | Replaced by ChunkRing |
| `internal/ringbuf/ringbuf_test.go` | Replaced by ChunkRing tests |
