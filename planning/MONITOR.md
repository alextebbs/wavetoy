# Monitoring Mode: S3 Chunk Offloading

## What It Does

Monitoring mode is a per-stream setting that offloads completed ChunkRing chunks to Tigris S3. When enabled, every 1-minute chunk that rotates out of the ring is serialized and uploaded to object storage. The chunk data model doesn't change — the same `Chunk` struct, same serialization formats (WAV, binary WF, JSONL), same rotation logic. The only new thing is: completed chunks get a second life in S3 instead of being silently evicted.

The result: the existing 5-minute rewind window extends to days or weeks of scrollable history. The vertical timeline alongside the waterfall — which today spans 5 minutes of ring buffer — grows to show the full monitoring history. The frontend fetches older chunks from S3 via pre-signed URLs using the same parsers and renderers it already uses for ring buffer chunks.

### What changes for the user

**Today:** A stream has a 5-minute rewind window (ChunkRing). Scroll up through waterfall history, scrub audio, see events — but only for the last 5 minutes. Older data is evicted and gone.

**After monitoring:** Toggle monitoring on a stream. The 5-minute ring buffer still works identically. But now, when chunks rotate out of the ring, they're uploaded to Tigris. The vertical timeline extends — scroll up past the 5-minute mark and the waterfall loads tiles from S3 chunks. Same visual experience, same audio playback, same scrub interaction. Just more history.

### What doesn't change

- **The chunk data model.** `Chunk`, `WFFrame`, `Event`, `ChunkMeta` — all untouched.
- **The ChunkRing.** Same rotation, same ring behavior, same `WriteAudio`/`WriteWF`/`WriteEvent`. The `ChunkSink` interface and `SetSink()` method already exist for exactly this purpose.
- **Serialization.** `SerializeAudioWAV`, `SerializeWF`, `SerializeEvents` — already written, already tested.
- **The rewind API.** `GET /api/streams/{id}/rewind` and its sub-endpoints continue to serve ring buffer chunks.
- **The frontend chunk infrastructure.** `ChunkSource`, `RingBufferSource`, `parseWFChunk`, `parseWAVChunk`, `parseEventsChunk`, the tile-based waterfall renderer, `HistoricalAudioPlayer`, `ScrubController` — all stay as-is.
- **Live streaming.** WebSocket audio + WF, live waterfall rendering, live audio playback — completely unaffected.

---

## Monitoring as Three Independent Systems

"Monitoring" is the user-facing concept, but the backend should be architected as three independent, composable systems. Each is a separate bool on the stream model, a separate subsystem in the backend, and can be enabled in any combination. The UI may present them as a single "Monitor" toggle that enables all three, but the backend treats them as orthogonal.

### 1. `auto_probe` — Fallback source discovery

Periodically probes nearby KiwiSDR sources, scores them against the current connection, and maintains ranked fallback suggestions. This is about **keeping your options ready** — not about acting on them.

**Current state:** This exists today inside `internal/fallback/`. `DiscoverCandidates` finds nearby KiwiSDRs by haversine distance, `ProbeSource` connects and records a 3-second audio/WF snapshot, `ScoreCandidate` compares against a reference snapshot using silence agreement, spectral similarity, RMS, noise floor, frame rate, and latency. Top 3 suggestions are kept. Probe cycles run every 5 minutes.

**Current problem:** This is bundled into the `auto_fallback` bool, which also controls failover and keep-alive. You can't probe without also enabling automatic failover. Separating it lets a user keep fallback suggestions current without committing to automatic switching.

**Data model change:** Replace the probing behavior currently gated by `auto_fallback` with a dedicated `auto_probe` bool. When `auto_probe` is true, `fallback.Manager` runs periodic probe cycles. When false, probing only happens on manual `Reprobe()` calls. The existing `internal/fallback/` code doesn't change — only what triggers `Enable()`/`Disable()`.

### 2. `quality_fallback` — Automatic failover on quality degradation

A dedicated per-stream quality monitor that continuously measures connection quality and triggers automatic source switching when quality drops below a threshold.

**Current state:** This does **not exist** as a real quality monitor. Today, failover is only triggered by reconnect failures — specifically, after 3 consecutive failed reconnect attempts or 10 unstable reconnects (`internal/streammgr/manager.go` lines 862–876 and 1092–1103). There is no SNR-based, frame-rate-based, or audio-quality-based failover. The `Source.SNRDBM` field is populated from KiwiSDR `/status` via `internal/sync/health.go` but is never used for failover decisions. `notifyDataStale` (no data for 10s) only broadcasts a WebSocket event to clients — it doesn't trigger failover.

**What needs to be built (separate RFC):** A `QualityMonitor` that runs per-stream when `quality_fallback` is enabled. It would measure ongoing connection quality (SNR, frame rate, silence ratio, latency) and call `onDegraded` when quality drops below configurable thresholds — not just on reconnect failures. This is a meaningful piece of work and deserves its own design. The existing `internal/fallback/scorer.go` already knows how to evaluate audio quality from a snapshot; the quality monitor would run a continuous version of that scoring against the live stream.

