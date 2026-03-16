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

### Cost (Tigris object storage at $0.02/GB/month)

Storage is elastic — you pay only for what's stored, no pre-provisioning.

| Scenario | Data stored | Cost/month |
|----------|-------------|------------|
| 1 stream, 15 days | ~41 GB | **$0.83** |
| 1 stream, 30 days | ~83 GB | **$1.66** |
| 2 streams, 30 days | ~166 GB | **$3.31** |
| 3 streams, 30 days | ~249 GB | **$4.97** |
| 5 streams, 30 days | ~414 GB | **$8.28** |

We enforce a configurable retention policy (e.g., 30 days) and auto-delete expired sessions.

---

## Storage: Tigris (S3-Compatible Object Storage)

Tigris is Fly.io's built-in S3-compatible object storage. It's accessed over the local Fly network with no cross-provider egress, provisioned from the Fly dashboard, and billed at **$0.02/GB/month** for storage with the first 5 GB free. Compared to Fly Volumes ($0.15/GB/month for fixed-size NVMe), Tigris is ~7.5x cheaper and elastic — you pay only for what you store.

### Setup

Create a Tigris bucket via the Fly CLI:

```bash
fly storage create --name monitor-data
```

This provisions a bucket and sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, and `BUCKET_NAME` as secrets on the app. The Go backend uses the standard AWS SDK for S3 (`aws-sdk-go-v2`) to read/write objects.

### Write path

The recorder writes chunks to a local temp directory first (ephemeral filesystem), then uploads each completed chunk to Tigris as an S3 object. The local file is deleted after successful upload. This means the ephemeral filesystem only ever holds one in-progress audio chunk (~7.2 MB) and one in-progress WF chunk (~2.4 MB) per monitored stream — well within the root filesystem's capacity.

### Read path

The backend generates **pre-signed S3 URLs** for chunk reads. The frontend fetches chunks directly from Tigris using these URLs, bypassing the backend entirely for data transfer. Pre-signed URLs expire after a configurable TTL (e.g., 1 hour). This keeps chunk serving off the backend's CPU and bandwidth.

---

## Monitoring Sessions

A monitoring session is a first-class object:

```go
type MonitorSession struct {
    ID            string        `json:"id"`
    StreamID      string        `json:"stream_id"`
    State         string        `json:"state"` // active, stopped
    StartedAt     time.Time     `json:"started_at"`
    StoppedAt     *time.Time    `json:"stopped_at,omitempty"`
    FrequencyKHz  float64       `json:"frequency_khz"`
    Mode          string        `json:"mode"`
    ZoomLevel     int           `json:"zoom_level"`
    BandwidthLow  int           `json:"bandwidth_low_hz"`
    BandwidthHigh int           `json:"bandwidth_high_hz"`
    SizeBytes     int64         `json:"size_bytes"`
    DurationSec   float64       `json:"duration_seconds"`
    S3Prefix      string        `json:"-"` // e.g. "sessions/{id}/"
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
    size_bytes     BIGINT NOT NULL DEFAULT 0,
    s3_prefix      TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_monitor_sessions_stream ON monitor_sessions(stream_id);
```

### S3 key layout

All objects for a session live under a common prefix in the Tigris bucket:

```
sessions/{session_id}/
    manifest.json           # session metadata (updated every chunk rotation)
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
{"t": 1710500010789, "type": "state_change", "field": "mode", "value": "usb"}
```

The `t` field is Unix milliseconds. The frontend groups these by minute for display.

### `manifest.json`

Updated every chunk rotation (every 5 minutes) and on session stop:

```json
{
  "version": 1,
  "session_id": "abc123",
  "stream_id": "stream-uuid",
  "started_at": "2026-03-15T10:00:00.000Z",
  "stopped_at": null,
  "frequency_khz": 7074.0,
  "mode": "usb",
  "zoom_level": 10,
  "bandwidth_low_hz": 300,
  "bandwidth_high_hz": 2700,
  "sample_rate": 12000,
  "wf_fps": 8,
  "audio_chunks": 12,
  "wf_chunks": 12,
  "chunk_duration_sec": 300,
  "total_duration_sec": 3600
}
```

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
  └── every 5 min: upload updated manifest.json
