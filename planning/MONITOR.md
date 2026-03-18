# Monitoring Mode

## What It Does

Monitoring mode puts a stream into continuous, indefinite recording with automatic source failover. It **replaces the existing `auto_fallback` toggle** — monitoring is the "serious mode" that subsumes everything auto-fallback did, plus adds persistent recording of all data.

When monitoring starts:

1. The waveform view locks to the stream's frequency (same as the existing `view_locked` toggle).
2. The zoom level locks to a fixed level — chosen so that waterfall bins are continuous and coherent for the entire session.
3. Audio, waterfall, interpreter output, and timestamped logs begin streaming to Tigris object storage.
4. **Keep-alive** is enabled — the stream never idle-disconnects, even with zero subscribers.
5. **Periodic probing** is enabled — the fallback system discovers and scores nearby KiwiSDR sources every 5 minutes, exactly as the current `auto_fallback` does.
6. **Automatic failover** is enabled — if quality degrades or the KiwiSDR connection fails, the system switches to the top-ranked fallback source. The recording continues seamlessly on the new source.
7. The stream gets a `monitoring` status indicator visible in the UI and API.

The result is a complete, seekable, uninterrupted recording of everything that happened on a frequency — audio you can play back, waterfall you can scroll through, and logs/interpreter data you can read — spanning hours or days, surviving source failures transparently.

### Stop, tweak, resume

A user can stop monitoring, change settings (frequency, mode, filters, etc.), and restart monitoring. Each start creates a new session with the new config. The DVR timeline spans **all sessions** for a stream, stitching them into a unified browsing experience. Gaps between sessions (the time spent tweaking) appear as dimmed/hatched regions on the timeline. When playback crosses a session boundary, the UI updates the displayed settings to reflect the new session's config, and audio continues seamlessly into the next session.

```
Stream: "7 MHz Monitor"

Session A   (7074 kHz, USB)           10:00 ━━━━━━━━━━━━━━ 14:23
                                              gap (7 min tweaking)
Session B   (7074 kHz, USB, NR on)    14:30 ━━━━━━━━━━━━━━ 18:00
                                              gap (5 min tweaking)
Session C   (7080 kHz, LSB)           18:05 ━━━━━━━━━━━━━━ ongoing

DVR timeline:
◄━━━━━━━━━━━━━━┃░░┃━━━━━━━━━━━━━━━┃░┃━━━━━━━━━━━━━━━━━━━●
 Session A      gap  Session B      gap Session C      LIVE
```

This means sessions are **not isolated silos** — they're segments of a continuous monitoring history for the stream.

### Relationship to `auto_fallback`

The existing `auto_fallback` toggle (see FALLBACK.md) provides three things: keep-alive, periodic probing, and automatic failover. Monitoring mode provides all three, plus recording. There is no use case for "auto-failover without recording" that justifies a separate toggle — if you care enough about a frequency to keep it alive and auto-failover, you care enough to record it.

When this feature ships, the `auto_fallback` field is **removed** from the stream model. The migration path:

1. Any stream with `auto_fallback = true` gets a prompt in the UI: "This stream uses auto-fallback. Enable monitoring to keep auto-failover and start recording."
2. The `auto_fallback` column is dropped. The `monitoring` column replaces it.
3. The fallback infrastructure (`internal/fallback/`) is unchanged — monitoring mode simply calls `fallback.Manager.Enable()` on start and `fallback.Manager.Disable()` on stop, exactly as `auto_fallback` did.
4. The fallback UI section (probe results, manual source switching) remains in the info panel — it's still useful during monitoring to see which fallback sources are ranked and to manually trigger a reprobe. It just no longer has its own on/off toggle.

---

## Why This Matters

Monitoring unifies three previously separate concerns — stay-alive, auto-failover, and recording — into a single mode:

| | Normal stream | Auto-fallback (being removed) | Monitoring |
|---|---|---|---|
| Keep-alive | No (idle-disconnects after 10m) | Yes | Yes |
| Auto-failover | No | Yes | Yes |
| Periodic probing | Manual only | Every 5 min | Every 5 min |
| Recording | None (ring buffer only) | None | Full (audio + WF + interpreter + logs) |
| Storage | In-memory ring buffer | None | Tigris (survives restarts) |
| Duration | Ring buffer: 5–15 min | Indefinite connection | Indefinite connection + recording |
| Purpose | Casual listening | Unattended listening | Unattended surveillance with full history |

---

## Data Rates & Storage

### Audio (PCM16, 12 kHz mono)

| Period | Size |
|--------|------|
| 1 minute | 1.44 MB |
| 1 hour | 86.4 MB |
| 24 hours | 2.07 GB |

### Waterfall (locked zoom)

Each waterfall frame is ~1024 bins at ~5–10 fps. At a locked zoom level, waterfall data is roughly:

| Period | Size (~8 fps × 1 KB/frame) |
|--------|------|
| 1 minute | 480 KB |
| 1 hour | 28.8 MB |
| 24 hours | 691 MB |

### Interpreter output + logs

Negligible relative to audio and waterfall — tens of KB per hour at most.

### Total estimate

| Period | Audio + WF + metadata |
|--------|------|
| 1 hour | ~115 MB |
| 24 hours | ~2.76 GB |
| 7 days | ~19.3 GB |

### Cost (Tigris, 30-day retention)

Tigris charges $0.02/GB/month for storage. Egress is **free** — no transfer fees when the frontend fetches chunks via pre-signed URLs. The first 5 GB of storage is free.

#### Storage

| Scenario | Data stored | Storage cost/month |
|----------|-------------|-------------------|
| 1 stream, 30 days | ~83 GB | **$1.66** |
| 2 streams, 30 days | ~166 GB | **$3.31** |
| 3 streams, 30 days | ~249 GB | **$4.97** |
| 5 streams, 30 days (tenant cap) | ~414 GB | **$8.28** |

#### S3 requests

Each monitored stream uploads 3 objects per 5-minute chunk rotation (audio, WF, events). That's ~864 Class A (PUT) requests per stream per day.

| | Requests/month (1 stream) | Cost |
|--|--------------------------|------|
| Class A (PUT) — writes | ~25,920 | $0.13 |
| Class B (GET) — reads | Varies with usage | $0.0005/1000 |

