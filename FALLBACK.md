# Auto-Fallback

## What It Does

`auto_fallback` is a per-stream toggle. When enabled, three things happen:

1. **Keep-alive.** The stream never idle-disconnects. Without `auto_fallback`, a stream with zero subscribers disconnects from its KiwiSDR source after 10 minutes. With it on, the connection is held indefinitely.

2. **Periodic probing.** A background session discovers nearby KiwiSDR sources, connects to each one at the stream's frequency, collects ~3 seconds of audio and waterfall data, scores them against a reference snapshot from the live stream, and maintains a ranked list of the top 3 fallback candidates. This cycle repeats every 5 minutes.

3. **Automatic failover.** If the stream's quality degrades (frame gaps, low frame rate) or the KiwiSDR connection fails to reconnect after 3 consecutive attempts, the system automatically switches to the top-ranked fallback source.

Manual probing is available independently of `auto_fallback` -- any stream can trigger a one-shot probe cycle via the API or WebSocket, see the results, and manually switch sources.

---

## Stream Model

```go
type Stream struct {
    // ...
    AutoFallback bool `json:"auto_fallback"`
}
```

Single boolean. No `auto_fallback_kind` -- all auto-fallback streams get the full behavior (probe + auto-switch).

---

## Connection Lifecycle

### Without auto_fallback

```
Pump exits (KiwiSDR disconnects)
  |
  +-- Was idle disconnect (10m, no subscribers)? --> Stop. No reconnect.
  |
  +-- Otherwise --> ensureReconnect (retry same source, backoff 1s->15s, forever)
                       |
                       +-- No subscribers for 10m during reconnect? --> Abandon.
```

### With auto_fallback

```
Pump exits (KiwiSDR disconnects)
  |
  +-- Idle disconnect? --> Never happens (autoFallback skips idle check)
  |
  +-- ensureReconnect (retry same source, backoff 1s->15s)
         |
         +-- 3 consecutive failures --> HandleDegraded
         |      |
         |      +-- Fallback suggestions available? --> Switch to top fallback via Reconfigure
         |      |      |
         |      |      +-- Success? --> New pump, reconnect loop exits
         |      |      +-- Failure? --> Reset attempt counter, continue loop (now targeting new source from DB)
         |      |
         |      +-- No suggestions? --> Reset counter, keep retrying
         |
         +-- Success --> New pump starts, quality monitor resumes
```

### Quality Monitor (parallel path)

While the pump is running, the `QualityMonitor` tracks transport health:

- Frame gaps > 2 seconds
- Frame rate < 15 fps over a 10-second window
- 3+ consecutive errors (currently `RecordError` is defined but not called)

If degradation is detected and sustained for 5 seconds, `onDegraded` fires, which calls `HandleDegraded` and switches to the top fallback. This path is independent of the reconnect loop -- it handles live degradation while connected, not full disconnects.

On pump exit, `RecordDisconnect` is **not** called. Connection lifecycle is handled entirely by `ensureReconnect`. When a new pump starts after reconnect, `RecordFrame` resets the quality monitor to healthy.

---

## Candidate Discovery

Every 5 minutes (or on manual reprobe), the fallback session:

1. Loads the stream's current source.
2. Queries the database for sources within 2000 km (Haversine), filtering for: `available = true`, `users < max_listeners`, `ant_connected = true`, lat/lon present, excluding current source.
3. Returns top 5 candidates sorted by distance.

No PostgreSQL extensions needed -- Haversine is computed in Go.

---

## Probing

### Stage 1: Health Check

Runs the existing `HealthChecker` on the candidate list. This is a concurrent `/status` HTTP fetch that updates the DB with current availability, user count, and SNR. Candidates that are offline, full, or antenna-disconnected are eliminated.

### Stage 2: Deep Probe

For each surviving candidate (sequentially, limited by a global semaphore of 3):

1. Capture a **reference snapshot** from the live stream (~3 seconds of audio + waterfall).
2. Connect to the candidate KiwiSDR at the stream's frequency/mode/bandwidth.
3. Collect ~3 seconds of audio and waterfall data.
4. Score the candidate against the reference.
5. Disconnect.

### Scoring

Candidates are scored 0.0--1.0 using comparative metrics:

| Metric | Weight | What it measures |
|--------|--------|-----------------|
| Silence agreement | 0.30 | Both silent or both active? |
| Spectral similarity | 0.25 | Same spectral shape in passband (cosine similarity of WF bins)? |
| RMS similarity | 0.15 | Similar audio levels? |
| Noise floor similarity | 0.10 | Similar background noise? |
| Frame rate | 0.10 | Delivering frames at expected rate? (absolute) |
| Latency | 0.10 | Connection latency (absolute) |

Minimum score threshold: 0.1. Top 3 candidates are persisted to the `fallback_suggestions` table and broadcast to WebSocket clients.