```

Key responsibilities:

| Component | Behavior |
|-----------|----------|
| `AudioChunkWriter` | Accumulates PCM16 frames to a local temp file. Every 5 minutes, finalizes the WAV header, uploads to `sessions/{id}/audio/chunk-NNNNNN.wav`, deletes the local file. |
| `WFChunkWriter` | Accumulates waterfall frames with timestamps to a local temp file. Uploads on rotation. |
| `EventChunkWriter` | Buffers interpreter output and log lines as JSONL. Uploads on rotation. |
| `ManifestWriter` | Uploads an updated `manifest.json` on every chunk rotation with current chunk counts and duration. |
| `SizeTracker` | Tracks cumulative bytes uploaded and updates `monitor_sessions.size_bytes` in the DB. |

Local temp files live in an OS temp directory (e.g., `/tmp/monitor-{session_id}/`). At most 3 files are open at a time per monitored stream (one audio, one WF, one events) — totaling ~10 MB. The ephemeral root filesystem handles this easily.

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
2. The recorder uploads the final `manifest.json`.
3. `streammgr` unsubscribes the recorder.
4. `streammgr` calls `fallback.Manager.Disable(streamID)` — stops periodic probing. Existing fallback suggestions are preserved.
5. `streammgr` calls `SetAutoFallback(false)` on the pump — disables the quality monitor.
6. The session state is set to `stopped`, `stopped_at` is recorded.
7. `view_locked` is optionally released (user's choice). The stream returns to normal idle-disconnect behavior.

### Crash recovery

On startup, the backend checks for any sessions in `active` state in the DB:

- If the stream is still running, resume recording. The recorder reads the current `manifest.json` from S3 to determine the last completed chunk index, and continues from there. The fallback system is also re-enabled (`fallback.Manager.Enable`), restoring keep-alive and periodic probing. The in-progress local temp files from before the crash are lost (at most 5 minutes of data), which is acceptable.
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

### List sessions for a stream

```
GET /api/streams/{id}/monitor/sessions
```

Returns all sessions (active and stopped) for the stream, newest first.

### Get session details

```
GET /api/monitor/sessions/{sessionId}
```

Returns the session object with current manifest data.

### Get session manifest

```
GET /api/monitor/sessions/{sessionId}/manifest
```

Returns the `manifest.json` contents.

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

### Delete session

```
DELETE /api/monitor/sessions/{sessionId}
```

Deletes all S3 objects under the session prefix and removes the database record.

### WebSocket events

When monitoring starts/stops, broadcast to subscribers:

```json
{"type": "monitor_started", "session": { ... }}
{"type": "monitor_stopped", "session": { ... }}
```

The stream update event also includes `monitoring: true/false` and `monitor_session_id`.

Source failovers during monitoring are recorded as events in the session and broadcast as usual via `fallback_switch`. The recording continues uninterrupted — the recorder doesn't care which KiwiSDR source is providing the audio and waterfall frames.

---

## UI: Seamless Rewind (DVR Model)

The main UI gains a **timeline scrubber** — like YouTube's seekbar when watching a livestream. When monitoring is active, the playback bar extends backwards in time. Tapping/dragging backwards transitions the entire main view into recorded data. A "LIVE" pill jumps you back to the present.

### Layout

```
LIVE VIEW (normal):
┌──────────────────────────────────────────────────────────────────────┐
│  Stream Header   [7074.0 kHz] [USB]  [Monitor ●]    [🔴 LIVE]     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Live Spectrum                                                       │
│  ─────────────────────────────────────────                           │
│  Live Waterfall (scrolling down)                                     │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                             │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                             │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                             │
│                                                                      │
│  ◄━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●  │
│  -2h                                                          LIVE   │
└──────────────────────────────────────────────────────────────────────┘