First 10,000 Class A and 100,000 Class B requests per month are free. For a single monitored stream, the request cost is ~$0.13/month. For 5 streams, ~$0.65/month.

#### Total cost estimate

| Streams monitored | Storage | Requests | **Total/month** |
|-------------------|---------|----------|-----------------|
| 1 | $1.66 | $0.13 | **$1.79** |
| 2 | $3.31 | $0.26 | **$3.57** |
| 3 | $4.97 | $0.39 | **$5.36** |
| 5 (tenant cap) | $8.28 | $0.65 | **$8.93** |

Retention is fixed at 30 days. Sessions older than 30 days are auto-deleted via S3 lifecycle rules on the bucket, with a backend sweep to clean up the corresponding DB records. There is no manual session deletion — sessions either have an active recording or they're waiting to expire.

---

## Storage: Tigris (S3-Compatible Object Storage)

Tigris is Fly.io's built-in S3-compatible object storage. It's accessed over the local Fly network with no cross-provider egress, provisioned from the Fly dashboard, and billed at **$0.02/GB/month** for storage with the first 5 GB free. Compared to Fly Volumes ($0.15/GB/month for fixed-size NVMe), Tigris is ~7.5x cheaper and elastic — you pay only for what you store.

### Setup

Create a Tigris bucket via the Fly CLI:

```bash
fly storage create --name monitor-data
```

This provisions a bucket and sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, and `BUCKET_NAME` as secrets on the app. Set `S3_KEY_PREFIX=prod` as an additional secret. The Go backend uses the standard AWS SDK for S3 (`aws-sdk-go-v2`) to read/write objects. All keys are prefixed with `prod/` in production and `dev/` in development.

### Dev setup

The S3 client is configured via environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `BUCKET_NAME`, `S3_KEY_PREFIX`). This means dev and prod use the exact same code path — only the env vars differ.

**Option A: Use Tigris directly (recommended).** Same bucket, different prefix:

```
S3_KEY_PREFIX=dev
```

Copy the bucket credentials into your `.env` file (already gitignored). Your dev machine talks to Tigris over the internet — slightly higher latency than on-Fly, but the data rates (~115 MB/hour) are small enough that it doesn't matter. This is the simplest setup: no extra local infrastructure, you're testing against the real storage backend, and dev data is isolated under the `dev/` prefix.

**Option B: MinIO for offline dev.** If you need to work without internet, add MinIO to `docker-compose.yml`:

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

Then set these env vars in `.env`:

```
AWS_ENDPOINT_URL_S3=http://localhost:9000
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
BUCKET_NAME=monitor-data
S3_KEY_PREFIX=dev
```

MinIO is fully S3-compatible — same API, same SDK calls, no code changes. The MinIO console at `http://localhost:9001` lets you browse uploaded objects for debugging. The bucket must be created on first run (the S3 client wrapper should call `CreateBucket` if it doesn't exist, which is a no-op in prod since Tigris creates it via `fly storage create`).

### Write path

The recorder writes chunks to a local temp directory first (ephemeral filesystem), then uploads each completed chunk to Tigris as an S3 object. The local file is deleted after successful upload. This means the ephemeral filesystem only ever holds one in-progress audio chunk (~7.2 MB) and one in-progress WF chunk (~2.4 MB) per monitored stream — well within the root filesystem's capacity.

### Read path

The backend generates **pre-signed S3 URLs** for chunk reads. The frontend fetches chunks directly from Tigris using these URLs, bypassing the backend entirely for data transfer. Pre-signed URLs expire after a configurable TTL (e.g., 1 hour). This keeps chunk serving off the backend's CPU and bandwidth.

---

## Monitoring Sessions

A stream has **many** monitoring sessions over its lifetime. Each session is an immutable recording with fixed config — when the user stops monitoring, tweaks settings, and restarts, a new session is created. The DVR timeline stitches all sessions together into a unified view.

A monitoring session is a first-class object:

```go
type MonitorSession struct {
    ID            string             `json:"id"`
    StreamID      string             `json:"stream_id"`
    State         string             `json:"state"` // active, stopped
    StartedAt     time.Time          `json:"started_at"`
    StoppedAt     *time.Time         `json:"stopped_at,omitempty"`
    FrequencyKHz  float64            `json:"frequency_khz"`
    Mode          string             `json:"mode"`
    ZoomLevel     int                `json:"zoom_level"`
    BandwidthLow  int                `json:"bandwidth_low_hz"`
    BandwidthHigh int                `json:"bandwidth_high_hz"`
    Filters       FilterConfig       `json:"filters"`
    Interpreter   interpreter.Config `json:"interpreter"`
    Sources       []SessionSource    `json:"sources"`
    Chunks        int                `json:"chunks"`
    SizeBytes     int64              `json:"size_bytes"`
    DurationSec   float64            `json:"duration_seconds"`
    S3Prefix      string             `json:"-"` // e.g. "prod/sessions/{id}/"
}

type SessionSource struct {
    SourceID  string    `json:"source_id"`
    Host      string    `json:"host"`
    Port      int       `json:"port"`
    StartedAt time.Time `json:"started_at"`
}
```

### Database table

```sql
CREATE TABLE monitor_sessions (
    id             TEXT PRIMARY KEY,
    stream_id      TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    state          TEXT NOT NULL DEFAULT 'active',
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at     TIMESTAMPTZ,
    frequency_khz  DOUBLE PRECISION NOT NULL,
    mode           TEXT NOT NULL,
    zoom_level     INT NOT NULL,
    bandwidth_low  INT NOT NULL,
    bandwidth_high INT NOT NULL,
    filters        JSONB NOT NULL DEFAULT '{}',
    interpreter    JSONB NOT NULL DEFAULT '{}',
    sources        JSONB NOT NULL DEFAULT '[]',
    chunks         INT NOT NULL DEFAULT 0,
    size_bytes     BIGINT NOT NULL DEFAULT 0,
    duration_sec   DOUBLE PRECISION NOT NULL DEFAULT 0,
    s3_prefix      TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_monitor_sessions_stream ON monitor_sessions(stream_id);
CREATE UNIQUE INDEX idx_monitor_sessions_active ON monitor_sessions(stream_id) WHERE state = 'active';
```

### S3 key layout

All objects for a session live under a common prefix in the Tigris bucket, scoped by environment:

```
{env}/sessions/{session_id}/
    audio/
      chunk-000000.wav      # 5-minute WAV chunks
      chunk-000001.wav
      ...
    waterfall/
      chunk-000000.bin      # 5-minute waterfall chunks
      chunk-000001.bin
      ...
    events/
      events-000000.jsonl   # 5-minute event log chunks
      events-000001.jsonl
      ...
```

`{env}` is `prod` or `dev`, set via the `S3_KEY_PREFIX` environment variable. This allows a single Tigris bucket for all environments with clean key isolation. Lifecycle rules can be scoped to the `prod/` prefix if dev data should expire on a different schedule (or not at all during active development).

### Chunked file format

All data is written in **5-minute chunks**. This aligns with S3's object model (you can't append to an object — you write it once). Each chunk is accumulated locally, then uploaded as a single S3 PutObject when the 5-minute window completes.