The scoring model is comparative -- it measures how similar a candidate looks to the current stream. A silent frequency scores high against another silent candidate. A noisy frequency scores high against another candidate seeing the same noise. The system never penalizes silence itself.

---

## Fallback Manager

```go
type Manager struct {
    db, log, healthChecker, reconfigurer, broadcast, probeSem
    sessions map[string]*fallbackSession
}
```

### Key Methods

| Method | Behavior |
|--------|----------|
| `Enable(streamID)` | Starts a periodic probe session (immediate cycle + every 5 min). Called when `auto_fallback` is toggled on or at server startup for streams with `auto_fallback=true`. |
| `Disable(streamID)` | Cancels the periodic session. Suggestions are **preserved** in DB (not deleted). |
| `Reprobe(streamID)` | Clears existing suggestions, then starts a new session. If `auto_fallback` is on, the session is periodic. If off, it runs a single one-shot probe cycle. |
| `HandleDegraded(streamID, reason)` | Takes the top in-memory suggestion, calls `Reconfigure` to switch the stream to that source, broadcasts `fallback_switch`, clears suggestions. |
| `OnStreamUpdated(stream)` | Routes to Enable/Disable/Reprobe based on whether `auto_fallback` changed or the stream was reconfigured. |
| `GetSuggestions(streamID)` | Reads from DB (not in-memory). Used by REST endpoint. |

### Session Lifecycle

- `run(ctx)`: Runs one cycle immediately, then repeats every 5 minutes until cancelled.
- `runOnce(ctx)`: Runs one cycle and exits. Used for manual reprobe when `auto_fallback` is off.
- `runCycle(ctx)`: Discovery -> health check -> reference snapshot -> probe each candidate -> score -> persist -> broadcast.

---

## API

### Stream PATCH

```json
{ "auto_fallback": true }
```

Toggling `auto_fallback` calls `SetAutoFallback` (creates/destroys the quality monitor on the pump) and `OnStreamUpdated` on the fallback manager (starts/stops the probe session).

### GET /api/streams/{id}/fallbacks

Returns the current fallback suggestions.

```json
{
  "stream_id": "abc123",
  "auto_fallback": true,
  "suggestions": [
    {
      "source_id": "src_001",
      "source_name": "KiwiSDR @ AB1CDE",
      "source_host": "kiwi.example.com",
      "source_port": 8073,
      "rank": 1,
      "score": 0.82,
      "distance_km": 145.3,
      "bearing_deg": 47.2,
      "last_probed": "2026-03-14T10:30:00Z",
      "probe_metrics": { ... }
    }
  ]
}
```

### POST /api/streams/{id}/reprobe

Triggers a fresh probe cycle. Works regardless of `auto_fallback` state.

### GET /api/streams/{id}/fallbacks/ref-audio

Downloads the reference audio snapshot as a WAV file.

### GET /api/streams/{id}/fallbacks/{rank}/probe-audio

Downloads a candidate's probe audio as a WAV file.

---

## WebSocket Messages

### Server -> Client

| Type | When | Payload |
|------|------|---------|
| `fallback_updated` | Probe cycle completes | `{ suggestions: [...] }` |
| `fallback_probing` | Each candidate finishes probing | `{ candidates_total, candidates_probed }` |
| `fallback_switch` | Auto-failover occurs | `{ from_source_id, to_source_id, reason }` |

### Client -> Server

| Type | Effect |
|------|--------|
| `switch_fallback` | Manually switch to a fallback source (patches stream `source_id`, reconfigures) |
| `reprobe_fallbacks` | Trigger a fresh probe cycle |

---

## Database

### Columns on `streams`

```sql
auto_fallback BOOLEAN NOT NULL DEFAULT false
```

### Table: `fallback_suggestions`

```sql
CREATE TABLE fallback_suggestions (
    stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    rank        INTEGER NOT NULL,
    score       DOUBLE PRECISION NOT NULL,
    distance_km DOUBLE PRECISION NOT NULL,
    probe_metrics JSONB NOT NULL DEFAULT '{}',
    last_probed TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (stream_id, rank)
);
```

Additional columns: `probe_audio BYTEA`, `probe_sample_rate INTEGER`.

Reference audio is stored on the `streams` table: `ref_audio BYTEA`, `ref_audio_sample_rate INTEGER`, `ref_audio_at TIMESTAMPTZ`.

---

## Package Layout

```
internal/fallback/
  manager.go      -- Manager, session lifecycle, Enable/Disable/Reprobe/HandleDegraded
  discovery.go    -- Haversine candidate discovery
  prober.go       -- Deep probe (connect, collect, analyze, disconnect)
  scorer.go       -- Comparative scoring (weights, normalization)
  quality.go      -- QualityMonitor (frame gaps, frame rate, state machine)
  types.go        -- FallbackSuggestion, ProbeMetrics, AudioSnapshot, etc.
  haversine.go    -- Haversine distance and bearing calculations
```