REWOUND (user scrubbed back to -47 minutes):
┌──────────────────────────────────────────────────────────────────────┐
│  Stream Header   [7074.0 kHz] [USB]  [Monitor ●]  [→ Jump to LIVE] │
│  ⚠ Viewing recorded data from 1h 13m ago                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Recorded Spectrum (from that moment)                                │
│  ─────────────────────────────────────────                           │
│  Recorded Waterfall (static/scrolling through history)               │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                             │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                             │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                             │
│                                                                      │
│  ◄━━━━━━━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▸  │
│  -2h               -47min                                    LIVE    │
│                                                                      │
│  ▶ Playing recorded audio   00:47:23 / 02:14:00                     │
└──────────────────────────────────────────────────────────────────────┘
```

### How it works

When monitoring is active, a **timeline bar** appears at the bottom of the main waterfall area. It stretches from the session start time to "LIVE" (the current moment). The user can:

1. **Scrub backwards** by dragging the timeline handle left.
2. The **main waterfall** crossfades from live data to recorded waterfall data from that point in time. Since monitoring locks the zoom level and frequency, the recorded waterfall data has the exact same dimensions as the live view — the transition is seamless.
3. The **spectrum display** switches to showing the recorded spectrum for the current playback position.
4. **Audio** switches from live to recorded. The live WebSocket audio is silenced (but the connection stays open — the ring buffer keeps accumulating).
5. **Controls are disabled** — frequency, mode, bandpass, filter knobs are greyed out with a subtle label: "Viewing recorded data." The user can't change these while rewound because the recording was made at fixed settings. The controls show what the settings WERE at the time of recording.
6. **Interpreter data** in the interpreter panel switches to showing recorded interpreter output for the current playback position.
7. **Logs** in the logs panel switch to recorded logs.
8. **"Jump to LIVE"** button — clicking it snaps the timeline to the present, crossfades back to live waterfall, unmutes live audio, and re-enables all controls. Identical to clicking "Live" on a YouTube livestream DVR.

### The settings-out-of-sync problem

The user raised this concern — and it's real but manageable because monitoring locks everything:

| Setting | During monitoring | While rewound |
|---------|-------------------|---------------|
| Frequency | Locked (that's the point of monitoring) | Shows the locked frequency, greyed out |
| Mode | Could change during session | Show what it WAS; grey out the control |
| Bandpass | Could change | Show what it WAS; grey out the control |
| Filters | Could change | Show what they WERE; grey out the controls |
| Interpreter on/off | Could change | Show the recorded output regardless |

Since we record state changes in `events.jsonl`, we can reconstruct exactly what the settings were at any point in time. The controls reflect the historical settings read-only.

However, there's a subtlety: **should we also lock mode/bandpass/filters when monitoring starts?** There are two options:

**Option 1: Lock everything.** When monitoring starts, frequency, zoom, mode, bandpass, and filters are all frozen. The stream becomes a fixed observation point. This simplifies the rewind experience enormously — the settings are constant throughout the session, no need to track changes. The downside is reduced flexibility during monitoring.

**Option 2: Allow changes, track history.** The user can still change mode, bandpass, and filters while monitoring. Every change is recorded as an event in `events.jsonl`. When rewinding, controls snap to the historical values. This is more flexible but adds complexity.

**Recommendation: Option 1 (lock everything) for v1.** Monitoring is explicitly a "set it and forget it" mode. Locking everything makes the recording uniform and the rewind experience trivial. If users want to change settings, they stop monitoring, change, and start a new session. We can relax this later if needed.

### Feasibility

Is the seamless DVR model technically feasible? **Yes, with monitoring's constraints.** Here's why it's tractable:

1. **Zoom and frequency are locked.** This is the critical enabler. The recorded waterfall data has the exact same bin layout as the live view. No coordinate translation needed — you can literally swap the data source and the waterfall renders identically.

2. **Chunked storage aligns with lazy loading.** 5-minute chunks are small enough to fetch quickly (~7 MB audio + ~2.4 MB WF). The frontend keeps 2-3 chunks in memory around the current playback position and fetches ahead/behind as the user scrubs.

3. **Audio playback is solved.** RINGBUFFER.md already designed the AudioWorklet playback engine for captures. The same engine works here, just fed from chunked WAV files instead of a single WAV.

4. **Settings are constant (with Option 1).** No need for a complex state history system. The manifest tells you what the settings were for the entire session.

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
│  (full       │  │  ── Minute 47 ──────────────────────       │     │
│   width)     │  │  00:47:02 [info] Signal detected            │     │
│              │  │  00:47:05 [voice] "CQ CQ CQ DE..."         │     │
│              │  │  00:47:12 [info] SNR: 14 dB                 │     │
│              │  │                                             │     │
│  ◄━━━━━━●━━▸ │  │  ── Past Sessions ─────────────────        │     │
│  timeline    │  │  Mar 14, 10:00–14:23  (4h 23m)  [Load]     │     │
│              │  │  Mar 13, 08:00–20:15  (12h 15m) [Load]     │     │
│              │  └─────────────────────────────────────────────┘     │
└──────────────┴───────────────────────────────────────────────────────┘
```

---

## Frontend: DVR Timeline Component

### `frontend/src/components/monitor/dvr-timeline.tsx`

A horizontal bar rendered at the bottom of the waterfall area when monitoring is active. Inspired by YouTube/Twitch live DVR controls.