Benefits:

- **S3-native.** Each chunk is an immutable object. No append operations needed.
- **Seekability.** To play minute 47, load `chunk-000009.wav` and seek to minute 2 within it.
- **Lazy loading.** The frontend loads chunks on demand via pre-signed URLs, not the entire session.
- **Retention granularity.** S3 lifecycle rules can expire old objects automatically.

Each audio chunk is a standard WAV file (PCM16, 12 kHz, mono) — ~7.2 MB per chunk.

Each waterfall chunk is a simple binary file: a sequence of `[timestamp_ms (uint64 LE)][num_bins (uint16 LE)][bins (uint8[])]` frames. ~2.4 MB per chunk.

Each event chunk is a newline-delimited JSON file containing log entries, interpreter output, and state changes for that 5-minute window:

```json
{"t": 1710500000123, "type": "log", "level": "info", "msg": "Connected to KiwiSDR at ..."}
{"t": 1710500005456, "type": "interpreter", "interpreter": "voice", "text": "CQ CQ CQ this is..."}
{"t": 1710500010789, "type": "source_switch", "from_source_id": "src_abc", "to_source_id": "src_def", "reason": "quality_degraded", "snr_before": 6.2, "snr_after": 18.4}
{"t": 1710500015000, "type": "log", "level": "info", "msg": "SNR recovered after source switch"}
```

The `t` field is Unix milliseconds. The frontend groups these by minute for display.

The `source_switch` event is emitted whenever the fallback system switches to a different KiwiSDR source. It records `from_source_id` and `to_source_id` (matching the existing `fallback_switch` WebSocket event format and the `sources.id` field in the DB), the reason for the switch (e.g., `quality_degraded`, `connection_lost`, `manual`), and signal quality metrics. Audio and waterfall recording are continuous across source switches — the recorder doesn't care which source is feeding it — so there is no gap in the data. The switch is purely an informational marker.

The session's `sources` field in the DB (JSONB) is an ordered log of every source used during the session, with the timestamp of when each became active. The first entry is the source the session started on. A source can appear multiple times if the system switches away and back. The recorder appends to this array on each source switch and updates the DB row. This gives a complete source history for the session without needing to parse all event chunks.

---

## Backend: Recording Pipeline

### `internal/monitor/recorder.go`

The recorder is a goroutine that subscribes to a stream's audio, waterfall, interpreter, and log channels, buffers data locally, and uploads completed chunks to Tigris.

```
streammgr.activeStream
  ├── audio subscriber ───────→ recorder.audioIn
  ├── wf subscriber ──────────→ recorder.wfIn
  ├── interpreter callback ───→ recorder.interpIn
  └── log callback ───────────→ recorder.logIn

recorder goroutine
  ├── audio frames → local WAV buffer → every 5 min: S3 PutObject → delete local
  ├── wf frames → local bin buffer → every 5 min: S3 PutObject → delete local
  └── events → local jsonl buffer → every 5 min: S3 PutObject → delete local
  └── every 5 min: UPDATE monitor_sessions SET chunks, size_bytes, duration_sec
```

Key responsibilities:

| Component | Behavior |
|-----------|----------|
| `AudioChunkWriter` | Accumulates PCM16 frames to a local temp file. Every 5 minutes, finalizes the WAV header, uploads to `sessions/{id}/audio/chunk-NNNNNN.wav`, deletes the local file. |
| `WFChunkWriter` | Accumulates waterfall frames with timestamps to a local temp file. Uploads on rotation. |
| `EventChunkWriter` | Buffers interpreter output and log lines as JSONL. Uploads on rotation. |
| `SessionUpdater` | On every chunk rotation, updates the `monitor_sessions` DB row with current `chunks`, `size_bytes`, and `duration_sec`. On source switches, appends to the `sources` JSONB array. |

Local temp files live in an OS temp directory (e.g., `/tmp/monitor-{session_id}/`). At most 3 files are open at a time per monitored stream (one audio, one WF, one events) — totaling ~10 MB. The ephemeral root filesystem handles this easily.

### Recorder isolation

The recorder must never cascade failures into the rest of the system. It subscribes to audio/WF channels via buffered channels. If the recorder falls behind (S3 slow, disk full, bug), it drops frames from its own buffers — it does **not** block the `streammgr` audio/WF pipeline, which would affect live listeners. The recorder logs dropped frames as within-session gaps.

If an S3 upload fails, the recorder retries once, then discards the local chunk and moves on. The lost chunk becomes a gap in the recording. Monitoring sessions are best-effort — they are not guaranteed to be 100% continuous. The system prioritizes the live stream experience over recording completeness.

### Integration with `streammgr`

When monitoring is started on a stream:

1. `streammgr` sets `stream.ViewLocked = true` and locks the zoom level, mode, bandpass, and filters.
2. `streammgr` creates a `monitor.Recorder` and subscribes it to audio + WF channels.
3. `streammgr` wires the interpreter output callback to also forward to the recorder.
4. `streammgr` wires the log callback to also forward to the recorder.
5. `streammgr` calls `fallback.Manager.Enable(streamID)` — starts keep-alive, periodic probing, and auto-failover. This is the same code path that the old `auto_fallback` toggle used.
6. `streammgr` calls `SetAutoFallback(true)` on the pump to enable the quality monitor.
7. The stream's state includes a `monitoring: true` flag and `monitor_session_id`.

When monitoring is stopped:

1. The recorder finalizes and uploads the current in-progress chunks (even if less than 5 minutes).
2. The recorder updates the DB row with final chunk counts, size, and duration.
3. `streammgr` unsubscribes the recorder.
4. `streammgr` calls `fallback.Manager.Disable(streamID)` — stops periodic probing. Existing fallback suggestions are preserved.
5. `streammgr` calls `SetAutoFallback(false)` on the pump — disables the quality monitor.
6. The session state is set to `stopped`, `stopped_at` is recorded.
7. All settings are unlocked — frequency, zoom, mode, bandpass, filters, and interpreter config become editable again. `view_locked` is released. The stream returns to normal idle-disconnect behavior.

When a stream is deleted:

1. If monitoring is active, the recorder is stopped immediately (no final chunk upload — the stream is being destroyed).
2. The `ON DELETE CASCADE` on `monitor_sessions.stream_id` removes all session DB records.
3. S3 objects under the session prefixes are **not** proactively deleted — they expire naturally via the 30-day lifecycle rule. Orphaned S3 objects with no matching DB record are harmless and will be cleaned up by the lifecycle.

### Crash recovery

On startup, the backend checks for any sessions in `active` state in the DB:

- If the stream is still running, resume recording. The recorder reads `chunks` from the DB row to determine the last completed chunk index, and continues from there. (As a safety check, it can also `ListObjects` under the S3 prefix to verify the true count.) The fallback system is also re-enabled (`fallback.Manager.Enable`), restoring keep-alive and periodic probing. The in-progress local temp files from before the crash are lost (at most 5 minutes of data), which is acceptable.
- If the stream no longer exists, mark the session as `stopped` with `stopped_at = now()`. All completed chunks in S3 are intact — only the in-progress chunk at the time of crash is lost.

Since completed chunks are immutable S3 objects, crash recovery is simpler than with local filesystem storage. There's no risk of corrupted files on disk — a chunk either made it to S3 or it didn't.

---

## API

### Start monitoring

```
POST /api/streams/{id}/monitor
```

Response: the newly created `MonitorSession` object. Fails if the stream already has an active session.

### Stop monitoring

```
DELETE /api/streams/{id}/monitor
```

Stops the active monitoring session. Returns the finalized session object.

### Get active session

```
GET /api/streams/{id}/monitor
```

Returns the active monitoring session for the stream, or 404 if none.

### Get stream timeline

```
GET /api/streams/{id}/monitor/timeline
```

Returns all sessions for the stream as an ordered timeline. This is the primary endpoint the DVR timeline component uses to render the multi-session view.

```json
{
  "stream_id": "stream-uuid",
  "sessions": [
    {
      "id": "session-a",
      "started_at": "2026-03-15T10:00:00Z",
      "stopped_at": "2026-03-15T14:23:00Z",
      "frequency_khz": 7074.0,
      "mode": "usb",
      "zoom_level": 10,
      "bandwidth_low_hz": 300,
      "bandwidth_high_hz": 2700,
      "filters": { "nr": false },
      "chunks": 53
    },
    {
      "id": "session-b",
      "started_at": "2026-03-15T14:30:00Z",
      "stopped_at": "2026-03-15T18:00:00Z",
      "frequency_khz": 7074.0,
      "mode": "usb",
      "zoom_level": 10,
      "bandwidth_low_hz": 300,
      "bandwidth_high_hz": 2700,
      "filters": { "nr": true, "nr_level": 2 },
      "chunks": 42
    },
    {
      "id": "session-c",
      "started_at": "2026-03-15T18:05:00Z",
      "stopped_at": null,
      "frequency_khz": 7080.0,
      "mode": "lsb",
      "zoom_level": 10,
      "bandwidth_low_hz": -2700,
      "bandwidth_high_hz": -300,
      "filters": {},
      "chunks": 15
    }
  ],
  "active_session_id": "session-c"
}
```

The frontend computes gaps from the `stopped_at` of session N and the `started_at` of session N+1. Sessions are ordered chronologically (oldest first).

### Get session details

```
GET /api/monitor/sessions/{sessionId}
```

Returns the full session object from the DB, including config, sources, chunk counts, and duration.

### Get chunk URLs

```
GET /api/monitor/sessions/{sessionId}/chunks?from={chunkIndex}&count=3
```

Returns pre-signed Tigris URLs for audio, waterfall, and event chunks. The frontend fetches chunks directly from Tigris, keeping data transfer off the backend. URLs expire after 1 hour.

```json
{
  "chunks": [
    {
      "index": 9,
      "audio_url": "https://fly.storage.tigris.dev/monitor-data/sessions/.../audio/chunk-000009.wav?X-Amz-...",
      "wf_url": "https://fly.storage.tigris.dev/monitor-data/sessions/.../waterfall/chunk-000009.bin?X-Amz-...",
      "events_url": "https://fly.storage.tigris.dev/monitor-data/sessions/.../events/events-000009.jsonl?X-Amz-..."
    }
  ]
}
```

### WebSocket events

When monitoring starts/stops, broadcast to subscribers:

```json
{"type": "monitor_started", "session": { ... }}
{"type": "monitor_stopped", "session": { ... }}
```

The stream update event also includes `monitoring: true/false` and `monitor_session_id`.

Source failovers during monitoring are recorded as `source_switch` events in the session's event log and broadcast as usual via `fallback_switch` over WebSocket. The recording continues uninterrupted — the recorder doesn't care which KiwiSDR source is providing the audio and waterfall frames. There is no gap in audio or waterfall data across a source switch.

---

## UI: Seamless Rewind (DVR Model)

The main UI gains a **timeline scrubber** — like YouTube's seekbar when watching a livestream. The timeline spans **all monitoring sessions** for the stream, showing them as solid segments with gaps between them. Tapping/dragging backwards transitions the entire main view into recorded data. A "LIVE" pill jumps you back to the present.

### Layout