**Data model change:** Replace the failover behavior currently gated by `auto_fallback` with a dedicated `quality_fallback` bool. When true, the quality monitor runs and can trigger `HandleDegraded`. When false, no automatic failover occurs (reconnect attempts still happen, they just don't escalate to source switching). This also subsumes the keep-alive behavior — if you've enabled quality-based fallback, the stream should stay alive to be monitored.

### 3. `offload_chunks` — S3 chunk offloading

Uploads completed ChunkRing chunks to Tigris S3, extending the rewind window from 5 minutes to days/weeks.

**Current state:** Not implemented. The `ChunkSink` interface and `SetSink()` method in ChunkRing are ready and waiting. **This is the subject of this RFC.**

**Data model change:** New `offload_chunks` bool on the stream model.

### Data model migration

The current `auto_fallback` bool gets decomposed:

```sql
-- Add the three independent flags
ALTER TABLE streams ADD COLUMN auto_probe BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE streams ADD COLUMN quality_fallback BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE streams ADD COLUMN offload_chunks BOOLEAN NOT NULL DEFAULT false;

-- Migrate: streams that had auto_fallback get auto_probe (probing was the primary behavior)
UPDATE streams SET auto_probe = auto_fallback;

-- Drop the bundled flag
ALTER TABLE streams DROP COLUMN auto_fallback;
```

The Go model becomes:

```go
type Stream struct {
    // ...
    AutoProbe        bool    `json:"auto_probe"`
    QualityFallback  bool    `json:"quality_fallback"`
    OffloadChunks    bool    `json:"offload_chunks"`
    // AutoFallback  bool    — REMOVED
}
```

Each system responds to its own flag:

| Flag | Backend system | What it activates |
|---|---|---|
| `auto_probe` | `fallback.Manager.Enable/Disable` | Periodic probe cycles (5 min), maintains ranked suggestions |
| `quality_fallback` | `QualityMonitor` (new, future) | Continuous quality measurement, triggers `HandleDegraded` on degradation, keep-alive |
| `offload_chunks` | `ChunkRing.SetSink(s3Sink)` | S3 upload of completed chunks |

At the API level, each is a patchable bool on the stream like any other field. At the UI level, a "Monitor" toggle can enable all three at once — or the user can configure them individually in an advanced settings section.

### Scope of this RFC

**This RFC covers system 3 (`offload_chunks`) only.** Systems 1 and 2 are referenced for architectural context and to establish the data model direction. System 1 is a rename/refactor of existing behavior. System 2 requires its own design and is not covered here.

---

## Current State

Everything the S3 offloading needs to plug into already exists.

### Backend

| Component | Status | Location |
|---|---|---|
| ChunkRing | Implemented | `internal/chunkring/chunkring.go` |
| `ChunkSink` interface | Implemented | `chunkring.go` — `OnChunkComplete(chunk *Chunk) error` |
| `SetSink()` | Implemented | Attaches sink, starts worker goroutine, async via buffered channel (cap 3) |
| Sink worker | Implemented | Serial processing, retry once on failure, drop on second failure |
| Chunk serialization | Implemented | `internal/chunkring/serialize.go` — WAV, binary WF, JSONL |
| Ring ↔ streammgr | Wired | `WriteAudio` in audio pump, `WriteWF` in WF pump, `WriteEvent` in interpreter/log callbacks |
| Rewind API | Implemented | `GET /api/streams/{id}/rewind`, `.../rewind/{started_at}/{audio,wf,events}` |
| `chunk_complete` WS event | Implemented | Broadcast on rotation via `SetOnRotate` |
| Stream model | `AutoFallback` field exists | `models.Stream` — needs decomposition into `auto_probe`, `quality_fallback`, `offload_chunks` |

### Frontend

| Component | Status | Location |
|---|---|---|
| Tile-based waterfall | Implemented | `waterfall-renderer-base.ts`, Canvas2D + WebGL2 backends |
| Chunk parser | Implemented | `frontend/src/lib/chunk-parser.ts` |
| Chunk loader | Implemented | `frontend/src/lib/chunk-loader.ts` — `ChunkSource`, `RingBufferSource` |
| Historical audio player | Implemented | `frontend/src/lib/historical-audio-player.ts` |
| Scrub controller | Implemented | `frontend/src/lib/scrub-controller.ts` |
| Scroll-back store | Implemented | `frontend/src/lib/scroll-back-store.ts` |
| Waterfall prefill | Implemented | Loads ring chunks on connect, renders historical tiles |
| Viewport-driven chunk loading | Implemented | `checkViewport()` → `fetchChunk()` for visible chunks, eviction for distant ones |
| Rewind/scrub UX | Implemented | Scroll up to rewind, drag to scrub, playback head, "LIVE" snap-back |

### What's missing

| Component | Status |
|---|---|
| S3 client (aws-sdk-go-v2) | Not implemented |
| `S3Sink` | Not implemented |
| `offloaded_chunks` DB table (chunk manifest) | Not implemented |
| Stream model decomposition | `auto_fallback` needs splitting into `auto_probe`, `quality_fallback`, `offload_chunks` |
| `QualityMonitor` | Not implemented (separate RFC, not covered here) |
| Extended rewind API (S3 chunks + pre-signed URLs) | Not implemented |
| Composite audio export endpoint | Not implemented |
| Frontend `UnifiedChunkSource` | Not implemented |
| Timeline extension for S3 history | Not implemented |
| Monitor UI controls | Not implemented |

---

## Architecture

### How S3Sink plugs in

The ChunkRing already has everything needed. The sink interface exists, the async worker exists, the retry-and-drop policy exists. `S3Sink` is a ~120-line implementation of `ChunkSink`:

```
Regular stream (today):

    WriteAudio/WriteWF/WriteEvent → accumulate → rotate → ring (keep last 5)
                                                           └── evict oldest

Monitored stream (new):

    WriteAudio/WriteWF/WriteEvent → accumulate → rotate → ring (keep last 5)
                                                           ├── evict oldest
                                                           └── sinkCh ← chunk (non-blocking)
                                                                └── sink worker goroutine
                                                                     ├── SerializeAudioWAV → S3 PutObject
                                                                     ├── SerializeWF → S3 PutObject
                                                                     ├── SerializeEvents → S3 PutObject
                                                                     └── INSERT offloaded_chunks (manifest)
```

The `streammgr` changes are minimal:

1. When `offload_chunks` is enabled: `as.chunkRing.SetSink(s3Sink)`.
2. When `offload_chunks` is disabled: `as.chunkRing.SetSink(nil)`.

That's it. No new subscribers, no new channels, no new accumulation logic. The ChunkRing continues to do what it already does — the sink just gets a copy of each completed chunk.

### Data flow for serving S3 chunks

```
Frontend                          Backend                        Tigris S3
   │                                │                               │
   │  GET /streams/{id}/history     │                               │
   │    ?from=...&to=...            │                               │
   │ ─────────────────────────────→ │                               │
   │  (chunk metadata + pre-signed  │                               │
   │   URLs from DB + S3 presigner) │                               │
   │ ←───────────────────────────── │                               │
   │                                │                               │
   │  fetch(audio pre-signed URL)   │                               │
   │ ─────────────────────────────────────────────────────────────→ │
   │  (WAV from S3)                 │                               │
   │ ←───────────────────────────────────────────────────────────── │
   │                                │                               │
   │  fetch(wf pre-signed URL)      │                               │
   │ ─────────────────────────────────────────────────────────────→ │
   │  (binary WF from S3)           │                               │
   │ ←───────────────────────────────────────────────────────────── │
```

The backend generates pre-signed URLs — the frontend fetches chunks directly from Tigris. No chunk data flows through the backend on reads. Tigris egress is free.

### Chunk manifest

There are no "monitoring sessions." The `offloaded_chunks` table is the single source of truth — a flat manifest of every chunk that's been uploaded to S3 for a given stream. Each row records when the chunk started, when it ended, and how big it is.

The manifest answers every question:
- **Does this stream have S3 data?** `SELECT 1 FROM offloaded_chunks WHERE stream_id = ? LIMIT 1`
- **What time range is covered?** `MIN(started_at)` to `MAX(ended_at)`
- **Are there gaps?** Compare consecutive `ended_at` to `started_at` — a gap larger than ~60s means offloading was off or a chunk was dropped.
- **How much storage?** `SUM(size_bytes)`

Gaps appear naturally when offloading is toggled off and back on, or when chunks are dropped due to S3 backpressure. The frontend detects them from the timestamp discontinuities in the manifest — no separate session/gap tracking needed.

Chunks are self-describing — each WF frame carries its own `xBin`, `zoom`, `freqKHz`, `passbandLo`, `passbandHi`, and each chunk carries its `SourceID`. The manifest doesn't need to snapshot stream config.

### Relationship to the other monitoring systems

Chunk offloading is orthogonal to probing and quality fallback. You can enable any combination:

| | `offload_chunks` off | `offload_chunks` on |
|---|---|---|
| **Nothing else** | Normal stream. 5-min ring. | S3 offloading. Extended history. |
| **`auto_probe`** | Probing runs, suggestions stay fresh. | Probing + S3 offloading. |
| **`quality_fallback`** | Quality monitor + auto-failover. | Quality monitor + auto-failover + S3 offloading. |
| **Both** | Full resilience, no recording. | Full monitoring: resilient + recorded. |

If you care enough about a frequency to record it, you probably want probing and quality fallback too. The UI's "Monitor" toggle should enable all three. But the backend treats each independently — a user who just wants S3 recording without automatic source switching can enable `offload_chunks` alone.

---

## S3 Infrastructure

### Tigris setup

Tigris is Fly.io's S3-compatible object storage. Accessed over the local Fly network (no cross-provider egress), billed at **$0.02/GB/month** with the first 5 GB free. Egress is **free**.

```bash
fly storage create --name monitor-data
```

This provisions a bucket and sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, and `BUCKET_NAME` as secrets on the app. Add `S3_KEY_PREFIX=prod` as an additional secret.

### S3 key layout

```
{prefix}/streams/{stream_id}/{started_at_unix}/
    audio.wav
    wf.bin
    events.jsonl
```

Example:
```
prod/streams/abc-123/
    1710500000/audio.wav     ← chunk started at this unix timestamp
    1710500000/wf.bin
    1710500000/events.jsonl
    1710500060/audio.wav     ← next chunk, 60 seconds later
    1710500060/wf.bin
    1710500060/events.jsonl
```

Using `started_at` as a unix timestamp in the key makes chunks naturally sortable, unique, and directly mappable to the chunk's `StartedAt` field. All chunks for a stream live under one prefix — no session grouping needed. S3 lifecycle rules apply to the entire `{prefix}/streams/` prefix.

### S3 client wrapper

```go
// internal/s3/client.go

type Client struct {
    s3Client *s3.Client
    bucket   string
    prefix   string // "prod" or "dev"
}

func NewFromEnv() (*Client, error)

func (c *Client) PutObject(ctx context.Context, key string, body io.Reader, contentType string) error
func (c *Client) PreSignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
func (c *Client) DeletePrefix(ctx context.Context, prefix string) error
```

The client is initialized once at server startup from environment variables. If the env vars are not set (no Tigris configured), the client is nil and chunk offloading is unavailable — patching `offload_chunks = true` returns 501.

### Dev setup

**Option A: Tigris directly (recommended).** Same bucket, different prefix:

```
S3_KEY_PREFIX=dev
```

Copy bucket credentials into `.env` (gitignored). Data rates (~2 MB/min per stream) are fine over internet. Dev data is isolated under `dev/`.

**Option B: MinIO for offline dev.** Add to `docker-compose.yml`:

```yaml
minio:
  image: minio/minio
  command: server /data --console-address ":9001"
  ports:
    - "9000:9000"
    - "9001:9001"
  environment:
    MINIO_ROOT_USER: minioadmin
    MINIO_ROOT_PASSWORD: minioadmin
  volumes:
    - minio_data:/data
```

```
AWS_ENDPOINT_URL_S3=http://localhost:9000
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
BUCKET_NAME=monitor-data
S3_KEY_PREFIX=dev
```

The S3 client wrapper calls `CreateBucket` on startup if the bucket doesn't exist (no-op in prod).

---

## Backend Implementation

### `internal/s3/client.go` — S3 client wrapper

~80 lines. Wraps `aws-sdk-go-v2/service/s3` with the project's env var conventions. Handles presigning via `s3.NewPresignClient`.

### `internal/chunkring/s3sink.go` — S3Sink

Implements `ChunkSink`. This is the only new file in `internal/chunkring/`.

```go
type S3Sink struct {
    s3       *s3client.Client
    db       *db.Queries
    streamID string
}

func NewS3Sink(s3 *s3client.Client, db *db.Queries, streamID string) *S3Sink

func (s *S3Sink) OnChunkComplete(chunk *Chunk) error {
    prefix := s.s3.Prefix() // "prod" or "dev"
    base := fmt.Sprintf("%s/streams/%s/%d", prefix, s.streamID, chunk.StartedAt.Unix())

    // Upload audio
    var audioBuf bytes.Buffer
    SerializeAudioWAV(&audioBuf, chunk)
    s.s3.PutObject(ctx, base+"/audio.wav", &audioBuf, "audio/wav")

    // Upload waterfall
    var wfBuf bytes.Buffer
    SerializeWF(&wfBuf, chunk)
    s.s3.PutObject(ctx, base+"/wf.bin", &wfBuf, "application/octet-stream")

    // Upload events
    var evBuf bytes.Buffer
    SerializeEvents(&evBuf, chunk)
    s.s3.PutObject(ctx, base+"/events.jsonl", &evBuf, "application/x-ndjson")

    totalBytes := audioBuf.Len() + wfBuf.Len() + evBuf.Len()

    // Record in manifest
    s.db.InsertOffloadedChunk(ctx, db.InsertOffloadedChunkParams{
        StreamID:  s.streamID,
        StartedAt: chunk.StartedAt,
        EndedAt:   chunk.EndedAt,
        SizeBytes: int64(totalBytes),
    })

    return nil
}
```

Three S3 PutObject calls per chunk. At ~2 MB per chunk, each PutObject is tiny — Tigris handles this in milliseconds over the Fly network. The 3-capacity sink channel in ChunkRing provides natural backpressure: if uploads are slow, up to 3 chunks queue; beyond that, chunks are dropped with a warning log.

### Database changes

#### Migration: `offloaded_chunks` table (the chunk manifest)

```sql
CREATE TABLE offloaded_chunks (
    stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    started_at  TIMESTAMPTZ NOT NULL,
    ended_at    TIMESTAMPTZ NOT NULL,
    size_bytes  INT NOT NULL,
    PRIMARY KEY (stream_id, started_at)
);
```

That's it. One table. The composite primary key `(stream_id, started_at)` gives fast lookups by stream and time range. `ON DELETE CASCADE` cleans up when a stream is deleted.

#### Migration: decompose `auto_fallback`, add `offload_chunks`

```sql
-- Decompose auto_fallback into independent flags
ALTER TABLE streams ADD COLUMN auto_probe BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE streams ADD COLUMN quality_fallback BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE streams ADD COLUMN offload_chunks BOOLEAN NOT NULL DEFAULT false;

-- Migrate: streams that had auto_fallback get auto_probe
-- (probing was the primary behavior users opted into)
UPDATE streams SET auto_probe = auto_fallback;

-- Drop the bundled flag
ALTER TABLE streams DROP COLUMN auto_fallback;
```

This migration decomposes `auto_fallback` into the three independent systems described above. Existing streams with `auto_fallback = true` get `auto_probe = true` to preserve their current probing behavior. `quality_fallback` and `offload_chunks` default to `false` — users opt in explicitly.

### `internal/db/monitor.go` — queries

```go
func (q *Queries) InsertOffloadedChunk(ctx, params) error
func (q *Queries) ListOffloadedChunks(ctx, streamID string, from, to time.Time) ([]OffloadedChunkRow, error)
func (q *Queries) HasOffloadedChunks(ctx, streamID string) (bool, error)
func (q *Queries) OffloadedChunkStats(ctx, streamID string) (count int, totalBytes int64, oldest, newest time.Time, error)
func (q *Queries) DeleteExpiredChunks(ctx, olderThan time.Time) (int64, error)
```

### `streammgr` integration

When chunk offloading is enabled on a stream:

```go
func (m *Manager) StartChunkOffload(streamID string) error {
    // 1. Update stream in DB
    m.db.UpdateStream(ctx, streamID, offloadChunks=true)

    // 2. Create and attach S3Sink
    sink := chunkring.NewS3Sink(m.s3Client, m.db, streamID)
    as.chunkRing.SetSink(sink)

    // 3. Broadcast stream update via WebSocket
    m.broadcastStreamUpdate(streamID)
}
```

When chunk offloading is disabled:

```go
func (m *Manager) StopChunkOffload(streamID string) error {
    // 1. Detach sink
    as.chunkRing.SetSink(nil)

    // 2. Update stream in DB
    m.db.UpdateStream(ctx, streamID, offloadChunks=false)

    // 3. Broadcast stream update via WebSocket
    m.broadcastStreamUpdate(streamID)
}
```

No new channels. No new subscribers. No settings locked. No session to create or finalize. The stream continues to operate normally — the only difference is whether completed chunks also go to S3.

When the UI's "Monitor" toggle is flipped, it patches all three flags at once. But each system reacts independently: `auto_probe` triggers `fallback.Manager.Enable()`, `quality_fallback` would start the quality monitor (future), and `offload_chunks` attaches the S3Sink. Disabling the toggle reverses each.

### Crash recovery

On startup, check for any streams with `offload_chunks = true`:

1. If the stream's ChunkRing is starting up (stream is active), re-create the S3Sink and re-attach it. The last in-progress chunk before the crash is lost (at most 1 minute of data).
2. If the stream no longer exists, set `offload_chunks = false`.

Since completed chunks are immutable S3 objects and the manifest tracks them individually, crash recovery is trivial — just re-attach the sink and new chunks pick up where they left off.

### Retention

30-day retention, enforced by:

1. **S3 lifecycle rule** on the Tigris bucket — automatically expires objects older than 30 days.
2. **Backend sweep** (daily cron or on startup) — `DELETE FROM offloaded_chunks WHERE started_at < now() - interval '30 days'`.

---

## API

### Enable/disable chunk offloading

Chunk offloading is controlled via the standard stream PATCH endpoint:

```
PATCH /api/streams/{id}
{ "offload_chunks": true }
```

When `offload_chunks` transitions from `false` → `true`: attaches S3Sink to the ChunkRing. Returns 501 if S3 is not configured.

When `offload_chunks` transitions from `true` → `false`: detaches S3Sink. Existing chunks in S3 remain until they expire.

The "Monitor" toggle in the UI patches all three flags at once:

```
PATCH /api/streams/{id}
{ "auto_probe": true, "quality_fallback": true, "offload_chunks": true }
```

### Extended rewind endpoint

The existing rewind endpoint gains S3 awareness. If the stream has `offload_chunks` enabled (or has historical chunks in S3), the response includes S3 chunks alongside ring buffer chunks:

```
GET /api/streams/{id}/rewind?from=2026-03-15T10:00:00Z&to=2026-03-15T10:05:00Z
```

Without `from`/`to`, returns only ring buffer chunks (existing behavior). With `from`/`to`, also queries the `offloaded_chunks` manifest and returns S3 chunks with pre-signed URLs:

```json
{
  "stream_id": "stream-uuid",
  "sample_rate": 12000,
  "chunk_duration_s": 60,
  "chunks": [
    {
      "started_at": "2026-03-15T10:00:00.000Z",
      "ended_at": "2026-03-15T10:01:00.000Z",
      "complete": true,
      "source": "s3",
      "audio_url": "https://fly.storage.tigris.dev/monitor-data/prod/streams/.../audio.wav?X-Amz-...",
      "wf_url": "https://fly.storage.tigris.dev/monitor-data/prod/streams/.../wf.bin?X-Amz-...",
      "events_url": "https://fly.storage.tigris.dev/monitor-data/prod/streams/.../events.jsonl?X-Amz-..."
    },
    {
      "started_at": "2026-03-15T10:04:00.000Z",
      "ended_at": "2026-03-15T10:05:00.000Z",
      "complete": true,
      "source": "ring",
      "audio_bytes": 1440000,
      "wf_frames": 482,
      "events": 3
    }
  ]
}
```

Ring chunks have `"source": "ring"` — the frontend fetches them from the existing rewind sub-endpoints (`/rewind/{started_at}/audio`, etc.). S3 chunks have `"source": "s3"` — the frontend fetches them directly from the pre-signed URLs. Pre-signed URLs expire after 1 hour.

The backend resolves chunks by checking the ring buffer first (for recent data), then the manifest table (for older data). If a chunk exists in both (just uploaded to S3 but still in the ring), the ring version is returned.

### Chunk manifest endpoint

```
GET /api/streams/{id}/chunks/manifest
```

Returns aggregate info about what S3 data exists, for the timeline to render without fetching individual chunk metadata:

```json
{
  "stream_id": "stream-uuid",
  "has_s3_chunks": true,
  "oldest": "2026-03-15T10:00:00Z",
  "newest": "2026-03-15T18:42:00Z",
  "total_chunks": 522,
  "total_size_bytes": 1069252608
}
```

### Composite audio export

```
GET /api/streams/{id}/audio?from=2026-03-15T12:30:00Z&to=2026-03-15T12:35:00Z
```

Returns a single WAV file stitched from ring buffer and/or S3 chunks spanning the requested time range. The backend:

1. Identifies which chunks cover `from` to `to` (ring buffer + manifest).
2. Fetches audio data — from memory for ring chunks, from S3 for offloaded chunks.
3. Extracts the relevant PCM samples from each chunk (trimming the first and last to match the exact `from`/`to` timestamps).
4. Writes a single contiguous WAV with the stitched PCM.

Gaps (missing chunks) are filled with silence. This replaces the old capture endpoint for monitored streams — instead of snapshotting whatever's in the ring, you can export any time range.

### WebSocket events

When any monitoring flag changes, the stream update broadcast includes the new fields:

```json
{
  "type": "stream_update",
  "stream": {
    "auto_probe": true,
    "quality_fallback": true,
    "offload_chunks": true,
    ...
  }
}
```

---

## Frontend

### Extending `RingBufferSource` to handle S3 chunks

The existing `RingBufferSource` already implements `ChunkSource` and fetches chunks from `/api/streams/{id}/rewind/{started_at}/...`. Since the extended rewind endpoint now returns both ring and S3 chunks in a unified response, the `ChunkSource` implementation needs to handle two cases:

- **Ring chunks** (`source: "ring"`): fetched from the existing rewind sub-endpoints, as today.
- **S3 chunks** (`source: "s3"`): fetched directly from the pre-signed URLs in the response.

```typescript
class UnifiedChunkSource implements ChunkSource {
  private chunkMap: Map<string, RewindChunk>; // keyed by started_at

  async fetchWF(startedAt: string): Promise<ArrayBuffer> {
    const chunk = this.chunkMap.get(startedAt);
    if (chunk.source === 'ring') {
      return fetch(`/api/streams/${this.streamId}/rewind/${startedAt}/wf`).then(r => r.arrayBuffer());
    }
    return fetch(chunk.wf_url).then(r => r.arrayBuffer());
  }

  // ... same pattern for fetchAudio, fetchEvents
}
```

The waterfall renderer's `checkViewport()` → `fetchChunk()` pipeline doesn't care which source provides the data — it just needs `ArrayBuffer` chunks in the same binary format. The parsers (`parseWFChunk`, `parseWAVChunk`) are identical for both sources.

### Timeline extension

The existing vertical timeline alongside the waterfall shows the 5-minute ring buffer window. With chunk offloading, it extends:

```
Stream with S3 history + ring buffer:

                    Waterfall                    │ Timeline
  ┌─────────────────────────────────────────────┐│
  │  (S3 chunks, hours ago)                       ││ ┄ 4h ago
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││ ┄ 3h ago
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││   gap (offloading was off)
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││ ┄ 2h ago
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││
  │  ─ ─ ─ ─ ─ (ring buffer boundary) ─ ─ ─ ─  ││ ┄ 5m ago
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ││
  │  ░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░░░░  ││ ● LIVE
  └─────────────────────────────────────────────┘│
```

The timeline becomes a **minimap** of the full available history:
- **Solid regions** = chunks exist (ring buffer at the bottom, S3 chunks above).
- **Gaps** = periods where no chunks exist (offloading was off, or chunks were dropped). Detected from timestamp discontinuities in the manifest.
- Scrolling up past the ring buffer region seamlessly transitions to loading from S3.
- The timeline track gets **zoom levels** for long histories — collapsed view shows data regions, expanded view shows individual minutes.

On page load, the timeline fetches the manifest (`GET /api/streams/{id}/chunks/manifest`) to know the total time span and render the minimap. Detailed chunk metadata is loaded lazily via the extended rewind endpoint as the user scrolls.

### Loading strategy for S3 chunks

When the user scrolls into S3 territory (past the ring buffer boundary):

1. The tile manager identifies which chunks are needed for the visible tiles.
2. If those chunks aren't cached, fetch metadata + pre-signed URLs from `GET /api/streams/{id}/rewind?from=...&to=...`.
3. Fetch chunk data directly from Tigris using the pre-signed URLs.
4. Parse with the existing `parseWFChunk` / `parseWAVChunk` parsers.
5. Render tiles, cache in the tile system.

Pre-signed URLs are cached and refreshed when they expire (catch 403, re-fetch from backend). The chunk loader maintains a sliding window: current ± a few chunks loaded, distant chunks evicted. Same pattern as the existing ring buffer chunk loading.

### Pre-signed URL refresh

Pre-signed URLs expire after 1 hour. The frontend handles this:

1. On 403 from Tigris, re-fetch from `GET /api/streams/{id}/rewind?from=...&to=...`.
2. Replace cached URLs.
3. Retry the chunk fetch.

### Monitor controls in the UI

A simple addition to the stream controls — not a full panel:

- **Monitor toggle** — a single switch that enables all three systems (`auto_probe`, `quality_fallback`, `offload_chunks`) at once. Shows "Monitoring" with a pulsing indicator when active and total storage usage.
- **Advanced section** (expandable) — individual toggles for each system, for users who want granular control (e.g., S3 recording without auto-failover, or probing without recording).
- When chunk offloading is active, a small badge appears on the stream header.

This is deliberately minimal. The primary value is the extended timeline — the control surface is just a toggle.

---

## Data Rates & Cost

### Per chunk (1 minute)

| Component | Size |
|---|---|
| Audio (WAV, PCM16, 12 kHz mono) | ~1.44 MB |
| Waterfall (~8 fps × ~1 KB/frame) | ~480 KB |
| Events | < 10 KB |
| **Total** | **~2 MB** |

### S3 writes per chunk

3 PutObject calls per chunk rotation (audio, WF, events).

### Aggregate

| Period | Data per stream | S3 PUTs per stream |
|---|---|---|
| 1 hour | ~120 MB | 180 |
| 24 hours | ~2.88 GB | 4,320 |
| 30 days | ~86 GB | 129,600 |

### Cost (Tigris, 30-day retention)

| | 1 stream | 3 streams | 5 streams |
|---|---|---|---|
| Storage ($0.02/GB/mo) | $1.72 | $5.16 | $8.60 |
| Class A PUTs ($0.005/1000, first 10K free) | $0.60 | $1.80 | $2.99 |
| Egress | Free | Free | Free |
| **Total/month** | **$2.32** | **$6.96** | **$11.59** |

These costs are slightly higher than the old 5-minute chunk plan due to 5x more PutObject calls, but still negligible. The tradeoff is worth it: 1-minute chunks give finer seek granularity, a smaller near-live gap (60s vs 5min), and consistency with the ring buffer's chunk duration.

---

## Implementation Order

### Phase 1: Data model decomposition + S3 infrastructure

| # | Task | Notes |
|---|---|---|
| 1 | DB migration — decompose `auto_fallback` into `auto_probe`, `quality_fallback`, `offload_chunks` | See migration SQL above. |
| 2 | Update `models.Stream` — replace `AutoFallback` with three bools | Update all references in `streammgr`, `api`, `fallback`, frontend. |
| 3 | Rewire `fallback.Manager` — gate on `auto_probe` instead of `auto_fallback` | Behavioral parity: probing still works exactly as before, just keyed off the new field. |
| 4 | `go get` aws-sdk-go-v2 dependencies | `s3`, `config`, `credentials` |
| 5 | `internal/s3/client.go` — S3 client wrapper | `NewFromEnv()`, `PutObject`, `PreSignGet`, `DeletePrefix`. CreateBucket on startup for dev. |
| 6 | DB migration — `offloaded_chunks` table (the chunk manifest) | |
| 7 | `internal/db/monitor.go` — queries | InsertChunk, ListChunks, HasChunks, ChunkStats, DeleteExpired |
| 8 | `internal/chunkring/s3sink.go` — implements `ChunkSink` | Serialize + PutObject × 3 + DB insert. ~120 lines. |

**Verification:** Unit test S3Sink against MinIO. Manually attach sink to a running stream's ChunkRing, let it run for 5 minutes, verify chunks appear in S3 and rows appear in the DB. Verify `auto_probe` toggle still controls probing behavior.

### Phase 2: Chunk offload wiring + API

| # | Task | Notes |
|---|---|---|
| 9 | `streammgr` — `StartChunkOffload()`, `StopChunkOffload()` | Attach/detach sink, update stream model. |
| 10 | Wire into PATCH endpoint — toggling `offload_chunks` triggers start/stop | Same PATCH flow as other stream fields. |
| 11 | Extend `GET /api/streams/{id}/rewind` — accept `from`/`to` params, query manifest, return S3 chunks with pre-signed URLs alongside ring chunks | |
| 12 | `GET /api/streams/{id}/chunks/manifest` — aggregate S3 chunk info | For timeline rendering. |
| 13 | `GET /api/streams/{id}/audio?from=...&to=...` — composite WAV export | Stitch audio across ring + S3 chunks. |
| 14 | Crash recovery — resume offloading on startup for streams with `offload_chunks = true` | |

**Verification:** Enable chunk offloading via PATCH. Let it run 10 minutes. Disable. Re-enable. Verify chunks in S3, manifest rows in DB. Fetch a chunk via pre-signed URL — confirm valid WAV. Hit the extended rewind endpoint with a time range — confirm S3 chunks returned with URLs. Hit the composite audio endpoint — confirm stitched WAV.

### Phase 3: Frontend S3 integration

| # | Task | Notes |
|---|---|---|
| 15 | `UnifiedChunkSource` — routes to ring or S3 based on chunk metadata | Replaces `RingBufferSource` when S3 data exists |
| 16 | Wire into waterfall renderer — `loadManifest()` accepts S3 chunks, `fetchChunk()` uses unified source | Existing tile loading pipeline handles the rest. |
| 17 | History loading — on page load (if stream has S3 chunks), fetch manifest + recent history alongside ring chunks | Extends the existing prefill flow. |
| 18 | Pre-signed URL refresh — catch 403, re-fetch from rewind endpoint, retry | |

**Milestone:** Scrolling up past the 5-minute ring buffer loads historical tiles from S3. Same visual experience. Audio playback from S3 chunks works via the existing `HistoricalAudioPlayer`.

### Phase 4: Timeline + UI

| # | Task | Notes |
|---|---|---|
| 19 | Extend vertical timeline — show S3 chunk regions and gaps beyond the ring buffer | The timeline already shows 5 min; extend it with manifest data. |
| 20 | Monitor toggle in UI — single switch that patches all three flags | Simple addition to stream controls. |
| 21 | Advanced toggles — individual `auto_probe`, `quality_fallback`, `offload_chunks` controls | Expandable section for granular control. |
| 22 | Retention sweep — daily cleanup of expired `offloaded_chunks` rows | S3 lifecycle handles object expiry. |
| 23 | Update fallback UI — replace `auto_fallback` toggle with `auto_probe` toggle | Rename in `fallback-section.tsx`. |

**Milestone:** Full monitoring experience — toggle on, chunks go to S3, scroll back through hours of history, toggle off.

---

## Known Hard Parts

1. **Pre-signed URL lifecycle.** URLs expire after 1 hour. If a user leaves a tab open for hours and then scrolls to old chunks, the cached URLs may be stale. The 403-catch-and-refresh pattern handles this, but it adds latency to the first fetch after expiry. Consider pre-emptively refreshing URLs for chunks near the viewport.

2. **Timeline scale transitions.** The timeline needs to handle two very different scales: 5 minutes of ring buffer (where individual chunks are visible) and potentially 30 days of monitoring history (where you need a compressed view). Zooming the timeline smoothly between these scales is a UX challenge. Start with a simple approach: show data regions at the macro level, expand to individual chunks when zoomed in.

3. **Bridging ring buffer and S3.** When the user scrolls from ring buffer territory into S3 territory, there's a moment where the most recent S3 chunk is ~5 minutes old (just evicted from the ring) and might need to be fetched from Tigris. The tile system handles this seamlessly — it just fetches the chunk from S3 instead of the ring — but the first time the user crosses the boundary, there's an extra network round-trip (pre-sign URL fetch + chunk fetch from Tigris).

4. **S3 upload backpressure.** If Tigris is slow or the network is congested, the 3-capacity sink channel fills up and chunks get dropped. This is by design (live streaming is never impacted), but it means the S3 history can have gaps. The frontend should detect time discontinuities between consecutive manifest entries and render them as gap regions.

5. **Memory for serialization.** `OnChunkComplete` serializes the entire chunk into `bytes.Buffer` before uploading. A 1-minute chunk is ~2 MB, so three buffers (audio, WF, events) total ~4 MB allocated per rotation. This is brief (freed after upload) and well within acceptable bounds, but worth noting for very memory-constrained environments.

---

## Edge Cases

### Decided

1. **The three monitoring systems are independent.** `auto_probe`, `quality_fallback`, and `offload_chunks` can be enabled in any combination. The UI's "Monitor" toggle enables all three, but the backend treats each independently.

2. **Settings are NOT locked during chunk offloading.** The user can change frequency, mode, filters, etc. while `offload_chunks` is active. The chunks are self-describing (each WF frame carries its own metadata), so the recording remains coherent. Locking settings adds complexity and reduces flexibility for minimal gain.

3. **No config snapshots.** Chunk-level metadata (frequency, zoom, source, etc.) lives in the chunks themselves. The frontend reads it from the parsed WF frames. The manifest only tracks timestamps and sizes.

4. **S3 is unavailable → chunk offloading is unavailable.** If env vars aren't set, patching `offload_chunks = true` returns 501. `auto_probe` and `quality_fallback` still work without S3.

5. **Stream deletion cascade.** `ON DELETE CASCADE` removes `offloaded_chunks` rows. S3 objects are left to expire via the 30-day lifecycle rule. No proactive S3 cleanup on stream delete.

6. **Recorder failures don't cascade.** The S3Sink runs in the existing sink worker goroutine, which is async and decoupled from the audio/WF pipeline. If S3 is down, chunks are dropped. Live listeners are never impacted.

7. **No manual chunk deletion.** Offloaded chunks expire automatically after 30 days via S3 lifecycle. The backend sweep cleans up the corresponding manifest rows.

### Noted for implementation

8. **Concurrent toggle race.** Two clients patching `offload_chunks` simultaneously. `streammgr` processes requests serially per stream, so at most one sink is attached at a time.

9. **Short final chunks.** When `offload_chunks` is disabled mid-chunk, the in-progress chunk in the ring is NOT uploaded (it hasn't rotated yet). Only complete, rotated chunks go to S3. The last minute of data before disabling is in the ring buffer but not in S3. This is acceptable — the ring buffer serves it for 5 minutes anyway.

10. **Chunk expiry while viewing.** If the retention sweep expires chunks while a user is scrolled into that time range, chunk fetches will 404 from Tigris. Show a "data expired" message and snap to the nearest available data.

11. **Gaps in S3 history.** Detected by time discontinuity between consecutive `offloaded_chunks` rows. If `chunk[N].ended_at` is not close to `chunk[N+1].started_at`, there's a gap (offloading was off, or chunks were dropped). The frontend renders these as dimmed regions on the timeline.