```
 ◄━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●
 10:00                                                        LIVE
        ▲ drag handle                                    ▲ live pill
```

- **Red dot** at the right edge = LIVE position. When the handle is here, the stream plays live.
- **Dragging left** enters rewind mode.
- **Time labels** appear at intervals along the bar.
- **Tick marks** can indicate events (interpreter detections, state changes) so the user can see "something happened here" and scrub to it.
- **Keyboard shortcuts**: left/right arrow keys move ±30 seconds, `L` jumps to live.

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
- All controls are interactive.
- Timeline handle sits at right edge.

In `REWIND` mode:
- Recorded audio plays (or is paused) through the playback engine.
- Recorded waterfall renders from chunk files.
- Controls are read-only, showing historical values.
- A banner says "Viewing recorded data from X ago."
- The "LIVE" pill glows/pulses to invite the user back.
- Play/pause button for recorded audio.

### Chunk loading strategy

The frontend maintains a **sliding window** of loaded chunks:

```
                    loaded chunks
              ┌──────────┬──────────┬──────────┐
              │ chunk N-1│ chunk N  │ chunk N+1│
              └──────────┴──────────┴──────────┘
                         ▲
                   current position
```

- Always keep the current chunk and ±1 neighbor loaded.
- When the user scrubs to a new position, determine the chunk index (`floor(positionSec / 300)`), fetch it if not loaded, and start playing from the offset within the chunk.
- Prefetch the next chunk when playback reaches 80% of the current chunk.
- Evict chunks more than 2 positions away from current to bound memory usage.

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

1. **Status bar.** Shows "Monitoring" with a pulsing indicator when active, session duration, and storage usage. Start/stop button.

2. **Event viewer.** Shows events (logs + interpreter output) for the minute the user is currently viewing. In LIVE mode, shows the most recent minute. In REWIND mode, shows the minute at the current playback position. Each event has a timestamp and type icon. Click an event to scrub the timeline to that exact moment.

3. **Session browser.** List of past (stopped) sessions with date range, duration, and size. Click "Load" to load a session into the DVR timeline (replaces the current session in the timeline). Click delete to remove.

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

| Phase | Task | Scope | Depends On |
|-------|------|-------|------------|
| **1. Storage foundation** | | | |
| 1a | Create Tigris bucket (`fly storage create`), add `aws-sdk-go-v2` dependency, write S3 client wrapper | Infra + Backend | Nothing |
| 1b | Create `monitor_sessions` table migration | Backend | Nothing |
| 1c | Migration: add `monitoring`, `monitor_session_id` to `streams`; drop `auto_fallback` | Backend | Nothing |
| 1d | `internal/monitor/recorder.go` — chunked WAV writer, WF writer, event writer with S3 upload on rotation | Backend | 1a |
| **2. Recording pipeline** | | | |
| 2a | `internal/db/monitor.go` — CRUD for monitor sessions | Backend | 1b |
| 2b | Wire recorder into `streammgr` — start/stop recording, subscribe to audio/WF/interpreter/logs | Backend | 1d, 2a |
| 2c | Lock view + zoom + mode + bandpass + filters when monitoring starts | Backend | 2b |
| 2d | Enable fallback system (keep-alive + probing + auto-failover) when monitoring starts; disable on stop | Backend | 2b |
| 2e | Crash recovery — check DB for active sessions on startup, resume or finalize | Backend | 2b |
| **3. API** | | | |
| 3a | Monitor REST endpoints (start, stop, get, list sessions) | Backend | 2b |
| 3b | Pre-signed URL endpoint for chunk access | Backend | 1a, 2b |
| 3c | WebSocket events for monitor state changes | Backend | 3a |
| **4. Frontend — Monitor panel** | | | |
| 4a | Monitor tab in info panel — start/stop, status, session browser | Frontend | 3a |
| 4b | Remove `auto_fallback` toggle from fallback section; integrate probe results into monitor panel | Frontend | 4a |
| 4c | Event viewer — minute-aligned log/interpreter display | Frontend | 3b |
| **5. Frontend — DVR timeline** | | | |
| 5a | DVR timeline bar component — render, scrub, snap-to-live | Frontend | 3b |
| 5b | Chunk loader — fetch/cache audio and WF chunks via pre-signed URLs | Frontend | 3b |
| 5c | Playback engine — AudioWorklet-driven playback from chunked WAV (extend from RINGBUFFER.md design) | Frontend | 5b |
| 5d | Waterfall rewind rendering — switch waterfall between live and historical data sources | Frontend | 5b |
| 5e | Controls lockout — disable freq/mode/filter controls in rewind mode, show historical values | Frontend | 5a |
| 5f | Spectrum rewind — render recorded spectrum in rewind mode | Frontend | 5d |
| **6. Polish** | | | |
| 6a | Retention policy — delete sessions older than configured TTL, S3 lifecycle rules | Backend | 2b |
| 6b | Keyboard shortcuts for DVR (arrows, L for live) | Frontend | 5a |
| 6c | Event tick marks on timeline (visual indicators of activity) | Frontend | 5a, 4b |
| 6d | Loading states, error handling, edge cases (session ends while rewound, etc.) | Full stack | 5* |