```
LIVE VIEW (monitoring active, 3 sessions):
┌──────────────────────────────────────────────────────────────────────┐
│  Stream Header   [7080.0 kHz] [LSB]  [Monitor ●]    [🔴 LIVE]     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Live Spectrum + Waterfall                                           │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                             │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                             │
│                                                                      │
│  ◄━━━━━━━━━━━━━━┃░░┃━━━━━━━━━━━━━━━┃░┃━━━━━━━━━━━━━━━━━━━━━━━━━●  │
│  Session A       gap Session B       gap Session C              LIVE │
│  10:00          14:23 14:30         18:00 18:05                      │
└──────────────────────────────────────────────────────────────────────┘

REWOUND into Session A (different config than current):
┌──────────────────────────────────────────────────────────────────────┐
│  Stream Header   [7074.0 kHz] [USB]  [Monitor ●]  [→ Jump to LIVE] │
│  ⚠ Viewing recorded data from 8h ago  ·  Session A                  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Recorded Spectrum + Waterfall (from Session A)                      │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                             │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                             │
│                                                                      │
│  ◄━━━━━●━━━━━━━━┃░░┃━━━━━━━━━━━━━━━┃░┃━━━━━━━━━━━━━━━━━━━━━━━━━▸  │
│     ~12:30       gap                 gap                        LIVE │
│                                                                      │
│  ▶ Playing   12:30:15                                               │
└──────────────────────────────────────────────────────────────────────┘
```

### How it works

When monitoring is **active** on a stream, a **timeline bar** appears at the bottom of the main waterfall area. It spans from the oldest session's start time to "LIVE" (the current moment). The bar is only visible while `stream.monitoring === true` — when monitoring is stopped, the bar disappears. Historical sessions are still listed in the monitor panel's session list, but the main DVR rewind experience requires active monitoring. The user can:

1. **Scrub backwards** by dragging the timeline handle left. The handle snaps to session segments — it can't land in a gap.
2. The **main waterfall** switches from live data to recorded waterfall data from the session at that point in time. Within a session, the recorded data has the exact same zoom/frequency as when it was recorded.
3. The **spectrum display** switches to the recorded spectrum for the current playback position.
4. **Audio** switches from live to recorded. The live WebSocket audio is silenced (but the connection stays open — the ring buffer keeps accumulating).
5. **Settings update to match the session.** When the user scrubs into a session that was recorded at different settings (e.g., scrubbing from Session C at 7080/LSB back into Session A at 7074/USB), the displayed frequency, mode, bandpass, and filter values in the header update to reflect Session A's config. The controls remain greyed out.
6. **Interpreter data** in the interpreter panel switches to showing recorded interpreter output for the current playback position and session.
7. **Logs** in the logs panel switch to recorded logs for the current session.
8. **"Jump to LIVE"** button — clicking it snaps the timeline to the present, crossfades back to live waterfall, unmutes live audio, and restores the current (active) session's settings in the UI.

### Gaps

Gaps appear in the timeline in two situations:

1. **Between sessions** — the user stopped monitoring, tweaked settings, and restarted. The gap duration is `session[N+1].started_at - session[N].stopped_at`.
2. **Within a session** — the recorder failed to upload a chunk due to a crash, network issue, or KiwiSDR disconnect. These are detected by missing chunk indices (e.g., chunk 12 exists, chunk 13 doesn't, chunk 14 exists).

Both types are rendered as **dimmed/hatched regions** on the timeline bar. The handle cannot be dragged into a gap. During audio playback, when the engine reaches the end of the data before a gap, it:

1. Pauses briefly (100ms silence).
2. Skips to the start of the next segment (next chunk or next session).
3. If crossing a session boundary, loads the new session's config from the timeline data and updates the UI.
4. Resumes playback.

### All settings are locked

When monitoring starts, **all stream configuration is frozen** for the duration of the session:

| Setting | Locked? | Stored in DB |
|---------|---------|-------------|
| Frequency | Yes | `frequency_khz` |
| Zoom level | Yes | `zoom_level` |
| Mode (AM/USB/LSB/CW/NBFM) | Yes | `mode` |
| Bandpass (low/high) | Yes | `bandwidth_low`, `bandwidth_high` |
| Filters | Yes | `filters` (JSONB) |
| Interpreter config | Yes | `interpreter` (JSONB) |

The stream becomes a fixed observation point. The PATCH endpoint rejects changes to any of these fields while `monitoring = true`, returning a 409 with a message indicating the stream is in monitoring mode. To change settings, the user stops monitoring, reconfigures, and starts a new session.

This is a deliberate constraint, not a limitation. It means:

- Each session's recording is uniform — every chunk has identical demodulation settings.
- The rewind experience within a session is trivial — the DB row describes the settings once.
- The waterfall data within a session is continuous — same zoom and frequency throughout, so recorded frames render identically to live frames.
- Controls in the UI are greyed out with a clear label ("Locked — monitoring active") while monitoring is active.
- When rewinding across sessions with different configs, the UI updates the displayed settings (frequency, mode, etc.) to match the session being viewed. Controls remain greyed out and read-only.

### Feasibility

Is the seamless DVR model technically feasible? **Yes, with monitoring's constraints.** Here's why it's tractable:

1. **Zoom and frequency are locked per session.** Within a session, the recorded waterfall data has the exact same bin layout as when it was recorded. No coordinate translation needed — you can literally swap the data source and the waterfall renders identically. Across sessions with different zoom/frequency, the waterfall re-renders with the new session's parameters.

2. **Chunked storage aligns with lazy loading.** 5-minute chunks are small enough to fetch quickly (~7 MB audio + ~2.4 MB WF). The frontend keeps 2-3 chunks in memory around the current playback position and fetches ahead/behind as the user scrubs.

3. **Audio playback is solved.** RINGBUFFER.md already designed the AudioWorklet playback engine for captures. The same engine works here, just fed from chunked WAV files instead of a single WAV.

4. **Settings are constant per session.** Each session's DB row describes its settings once. When crossing session boundaries, the UI reads the new session's config (already loaded via the timeline endpoint) and updates displayed settings — a simple swap, not a complex history replay.

5. **The timeline is a 1D scrubber.** Unlike a 2D pan (frequency × time), scrubbing through monitoring data is a single axis: time. This is fundamentally simpler than the existing waterfall zoom/pan interaction.

What makes it harder than a dedicated panel:

- **Main waterfall rendering must support two data sources** — live (from WebSocket) and recorded (from chunked files). This requires a mode flag in the waterfall display component and careful buffer management.
- **Crossfade between live and recorded** must feel smooth. When the user scrubs from "LIVE" to a historical position, the waterfall should transition without a jarring jump.
- **Audio source switching** must be glitch-free — the same AudioWorklet challenge identified in RINGBUFFER.md.

These are engineering challenges, not architectural blockers.

### Monitor tab as companion

The DVR timeline is the primary interaction surface, but a **Monitor tab** in the info panel sidebar serves as the control panel and session browser:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Stream Header   [7074.0 kHz] [USB]  [Monitor ●]  [→ LIVE]        │
├──────────────┬───────────────────────────────────────────────────────┤
│              │  [Source] [Filters] [Interp] [Logs] [Monitor]        │
│              │  ┌─────────────────────────────────────────────┐     │
│  Recorded    │  │  ● MONITORING  (2h 14m)     [Stop]         │     │
│  Waterfall   │  │                                             │     │
│  (full       │  │  ── Events (minute 47, Session B) ────     │     │
│   width)     │  │  00:47:02 [info] Signal detected            │     │
│              │  │  00:47:05 [voice] "CQ CQ CQ DE..."         │     │
│              │  │  00:47:12 [info] SNR: 14 dB                 │     │
│              │  │                                             │     │
│  ◄━━━━●━━━━▸ │  │  ── Sessions ──────────────────────        │     │
│  timeline    │  │  ● C  18:05–now   7080/LSB  (2h 14m)       │     │
│  (multi-     │  │    B  14:30–18:00 7074/USB  (3h 30m)       │     │
│   session)   │  │    A  10:00–14:23 7074/USB  (4h 23m)       │     │
│              │  └─────────────────────────────────────────────┘     │
└──────────────┴───────────────────────────────────────────────────────┘
```

---

## Frontend: DVR Timeline Component

### `frontend/src/components/monitor/dvr-timeline.tsx`

A horizontal bar rendered at the bottom of the waterfall area when monitoring is active on the stream. Inspired by YouTube/Twitch live DVR controls, extended for multi-session support. The bar is only visible while `stream.monitoring === true`.

```
 ◄━━━━━━━━━━━━━━┃░░┃━━━━━━━━━━━━━━━┃░┃━━━━━━━━━━━━━━━━━━━━━━●
 10:00     Session A  14:30  Session B  18:05  Session C    LIVE
                 ▲ gaps (hatched)              ▲ drag handle
```

- **Solid segments** = sessions. Each session segment can be subtly colored or labeled.
- **Hatched/dimmed regions** = gaps between sessions (or within sessions due to recording failures).
- **Red dot** at the right edge = LIVE position. When the handle is here, the stream plays live.
- **Dragging left** enters rewind mode. The handle snaps to positions within session segments — it cannot stop inside a gap.
- **Time labels** appear at intervals along the bar.
- **Tick marks** indicate events within each session segment. Interpreter detections appear as small dots. **Source switches** appear as a distinct marker (e.g., a small ⚡ or colored flag) so the user can see at a glance when the fallback system switched KiwiSDR sources. Hovering a source-switch marker shows a tooltip with the source host:port and reason, e.g., "kiwi1.example.com:8073 → kiwi2.example.com:8073 (quality degraded, SNR 6→18 dB)."
- **Keyboard shortcuts**: left/right arrow keys move ±30 seconds (skipping gaps automatically), `L` jumps to live.
- On startup, the component fetches the timeline from `GET /api/streams/{id}/monitor/timeline` and builds the segment layout. It re-fetches periodically (every chunk rotation) to pick up new chunks in the active session.

### State machine

```
                  user scrubs back
    LIVE ──────────────────────────→ REWIND
     │                                  │
     │     user clicks "LIVE" pill      │
     ◄──────────────────────────────────┘
     │     or scrubs to live edge       │
     ◄──────────────────────────────────┘
```

In `LIVE` mode:
- Live audio plays through speakers.
- Live waterfall renders from WebSocket.
- Controls are locked (monitoring freezes all stream configuration).
- Timeline handle sits at right edge.

In `REWIND` mode:
- Recorded audio plays (or is paused) through the playback engine.
- Recorded waterfall renders from chunk files.
- Controls show the config of the session being viewed (may differ from current session if settings were changed between sessions). Controls remain greyed out.
- A banner says "Viewing recorded data from X ago · Session N."
- The "LIVE" pill glows/pulses to invite the user back.
- Play/pause button for recorded audio.
- Crossing a session boundary updates the displayed config and loads the next session's chunks.

### Chunk loading strategy

The frontend maintains a **sliding window** of loaded chunks. Chunks are always scoped to a session — the loader knows which session it's in and uses that session's pre-signed URLs.

```
                    loaded chunks (within session B)
              ┌──────────┬──────────┬──────────┐
              │ chunk N-1│ chunk N  │ chunk N+1│
              └──────────┴──────────┴──────────┘
                         ▲
                   current position
```

- Always keep the current chunk and ±1 neighbor loaded.
- When the user scrubs to a new position, determine which session contains that timestamp, then compute the chunk index within that session (`floor((timestamp - session.started_at) / 300)`). Fetch from that session's S3 prefix.
- Prefetch the next chunk when playback reaches 80% of the current chunk.
- **Near session boundary:** when the current chunk is the last chunk of a session, prefetch the first chunk of the next session (if one exists). The next session's config is already available from the timeline data.
- Evict chunks more than 2 positions away from current to bound memory usage.
- **Crossing a session boundary:** the chunk loader detects that the next chunk belongs to a different session, swaps the active session context, updates the UI config display, and continues loading from the new session's S3 prefix.

### Waterfall rendering in rewind mode

The `WaterfallDisplay` component currently takes live frames via `pushFrame()`. For rewind mode, we add a `setHistoricalFrames(frames: WFFrame[])` method:

1. When entering rewind mode, load the relevant waterfall chunk.
2. Parse the binary format into an array of `WFFrame` objects.
3. Pass them to the waterfall display, which renders them as a static (or slowly-scrolling) image.
4. As the playback position advances, new frames scroll into view from the bottom (same as live, but fed from recorded data instead of WebSocket).

The spectrum display gets a similar treatment — it shows the spectrum for the current playback frame.

---

## Frontend: Monitor Panel Component

### `frontend/src/components/monitor/monitor-panel.tsx`

New tab in the `InfoPanelHolder`.

#### Sections

1. **Status bar.** Shows "Monitoring" with a pulsing indicator when active, current session duration, and total storage usage across all sessions. Start/stop button.

2. **Event viewer.** Shows events (logs + interpreter output + source switches) for the minute the user is currently viewing. In LIVE mode, shows the most recent minute. In REWIND mode, shows the minute at the current playback position within whatever session is active. Each event has a timestamp and type icon. Click an event to scrub the timeline to that exact moment. **Source switch events** are rendered as prominent cards with the old/new source host:port, the reason (quality degraded, connection lost, manual), and signal quality before/after. This makes it easy to correlate audio quality changes with source switches when reviewing recorded data.

3. **Session list.** All sessions for this stream, ordered chronologically. Each entry shows: date range, duration, size, and the config snapshot (frequency, mode) so the user can see what changed between sessions. Click a session to jump the DVR timeline to that session's start. The currently-viewed session is highlighted. Sessions cannot be manually deleted — they expire automatically after 30 days via the retention policy.

---

## Stream Model Changes

Replace `auto_fallback` with `monitoring` on the `Stream` struct:

```go
type Stream struct {
    // ... existing fields ...
    // AutoFallback bool — REMOVED
    Monitoring       bool    `json:"monitoring"`
    MonitorSessionID *string `json:"monitor_session_id,omitempty"`
}
```

Migration:

```sql
ALTER TABLE streams ADD COLUMN monitoring BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE streams ADD COLUMN monitor_session_id TEXT REFERENCES monitor_sessions(id);
ALTER TABLE streams DROP COLUMN auto_fallback;
```

Streams that had `auto_fallback = true` are not automatically migrated to monitoring — the user must explicitly enable monitoring. The migration sets `monitoring = false` for all streams; the old `auto_fallback` column is dropped.

When monitoring starts, set `monitoring = true` and `monitor_session_id = session.ID`. When it stops, set `monitoring = false` and `monitor_session_id = NULL`.

The `view_locked` field is set to `true` when monitoring starts. When monitoring stops, `view_locked` is kept as-is (the user can unlock manually).

### Frontend cleanup

The existing `FallbackSection` component in the info panel loses its `auto_fallback` toggle. The fallback probe results and manual source-switch UI remain — they're surfaced inside the monitor panel or kept as a sub-section. The toggle is replaced by the monitor start/stop button.

---

## Implementation Order

### MVP: Backend recording pipeline

The goal is: start monitoring on a stream, let it run, stop it, and verify that valid audio/waterfall/event chunks are sitting in Tigris with correct DB records. No frontend yet — test with curl and the AWS CLI.

| # | Task |
|---|------|
| 1 | Tigris bucket (`fly storage create`), `aws-sdk-go-v2` dependency, S3 client wrapper with `S3_KEY_PREFIX` support |
| 2 | DB migrations: `monitor_sessions` table, add `monitoring` + `monitor_session_id` to `streams`, drop `auto_fallback` |
| 3 | `internal/db/monitor.go` — CRUD for monitor sessions |
| 4 | `internal/monitor/recorder.go` — chunked WAV writer, WF writer, event writer with S3 upload on rotation, DB row updates on each rotation |
| 5 | Wire into `streammgr` — start/stop recording, subscribe to audio/WF/interpreter/logs, lock all settings, enable/disable fallback system |
| 6 | REST endpoints: `POST /api/streams/{id}/monitor`, `DELETE /api/streams/{id}/monitor`, `GET /api/streams/{id}/monitor`, `GET /api/streams/{id}/monitor/timeline`, `GET /api/monitor/sessions/{sessionId}/chunks` |
| 7 | Crash recovery — check DB for active sessions on startup, resume or finalize |

**Verification:** Start monitoring on a stream. Let it run for 10+ minutes. Stop it. Tweak settings, start again. Verify:
- Two sessions in the DB with correct configs and timestamps.
- `aws s3 ls s3://monitor-data/dev/sessions/{id}/audio/` shows chunk files.
- Download a chunk with a pre-signed URL, confirm it's a valid WAV file (`ffprobe` or `aplay`).
- Waterfall chunks parse correctly.
- Event chunks contain expected JSONL entries.

### Phase 2: Monitor panel (frontend can start/stop monitoring)

| # | Task | Scope |
|---|------|-------|
| 8 | Monitor tab in info panel — start/stop button, status indicator, session list with config snapshots | Frontend |
| 9 | Remove `auto_fallback` toggle from fallback section; keep probe results and manual source-switch UI | Frontend |
| 10 | Controls lockout — disable freq/mode/filter controls while monitoring is active | Frontend |
| 11 | WebSocket events for monitor state changes (`monitor_started`, `monitor_stopped`) | Backend + Frontend |

**Milestone:** User can start/stop monitoring from the UI. Locked controls are greyed out. Session list shows past sessions with configs.

### Phase 3: DVR timeline + rewind

| # | Task | Scope |
|---|------|-------|
| 12 | Multi-session DVR timeline bar — render segments, gaps, scrub, snap-to-live | Frontend |
| 13 | Session-aware chunk loader — fetch/cache audio + WF chunks via pre-signed URLs, cross-session prefetch | Frontend |
| 14 | Playback engine — AudioWorklet playback from chunked WAV, gap skipping, cross-session transitions | Frontend |
| 15 | Waterfall rewind rendering — switch between live and historical data sources, reconfigure on session boundary | Frontend |
| 16 | Spectrum rewind — render recorded spectrum in rewind mode | Frontend |
| 17 | Config display — update displayed frequency/mode/bandpass/filters when crossing session boundaries | Frontend |
| 18 | Event viewer — minute-aligned log/interpreter/source-switch display, session-aware | Frontend |

**Milestone:** User can scrub backwards through monitoring history, hear recorded audio, see recorded waterfall, and browse events. Cross-session boundaries update the UI config.

### Phase 4: Polish

| # | Task | Scope |
|---|------|-------|
| 19 | Retention policy — S3 lifecycle rules for 30-day expiration, backend sweep for orphaned DB records | Backend |
| 20 | Keyboard shortcuts for DVR (arrows ±30s, L for live) | Frontend |
| 21 | Event tick marks + source switch markers on timeline | Frontend |
| 22 | Gap rendering — dimmed/hatched regions for between-session and within-session gaps | Frontend |
| 23 | Loading states, error handling (pre-signed URL refresh on 403, session expiry while viewing) | Full stack |

---

## Known Hard Parts

1. **AudioWorklet dual-mode.** The existing `SdrAudioProcessor` handles live PCM from WebSocket. Rewind mode needs it to play from chunked WAV files fetched over HTTP. Same challenge as RINGBUFFER.md, but with chunked sources and chunk-boundary crossfading.

2. **Waterfall source switching.** The waterfall currently receives frames via `pushFrame()` from the WebSocket. In rewind mode, it needs to render from a buffer of historical frames. The crossfade from live to historical (and back) must not produce visual artifacts.

3. **Chunk boundary alignment.** When playback crosses from chunk N to chunk N+1, both audio and waterfall must transition seamlessly. Audio: the playback engine pre-fetches the next chunk and queues it. WF: frames are pre-loaded and appended to the render buffer.

4. **Cross-session boundaries.** When playback crosses from Session A into Session B, the frontend must: (a) detect the boundary, (b) read Session B's config from the timeline data (already loaded), (c) update all displayed settings in the UI (frequency, mode, bandpass, filters), (d) if zoom/frequency changed, reconfigure the waterfall renderer for the new bin layout, (e) continue audio playback into Session B's first chunk. Steps (b)–(d) should be pre-computed during prefetch (when the loader detects the current chunk is the last in the session, it prefetches the next session's first chunk).

5. **Gap handling.** Gaps occur between sessions (user was tweaking) and within sessions (recording failures). The timeline must render gaps visually and the playback engine must skip them cleanly. Within-session gaps are detected by missing chunk indices. Between-session gaps are computed from `stopped_at` / `started_at` timestamps. During playback, the engine inserts a brief silence (100ms) at gap boundaries and auto-advances to the next available data.

6. **Multi-session timeline rendering.** The timeline bar must render multiple solid segments (sessions) and gaps at correct proportional widths. For long monitoring histories (30 days, potentially dozens of sessions), the timeline needs to be zoomable or at least show a reasonable level of detail. The handle must snap to valid positions (within sessions, not in gaps).

7. **Near-live rewind latency.** Completed chunks are only uploaded to Tigris every 5 minutes. If a user rewinds to 2 minutes ago, that data is still in the local buffer, not yet in S3. The DVR timeline's right edge represents the latest completed chunk, not the literal present moment. The most recent ~5 minutes are "live only."

---

## Edge Cases

### Decided

1. **No manual session deletion.** Sessions are never manually deleted. They're either active (recording) or stopped (waiting to expire). The 30-day lifecycle rule handles cleanup. This avoids a class of problems (deleting active sessions, orphan S3 cleanup, UI confirmation flows).

2. **Recorder failures don't cascade.** The recorder uses buffered channels and never blocks the main audio/WF pipeline. If it falls behind, it drops its own frames. If S3 uploads fail, it retries once and moves on — the lost chunk is a gap. Live listeners are never impacted by recorder problems.

3. **Stream deletion stops the recorder.** When a stream is deleted, the recorder is stopped immediately. The DB cascade removes session records. S3 objects are left to expire via lifecycle — no proactive S3 cleanup on stream delete.

4. **DVR bar requires active monitoring.** The timeline bar only appears when `monitoring === true`. When monitoring is stopped, the bar disappears. Historical sessions are accessible via the session list in the monitor panel, but the full DVR rewind experience is tied to active monitoring.

5. **S3 outage.** If Tigris is down, the recorder drops chunks and gaps appear. This is accepted — monitoring is best-effort recording, not a guaranteed-delivery system. The live stream is unaffected.

### Noted for implementation

6. **Pre-signed URL expiration.** Frontend must catch 403 on chunk fetch, re-request URLs from the backend, and retry. URLs expire after 1 hour.

7. **Session expiry while viewing.** If the retention sweep expires a session while a user is rewound into it, chunk fetches will 404. Show a "session expired" message and snap to the nearest available session.

8. **Rolling restarts.** Deployments create a within-session gap (seconds to minutes). Crash recovery resumes recording with a new chunk index; the time discontinuity between the last pre-crash chunk and the first post-recovery chunk is a detectable gap.

9. **Within-session gap detection.** Gaps within a session are detected by time discontinuity between consecutive chunks (the end timestamp of chunk N vs. the start timestamp of chunk N+1), not by missing chunk indices — indices are always sequential.

10. **Short final chunks.** When monitoring stops mid-chunk, the partial chunk (e.g., 2 minutes instead of 5) is valid. WAV header must have correct `data` size. WF chunk must not have a partial frame at the end.

11. **Concurrent start race.** Two clients hitting `POST /api/streams/{id}/monitor` simultaneously. Low risk — `streammgr` processes requests serially per stream. A partial unique index on `monitor_sessions(stream_id) WHERE state = 'active'` provides a DB-level safety net.

---

## Decisions

1. **Zoom level:** Lock to whatever zoom level the user has when they press "start monitoring." The user has presumably set it to something meaningful for the frequency they're watching.

2. **Concurrent monitoring limit:** Up to 5 streams per tenant can monitor simultaneously (matching the existing hard cap of 5 streams per tenant). Storage and request costs scale linearly — 5 streams at 30-day retention is ~$9/month.

3. **Waterfall resolution tradeoff:** At high zoom levels, waterfall frames contain fewer meaningful bins but higher frequency resolution. At low zoom levels, more spectrum is captured at lower resolution. The locked zoom level determines this tradeoff. When a user enables monitoring, a confirmation dialog explains what gets locked and notes that the current zoom level determines waterfall resolution for the session.

4. **Retention:** Fixed at 30 days. Enforced via S3 lifecycle rules on the Tigris bucket for automatic object expiration, plus a backend sweep that deletes the corresponding `monitor_sessions` DB records.

5. **Egress:** Free. Tigris charges zero egress fees — no transfer costs when the frontend fetches chunks via pre-signed URLs, regardless of volume.

6. **Multiplayer in monitoring mode:** Settings are locked so there's nothing to sync between clients. Each client independently controls their DVR position (live vs rewound). Presence indicators (who's connected) still work. No multiplayer state updates are needed beyond presence.

7. **One stream → many sessions.** Each time monitoring starts, a new session is created with immutable config. Stopping, tweaking, and restarting creates a new session — not a new "segment" within the same session. This keeps each session simple (fixed config, linear chunk indices, single DB row) and lets the frontend handle stitching. The DVR timeline is the stitching layer — it fetches all sessions via the timeline endpoint and renders them as segments of a unified history. The alternative (one session per stream with config-change events embedded in the data) was rejected because it complicates the chunk format, makes seeking harder (must replay config history), and conflates "a continuous recording" with "the entire monitoring history."