### Parallelism

- Phase 1 (a–d) can all be done in parallel (1d depends on 1a for the S3 client).
- Phase 2 depends on Phase 1 but 2a–2d are mostly sequential.
- Phase 3 depends on Phase 2.
- Phases 4 and 5 can be done in parallel with each other, both depend on Phase 3.
- Phase 6 depends on Phases 4 and 5.

### Recommended sequencing

Build phases 1–3 first. Verify by starting monitoring on a stream, letting it run for 10+ minutes, then using the AWS CLI or curl with pre-signed URLs to fetch chunks and confirm valid WAV files and waterfall data. Then build Phase 4 (monitor panel with start/stop) as the first frontend milestone. Then Phase 5 (DVR timeline) as the main frontend effort.

---

## Known Hard Parts

1. **AudioWorklet dual-mode.** The existing `SdrAudioProcessor` handles live PCM from WebSocket. Rewind mode needs it to play from chunked WAV files fetched over HTTP. Same challenge as RINGBUFFER.md, but with chunked sources and chunk-boundary crossfading.

2. **Waterfall source switching.** The waterfall currently receives frames via `pushFrame()` from the WebSocket. In rewind mode, it needs to render from a buffer of historical frames. The crossfade from live to historical (and back) must not produce visual artifacts.

3. **Chunk boundary alignment.** When playback crosses from chunk N to chunk N+1, both audio and waterfall must transition seamlessly. Audio: the playback engine pre-fetches the next chunk and queues it. WF: frames are pre-loaded and appended to the render buffer.

4. **Timeline accuracy.** The timeline scrubber must accurately map pixel position to time position across potentially hundreds of chunks. With fixed 5-minute chunks, this is just `chunkIndex * 300 + offsetWithinChunk`.

5. **Near-live rewind latency.** Completed chunks are only uploaded to Tigris every 5 minutes. If a user rewinds to 2 minutes ago, that data is still in the local buffer, not yet in S3. Options: (a) only allow rewind to completed chunks (the most recent 5 minutes are "live only"), (b) serve the in-progress chunk directly from the backend via a fallback endpoint. Option (a) is simpler and probably fine — the DVR timeline's right edge represents the latest completed chunk, not the literal present moment.

---

## Open Questions

1. **Zoom level selection.** What zoom level should monitoring lock to? Options: (a) whatever the user is currently at when they press "start monitoring," (b) a fixed default that provides good frequency resolution around the stream's frequency, (c) user-selectable from a preset list. Recommendation: (a) — use the current zoom level, since the user has presumably set it to something meaningful.

2. **Multiple streams monitoring simultaneously.** Nothing prevents it architecturally, and Tigris handles the storage elastically. At ~2.76 GB/day per stream the cost is negligible. No need to enforce a hard limit, but we should surface per-session and total storage usage in the monitor panel so users can manage retention themselves.

4. **Waterfall resolution.** At high zoom levels, waterfall frames contain fewer meaningful bins. At low zoom levels, more spectrum is captured but at lower frequency resolution. The locked zoom level determines the tradeoff. Document this for users.

5. **Session retention policy.** Configurable TTL (e.g., 30 days). Can be enforced via S3 lifecycle rules on the Tigris bucket for automatic expiration, plus a backend sweep that cleans up the corresponding DB records.

6. **Tigris egress.** Tigris charges for egress outside the Fly network. Pre-signed URLs served to the user's browser will incur egress costs. Tigris pricing: first 10 GB/month free, then $0.05/GB. A user scrubbing through 1 hour of monitoring data fetches ~115 MB. Light usage should stay within the free tier; heavy browsing of long sessions could add a few cents.
