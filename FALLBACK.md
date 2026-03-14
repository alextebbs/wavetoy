# Auto-Fallback Plan

## Overview

Add a per-stream `auto_fallback` toggle that, when enabled, continuously discovers and probes nearby KiwiSDR sources to maintain a ranked list of ready-to-use fallback candidates. When the current source degrades or disconnects, the stream automatically switches to the top-ranked fallback after a short exponential backoff. While auto-fallback is on, the stream stays alive indefinitely — it never stops due to lack of subscribers.

---

## Current State

```
User opens stream → EnsureRunning → connectClient(source) → startPump / startWFPump
                                                                  │
                                                         ┌────────┴────────┐
                                                         │ kiwi disconnects │
                                                         └────────┬────────┘
                                                                  │
                                                    hasSubscribers? ──── no → state="stopped", done
                                                         │
                                                        yes
                                                         │
                                                  ensureReconnect()
                                                  (backoff 1s→15s, same source)
```

Today, when a KiwiSDR connection drops:

1. If subscribers exist, `ensureReconnect` retries the **same source** with exponential backoff (1s → 2s → 4s → ... → 15s cap).
2. If no subscribers remain, the pump exits and the stream goes to `stopped`. No reconnection attempt.
3. There is no mechanism to switch to a different source automatically.
4. There is no probing of alternative sources beyond the `/status` health check (which only checks availability, not signal quality at a specific frequency).

The user can manually switch sources via the source picker, which triggers `Reconfigure` with a new `source_id`. This works but requires the user to be present and paying attention.

---

## Proposed Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              FallbackManager                                │
│                                                                             │
│  For each stream with auto_fallback=true:                                   │
│                                                                             │
│  ┌──────────────────────┐    ┌────────────────────┐    ┌────────────────┐   │
│  │  Candidate Discovery │───▶│    Deep Prober      │───▶│ Ranked List    │   │
│  │  (nearby sources,    │    │ (connect, tune,     │    │ (top 3, scored │   │
│  │   geo + availability)│    │  analyze audio+WF)  │    │  and ready)    │   │
│  └──────────────────────┘    └────────────────────┘    └───────┬────────┘   │
│                                                                │            │
│                                                                ▼            │
│  ┌──────────────────────┐                            ┌─────────────────┐   │
│  │  Quality Monitor     │ ◀─── stream audio/WF ────▶ │ Failover Logic  │   │
│  │  (frame rate, RMS,   │                            │ (degradation    │   │
│  │   silence, errors)   │                            │  detection →    │   │
│  └──────────────────────┘                            │  backoff →      │   │
│                                                      │  auto-switch)   │   │
│                                                      └─────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Stream Model Changes

Add two fields to the `Stream` model:

```go
type Stream struct {
    // ... existing fields ...
    AutoFallback     bool   `json:"auto_fallback"`
    AutoFallbackKind string `json:"auto_fallback_kind"` // "manual" (suggest only) or "auto" (switch automatically)
}
```

`AutoFallback` enables the fallback manager for this stream. `AutoFallbackKind` controls whether the system only suggests fallbacks (user clicks to switch) or automatically switches on degradation. Default is `"auto"`.

When `auto_fallback` is toggled on via a stream PATCH, the `FallbackManager` starts its discovery loop for that stream. When toggled off, the loop stops and all probe connections are torn down.

---

## Candidate Discovery

### Finding Nearby Sources

When auto-fallback activates for a stream, the system needs to find sources that are geographically close to the current source and likely to receive the same signal. The search uses these criteria:

1. **Geographic proximity.** Sources within a configurable radius (default 2000 km) of the current source, sorted by distance. Haversine distance calculation on the source's `latitude`/`longitude` fields.

2. **Availability.** Only sources where `available = true`, `users < max_listeners`, and `ant_connected = true`. This filters out offline, full, or antenna-disconnected sources.

3. **Frequency coverage.** The current stream's `frequency_khz` must fall within the candidate source's receivable range. KiwiSDR receivers cover 0–30 MHz, so this is effectively always true, but checking it prevents issues if non-KiwiSDR sources are added later.

4. **Exclusion.** The current source is excluded. Sources already being used by other streams in the same tenant are deprioritized (not excluded — a source can serve multiple streams if it has listener slots).

### Discovery Query

```sql
SELECT id, host, port, use_tls, latitude, longitude, name, max_listeners, users, snr_dbm
FROM sources
WHERE available = true
  AND users < max_listeners
  AND COALESCE(ant_connected, false) = true
  AND latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND id != $1  -- exclude current source
ORDER BY
  earth_distance(
    ll_to_earth(latitude, longitude),
    ll_to_earth($2, $3)  -- current source lat/lon
  )
LIMIT 10
```

This returns the 10 nearest available sources. The `earth_distance` + `ll_to_earth` functions are from PostgreSQL's `earthdistance` extension (depends on `cube`). If we don't want the extension dependency, we can compute Haversine in Go and sort application-side — the source count (~5,000) makes this feasible.

**Alternative without PostgreSQL extension:** Load all available sources with coordinates, compute Haversine distance in Go, sort, take top 10. At ~5,000 sources this is <1ms. This avoids adding a PostgreSQL extension and is the recommended approach.

### Discovery Interval

Discovery runs:
- Immediately when `auto_fallback` is toggled on.
- Every 5 minutes thereafter (candidates change as sources go online/offline or fill up, but not so fast that sub-minute refresh is needed).
- The deep prober runs on the same 5-minute cycle — it discovers candidates and probes them in one pass.

---

## Probing

The probe process has two stages: a fast `/status` check that filters out clearly unusable sources, followed by a deep probe that actually connects and analyzes real audio/waterfall data. The shallow check is cheap (~100ms, one HTTP GET) and avoids wasting a 5-second deep probe on sources that are offline, full, or broken.

### Stage 1: Status Check

Run the existing `HealthChecker` logic on the 10 candidates. This is the exact same code path as the global health check — `fetchStatus` handles HTTP/HTTPS probing, parses the key=value `/status` response, and returns a `SourceStatus` struct. The only difference is scope: instead of checking every source in the database, we check a targeted list of 10.

To support this, `HealthChecker` gets a new method:

```go
func (h *HealthChecker) RunForSources(ctx context.Context, sourceIDs []string) error
```

This runs the same concurrent `/status` fetch + `SetSourceStatus` DB update, just scoped to the given IDs. The prober calls it before starting deep probes.

After the status check completes, a candidate is **eliminated** if any of these are true (all derived from the `SourceStatus` fields that `fetchStatus` already parses):

| Condition | Why |
|-----------|-----|
| `available == false` (status != active or offline == yes) | Source is not operational |
| `users >= max_listeners` | No listener slots available |
| `ant_connected == false` | No antenna — no signal |
| `/status` fetch failed | Source is unreachable |

Because this uses the real `SetSourceStatus` path, the DB is updated as a side effect — user counts, SNR, availability all get refreshed for these 10 sources, keeping our data fresher than the global health check cycle alone.

Candidates that pass the status check advance to stage 2. Typically 5–8 of the 10 survive; the rest are eliminated cheaply.

### Stage 2: Deep Probe

For each candidate that passed the status check, the deep prober **actually connects** to the KiwiSDR with the stream's frequency settings and analyzes real audio and waterfall data.

#### Reference Snapshot

Before probing candidates, the prober takes a **reference snapshot** of the current stream's audio and waterfall data. This is a 3-second sample from the live pump — the same window length used for candidate probes. The reference captures what the current stream looks and sounds like *right now*, so candidates can be scored against it.

```go
type AudioSnapshot struct {
    RMSDB         float64   // average RMS across all frames
    PeakRMSDB     float64   // loudest frame
    FloorRMSDB    float64   // quietest frame
    SilenceRatio  float64   // fraction of frames below silence threshold
    FrameRate     float64   // frames/sec received
    WFBinsInBand  []float64 // waterfall bin magnitudes in the stream's passband
}
```

The reference is lightweight — it's computed from data the pump is already processing, so it doesn't open any new connections or add latency to the audio path.

#### Probe Process

For each candidate, sequentially:

1. **Connect.** Open SND and W/F WebSocket connections to the candidate, using the same frequency, mode, and bandwidth as the active stream. Use a shared timestamp so both connections occupy one listener slot.

2. **Collect.** Read audio frames and waterfall frames for a configurable analysis window (default 3 seconds, ~70 audio frames).

3. **Analyze.** Compute the same `AudioSnapshot` metrics for the candidate, then **compare against the reference**:

   | Metric | What It Measures | How |
   |--------|-----------------|-----|
   | **RMS similarity** | Audio level match | `1 - abs(candidate_rms - reference_rms) / range` — are they hearing similar signal levels? |
   | **Noise floor similarity** | Background noise match | Closeness of floor RMS between candidate and reference |
   | **Silence agreement** | Both quiet or both active? | `1 - abs(candidate_silence - reference_silence)` — if both are silent, score is high; if one is silent and the other isn't, score is low |
   | **WF spectral similarity** | Same signal in the passband? | Cosine similarity between the candidate's in-band WF bins and the reference's — measures whether they're seeing the same spectral shape |
   | **Frame rate** | Connection health | `candidate_frame_rate / expected_rate` — this one is absolute, not comparative. A source that can't deliver frames is broken regardless of what the reference looks like |
   | **Connection latency** | Network quality | Time from WebSocket open to first SND frame — also absolute |

4. **Score.** Combine into a single quality score (0.0–1.0):

   ```
   score = w_similarity * silence_agreement
         + w_spectral  * wf_spectral_similarity
         + w_rms       * rms_similarity
         + w_floor     * noise_floor_similarity
         + w_framerate * norm(frame_rate / expected_rate)
         + w_latency   * norm(1 / connection_latency)
   ```

   Default weights: `w_similarity=0.30, w_spectral=0.25, w_rms=0.15, w_floor=0.10, w_framerate=0.10, w_latency=0.10`. The comparative metrics (silence agreement + spectral similarity) dominate because the central question is "does this source see the same thing as my current source?" — not "does this source have signal?"

   **Why this works on quiet frequencies:** If the current stream is monitoring a silent repeater frequency, the reference snapshot has high silence ratio and a flat WF spectrum. A candidate that's *also* silent with a similar flat spectrum scores high — it's receiving the same thing. A candidate that happens to be picking up some local interference scores low because its spectrum doesn't match. The system never penalizes silence itself, only *disagreement* with the reference.

   **Why this works on active frequencies:** If the current stream is receiving a strong AM broadcast, the reference has high RMS, low silence ratio, and a characteristic spectral shape. A candidate needs to match all of that to score well. A candidate that's silent (maybe the AM station is below its horizon) scores low on silence agreement and spectral similarity.

5. **Disconnect.** Close the probe connections. The candidate's listener slot is freed.

### Probe Scheduling

- The status checks (stage 1) run concurrently for all 10 candidates — ~1 second total.
- The deep probes (stage 2) run sequentially, one candidate at a time, to avoid consuming too many listener slots simultaneously.
- Each deep probe takes ~3 seconds (analysis window) + ~2 seconds (connection setup/teardown) = ~5 seconds per candidate.
- With ~6 candidates passing stage 1, the deep probe phase takes ~30 seconds. Total cycle time (status + deep) is ~31 seconds. After completing a cycle, the prober sleeps until the next 5-minute tick.
- A receiver that's a good fallback now will almost certainly still be a good fallback 5 minutes from now. Source availability changes slowly — receivers go offline or fill up over minutes to hours, not seconds. Probing more often wastes KiwiSDR listener slots with no real benefit.
- If a deep probe fails to connect (source went down between stage 1 and stage 2), it's scored 0.0 and the prober moves to the next candidate immediately.

### Probe Connection Identity

Probe connections use a distinct `ident_user` so KiwiSDR operators can distinguish probes from real listeners:

```
SET ident_user=sdr-radio-probe
```

### Concurrency Limits

At most 1 probe connection active at a time per stream. If 5 streams all have auto-fallback on, that's at most 5 concurrent probe connections across the system. A global semaphore caps this at a configurable maximum (default 3) to be respectful of KiwiSDR network resources.

---

## Fallback Suggestion Model

### Data Model

```go
type FallbackSuggestion struct {
    StreamID    string    `json:"stream_id"`
    SourceID    string    `json:"source_id"`
    Rank        int       `json:"rank"`        // 1, 2, or 3
    Score       float64   `json:"score"`       // 0.0–1.0
    DistanceKm  float64   `json:"distance_km"`
    LastProbed  time.Time `json:"last_probed"`
    ProbeMetrics ProbeMetrics `json:"probe_metrics"`
}

type ProbeMetrics struct {
    AudioRMSDB          float64 `json:"audio_rms_db"`
    RMSSimilarity       float64 `json:"rms_similarity"`        // vs reference, 0.0–1.0
    SilenceAgreement    float64 `json:"silence_agreement"`     // vs reference, 0.0–1.0
    SpectralSimilarity  float64 `json:"spectral_similarity"`   // vs reference, 0.0–1.0
    NoiseFloorSimilarity float64 `json:"noise_floor_similarity"` // vs reference, 0.0–1.0
    FrameRate           float64 `json:"frame_rate"`
    LatencyMs           float64 `json:"latency_ms"`
}
```

Fallback suggestions are **persisted to the database**. They are written after each probe cycle and read on demand by the API and WebSocket layers.

Why persist rather than keep in-memory only:

- **Restart resilience.** A server restart wipes in-memory state. Re-probing from scratch takes ~50 seconds (10 candidates × 5 seconds each). During that window, if the current source fails there is nothing to fall back to. With persisted suggestions, the server restarts and immediately has stale-but-usable fallbacks while re-probing runs in the background.
- **Cold UI loads.** A page refresh or new tab needs suggestions from the `GET /api/streams/{id}/fallbacks` endpoint. Without persistence, that endpoint returns empty until the in-memory prober completes a full cycle. With persistence, it always returns the last known suggestions.
- **Observability.** `SELECT * FROM fallback_suggestions WHERE stream_id = X ORDER BY rank` is far more useful for debugging than inspecting in-memory state through logs.
- **Multi-instance readiness.** If the backend ever runs as multiple processes, DB-backed suggestions are shared automatically.

The write cost is negligible — 3 rows upserted per stream every 5 minutes, far below the audio/WF data volume already flowing through the system.

### Suggestion Lifecycle

1. Discovery finds 10 candidates.
2. Deep prober scores each candidate.
3. Top 3 by score (above a minimum threshold of 0.1) become the `FallbackSuggestion` list.
4. The suggestions are upserted to the `fallback_suggestions` table (DELETE + INSERT in a transaction for the stream's rows).
5. The list is broadcast to all WebSocket clients subscribed to the stream via a `fallback_updated` event.
6. On the next probe cycle, the list is recalculated, re-persisted, and re-broadcast if it changed.
7. When `auto_fallback` is toggled off or the stream is deleted, the stream's suggestion rows are deleted.

---

## Quality Monitor

The quality monitor runs inside the existing `startPump` goroutine. It tracks the health of the **current** stream connection and decides when to trigger a failover.

**Important distinction:** The quality monitor detects *source/connection failure*, not *signal absence*. A quiet frequency with no transmissions is perfectly healthy — the source is working fine, there's just nothing on the air. Failover should only trigger when the source itself is broken (can't deliver frames, connection drops, gets kicked off).

### Tracked Metrics

| Metric | How It's Measured | Degradation Signal |
|--------|------------------|--------------------|
| **Frame gap** | Time since last audio frame received | > 2 seconds with no frame |
| **Frame rate** | Sliding window (last 10 seconds) of frames/sec | < 15 fps (expected ~24) |
| **Connection drop** | Kiwi client `Done()` channel closes | Immediate signal |
| **Repeated errors** | Kiwi client returns errors on read | 3+ consecutive errors |

Audio silence is **not** a degradation signal. A stream can be 100% silent and perfectly healthy — it just means the frequency is quiet. The quality monitor only cares about the transport layer: is the KiwiSDR delivering frames at the expected rate? Silence vs. signal is the *probe scorer's* job (comparative), not the quality monitor's.

### Degradation State Machine

```
        ┌─────────┐
        │ HEALTHY  │ ◀─── metrics normal
        └────┬─────┘
             │ any degradation signal
             ▼
        ┌──────────┐
        │ DEGRADED │ ◀─── metrics below threshold
        └────┬─────┘
             │ sustained for holdoff period (5 seconds)
             ▼
        ┌──────────┐
        │ FAILING  │ ◀─── confirmed degradation
        └────┬─────┘
             │ fallback available?
             ├── yes → SWITCHING
             └── no  → stay FAILING, keep retrying current source
                       (existing ensureReconnect behavior)
             
        ┌───────────┐
        │ SWITCHING  │ ◀─── executing source switch
        └────┬──────┘
             │ switch complete
             ▼
        ┌─────────┐
        │ HEALTHY  │ ◀─── now on new source
        └─────────┘
```

The 5-second holdoff in the DEGRADED state prevents transient glitches from triggering a switch. A brief network hiccup or a single dropped frame should not cause a source change — only sustained degradation.

### Failover Execution

When the quality monitor transitions to SWITCHING:

1. **Select fallback.** Take the top-ranked `FallbackSuggestion`.

2. **Exponential backoff.** Wait before switching: 1 second for the first failover, doubling on each subsequent failover within a 5-minute window, capped at 16 seconds. This prevents rapid thrashing between sources if multiple sources are degraded. The backoff resets after 5 minutes of stable connection.

   ```
   Failover 1: wait 1s, switch
   Failover 2 (within 5min): wait 2s, switch
   Failover 3 (within 5min): wait 4s, switch
   Failover 4+: wait 8–16s, switch
   After 5 minutes stable: reset to 1s
   ```

3. **Execute switch.** Call `Manager.Reconfigure(stream)` with the fallback's `source_id`. This is the same code path as a manual source switch — it connects to the new source, starts new pumps, and closes the old connection.

4. **Update stream.** Persist the new `source_id` to the database. Broadcast `stream_updated` so all clients see the source change.

5. **Log.** Broadcast a `stream_log` message: `"auto-fallback: switched from {old_source} to {new_source} (reason: {degradation_type})"`.

6. **Re-probe.** After switching, the deep prober immediately starts a new discovery + probe cycle to rebuild the fallback list around the new source.

---

## Keeping Streams Alive

When `auto_fallback` is enabled on a stream, the existing "stop if no subscribers" behavior is overridden:

### Current Behavior (pump defer)

```go
// In startPump's defer:
if stillCurrent {
    if hasSubscribers {
        m.ensureReconnect(as)
    }
    // else: stream dies
}
```

### New Behavior

```go
if stillCurrent {
    if hasSubscribers || as.autoFallback {
        m.ensureReconnect(as)
    }
}
```

When `auto_fallback` is true, the stream reconnects even with zero subscribers. The `FallbackManager` acts as a logical subscriber — the stream stays alive as long as the fallback system is active.

Additionally, the `ensureReconnect` logic gains awareness of fallback suggestions. If the current source fails to reconnect after 3 attempts, and fallback suggestions are available, `ensureReconnect` switches to the top-ranked fallback instead of continuing to retry the same failing source.

---

## FallbackManager

### Structure

```go
package fallback

type Manager struct {
    db            *db.DB
    streamMgr     *streammgr.Manager
    probeSem      chan struct{} // global probe concurrency limiter

    mu            sync.RWMutex
    sessions      map[string]*fallbackSession // streamID → session
}

type fallbackSession struct {
    streamID      string
    currentSource *models.Source
    stream        *models.Stream

    candidates    []candidateSource
    suggestions   []*FallbackSuggestion // top 3
    quality       *qualityMonitor

    cancel        context.CancelFunc
    done          chan struct{}
}

type candidateSource struct {
    source     models.Source
    distanceKm float64
}
```

### Lifecycle

```go
func (m *Manager) Enable(ctx context.Context, streamID string)  // start session
func (m *Manager) Disable(ctx context.Context, streamID string)  // stop session, close probes, delete suggestion rows
func (m *Manager) GetSuggestions(ctx context.Context, streamID string) ([]*FallbackSuggestion, error) // read from DB
func (m *Manager) Reprobe(ctx context.Context, streamID string)   // clear suggestions, restart cycle
func (m *Manager) OnStreamUpdated(stream models.Stream)          // react to source/freq changes
```

- `Enable` is called when a stream's `auto_fallback` is set to `true` via PATCH. On startup, the server also calls `Enable` for every stream that has `auto_fallback=true` in the database, so sessions resume after restart.
- `Disable` is called when `auto_fallback` is set to `false`, or the stream is deleted. It stops the session, closes any active probe connections, and deletes the stream's rows from `fallback_suggestions`.
- `GetSuggestions` reads from the `fallback_suggestions` table, joined with `sources` for display fields. The in-memory session also caches the latest suggestions for fast access from the WebSocket broadcast path.
- `OnStreamUpdated` is called on any stream reconfiguration. If the source or frequency changed, the session restarts its discovery + probe cycle (the old candidates are no longer relevant) and clears the existing suggestion rows.

### Session Goroutine

Each `fallbackSession` runs two goroutines:

1. **Discovery + Probe loop:**
   ```
   every 5 minutes:
     1. Load current source from DB
     2. Query nearby available sources (Haversine, top 10)
     3. For each candidate (sequentially, respecting probeSem):
        a. Connect to candidate with stream's frequency settings
        b. Collect 3 seconds of audio + WF data
        c. Score the candidate
        d. Disconnect
     4. Rank candidates, take top 3 → suggestions
     5. Persist suggestions to fallback_suggestions table
     6. Broadcast fallback_updated to WebSocket clients
   ```

2. **Quality monitor** (integrated into the stream's pump — not a separate goroutine):
   - The `FallbackManager` registers a quality callback with the `activeStream` that receives frame-level metrics.
   - When degradation is detected and sustained, the callback signals the session to initiate a failover.

---

## WebSocket Changes

### New Message Types (Server → Client)

#### `fallback_updated`

Sent when the fallback suggestion list changes. Only sent to clients subscribed to a stream that has `auto_fallback` enabled.

```json
{
  "type": "fallback_updated",
  "stream_id": "abc123",
  "suggestions": [
    {
      "source_id": "src_001",
      "source_name": "KiwiSDR @ AB1CDE",
      "rank": 1,
      "score": 0.82,
      "distance_km": 145.3,
      "last_probed": "2026-03-14T10:30:00Z",
      "probe_metrics": {
        "audio_rms_db": -28.5,
        "rms_similarity": 0.91,
        "silence_agreement": 1.0,
        "spectral_similarity": 0.85,
        "noise_floor_similarity": 0.88,
        "frame_rate": 23.8,
        "latency_ms": 340
      }
    },
    {
      "source_id": "src_002",
      "source_name": "KiwiSDR @ XY9ZZ",
      "rank": 2,
      "score": 0.71,
      "distance_km": 320.8,
      "last_probed": "2026-03-14T10:30:05Z",
      "probe_metrics": { ... }
    },
    {
      "source_id": "src_003",
      "source_name": "KiwiSDR @ QR4ST",
      "rank": 3,
      "score": 0.58,
      "distance_km": 890.1,
      "last_probed": "2026-03-14T10:30:10Z",
      "probe_metrics": { ... }
    }
  ]
}
```

#### `fallback_switch`

Sent when an automatic failover occurs. Provides context about why the switch happened.

```json
{
  "type": "fallback_switch",
  "stream_id": "abc123",
  "from_source_id": "src_old",
  "to_source_id": "src_001",
  "reason": "connection_lost",
  "backoff_ms": 2000
}
```

Reasons: `"connection_lost"`, `"frame_rate_degraded"`, `"repeated_errors"`.

#### `fallback_probing`

Optional status update during probing, so the UI can show progress. Sent each time a candidate finishes probing.

```json
{
  "type": "fallback_probing",
  "stream_id": "abc123",
  "candidates_total": 10,
  "candidates_probed": 4,
  "current_candidate": "src_005"
}
```

### New Message Types (Client → Server)

#### `switch_fallback`

User manually clicks a fallback suggestion to switch to it.

```json
{
  "type": "switch_fallback",
  "source_id": "src_001"
}
```

This triggers the same `Reconfigure` path as any source switch, but is initiated from the fallback panel rather than the source picker.

#### `reprobe_fallbacks`

User manually requests a fresh probe cycle. This clears all existing suggestions immediately and starts a new discovery + probe cycle from scratch.

```json
{
  "type": "reprobe_fallbacks"
}
```

On receipt, the backend:

1. Deletes the stream's rows from `fallback_suggestions`.
2. Broadcasts a `fallback_updated` event with an empty `suggestions` array (so the UI clears immediately).
3. Cancels any in-progress probe cycle for this stream.
4. Resets the 5-minute ticker so the next scheduled cycle is a full 5 minutes after this manual one completes.
5. Starts a new full cycle (discovery → status check → deep probe → rank → persist → broadcast).

This is useful when conditions have changed — the user retuned to a different frequency, moved to a different part of the band, or simply wants fresher results than the 5-minute cycle provides. Resetting the ticker avoids a redundant scheduled cycle firing shortly after the manual one.

---

## API Changes

### Stream PATCH

The existing `PATCH /api/streams/{id}` accepts two new fields:

```json
{
  "auto_fallback": true,
  "auto_fallback_kind": "auto"
}
```

When `auto_fallback` transitions from `false` to `true`, the API layer calls `fallbackManager.Enable(streamID)`. When it transitions to `false`, it calls `fallbackManager.Disable(streamID)`.

### New Endpoint: GET /api/streams/{id}/fallbacks

Returns the current fallback suggestions for a stream. This is a convenience endpoint for clients that aren't connected via WebSocket.

```json
{
  "stream_id": "abc123",
  "auto_fallback": true,
  "auto_fallback_kind": "auto",
  "suggestions": [ ... ],
  "quality": {
    "state": "healthy",
    "frame_rate": 23.8,
    "silence_ratio": 0.02,
    "uptime_seconds": 3600
  }
}
```

---

## Database Migration

```sql
-- migrations/009_stream_auto_fallback.up.sql
ALTER TABLE streams ADD COLUMN auto_fallback BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE streams ADD COLUMN auto_fallback_kind TEXT NOT NULL DEFAULT 'auto';

CREATE TABLE fallback_suggestions (
    stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    rank        INTEGER NOT NULL,             -- 1, 2, or 3
    score       DOUBLE PRECISION NOT NULL,    -- 0.0–1.0
    distance_km DOUBLE PRECISION NOT NULL,
    probe_metrics JSONB NOT NULL DEFAULT '{}', -- ProbeMetrics blob
    last_probed TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (stream_id, rank)
);

CREATE INDEX idx_fallback_suggestions_stream ON fallback_suggestions(stream_id);
```

```sql
-- migrations/009_stream_auto_fallback.down.sql
DROP TABLE IF EXISTS fallback_suggestions;
ALTER TABLE streams DROP COLUMN auto_fallback_kind;
ALTER TABLE streams DROP COLUMN auto_fallback;
```

The `fallback_suggestions` table is small and low-write (3 rows per stream, upserted every 5 minutes). The `PRIMARY KEY (stream_id, rank)` means each stream has at most 3 rows, and the prober replaces them atomically each cycle (DELETE + INSERT in a transaction).

No PostgreSQL extensions needed — geographic distance is computed in Go.

---

## Frontend

### Auto-Fallback Toggle

The toggle lives in the stream player's sidebar, inside the source details section (or just below it). It's a simple switch:

```
┌─────────────────────────────────────────────────┐
│ SOURCE                                [Change]  │
│ KiwiSDR @ AB1CDE                                │
│ 145.3 km away · SNR 42 dB                       │
│                                                 │
│ Auto-Fallback                        [switch]   │
│                                                 │
│ ┌─ when enabled: ─────────────────────────────┐ │
│ │                                             │ │
│ │  Fallback Sources   [Reprobe] probing 4/10  │ │
│ │                                             │ │
│ │  1. KiwiSDR @ XY9ZZ           score 0.82   │ │
│ │     320 km · 12.4 dB SNR        [Switch]   │ │
│ │                                             │ │
│ │  2. KiwiSDR @ QR4ST           score 0.71   │ │
│ │     890 km · 8.2 dB SNR        [Switch]    │ │
│ │                                             │ │
│ │  3. KiwiSDR @ MN2OP           score 0.58   │ │
│ │     1,200 km · 6.1 dB SNR     [Switch]     │ │
│ │                                             │ │
│ │  Mode: Auto-switch on degradation           │ │
│ │  ──── or ────                               │ │
│ │  Mode: Suggest only (manual switch)         │ │
│ │                                             │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### Fallback Panel Component

New file: `frontend/src/components/fallback-panel.tsx`

```typescript
type FallbackSuggestion = {
  source_id: string;
  source_name: string;
  rank: number;
  score: number;
  distance_km: number;
  last_probed: string;
  probe_metrics: {
    audio_rms_db: number;
    dynamic_range_db: number;
    silence_ratio: number;
    frame_rate: number;
    wf_snr_db: number;
    latency_ms: number;
  };
};

type FallbackPanelProps = {
  enabled: boolean;
  kind: "auto" | "manual";
  suggestions: FallbackSuggestion[];
  probeProgress: { total: number; probed: number } | null;
  onToggle: (enabled: boolean) => void;
  onKindChange: (kind: "auto" | "manual") => void;
  onSwitchTo: (sourceId: string) => void;
  onReprobe: () => void;
};
```

### UI Behavior

- **Toggle off:** Only the "Auto-Fallback" label and switch are visible. No fallback list.
- **Toggle on, probing:** The panel expands. A progress indicator shows "Probing 4/10..." while the deep prober works through candidates. The "Reprobe" button is disabled during an active cycle.
- **Toggle on, results ready:** The top 3 suggestions are displayed with their score, distance, and a "Switch" button. The "Reprobe" button is enabled.
- **Reprobe button:** Clears the current suggestions from the UI immediately (empty list), then kicks off a fresh discovery + probe cycle. Useful after retuning, or if conditions have changed and the user doesn't want to wait for the next 5-minute tick.
- **Auto-switch event:** When an automatic failover occurs, a toast notification appears: "Auto-fallback: switched to KiwiSDR @ XY9ZZ (connection lost)". The source details update to reflect the new source. The fallback list refreshes.
- **Score visualization:** Each suggestion's score (0.0–1.0) is shown as a colored badge: green (>0.7), yellow (0.4–0.7), red (<0.4). This gives an immediate visual sense of fallback quality.

### Integration with `stream-player-page.tsx`

The fallback panel is placed in the sidebar, below the source details panel and above post-processing:

```tsx
{/* Source section */}
<SourceDetailsPanel ... />

{/* Fallback section (new) */}
<FallbackPanel
  enabled={stream?.auto_fallback ?? false}
  kind={stream?.auto_fallback_kind ?? "auto"}
  suggestions={fallbackSuggestions}
  probeProgress={probeProgress}
  onToggle={(enabled) => sendPatch({ auto_fallback: enabled })}
  onKindChange={(kind) => sendPatch({ auto_fallback_kind: kind })}
  onSwitchTo={(sourceId) => ws.send({ type: "switch_fallback", source_id: sourceId })}
  onReprobe={() => ws.send({ type: "reprobe_fallbacks" })}
/>

{/* Post-processing section */}
<PostProcessingPanel ... />
```

The page listens for `fallback_updated`, `fallback_switch`, and `fallback_probing` WebSocket events and updates state accordingly.

---

## Probe Scoring Details

### Comparative Metrics

The scoring model is fundamentally **comparative** — it measures how similar a candidate looks to the current stream, not how "good" it looks in absolute terms. This is critical because "good" is context-dependent: a silent frequency is perfectly healthy if that's what the user is monitoring.

| Metric | 0.0 (worst) | 1.0 (best) | How |
|--------|------------|------------|-----|
| Silence agreement | One is silent, the other has signal | Both silent, or both have signal | `1 - abs(candidate_silence - reference_silence)` |
| WF spectral similarity | Completely different spectral shape | Identical spectral shape | Cosine similarity of in-band WF bins |
| RMS similarity | RMS levels differ by >30 dB | RMS levels within 3 dB | `1 - clamp(abs(delta) / 30, 0, 1)` |
| Noise floor similarity | Floor levels differ by >20 dB | Floor levels within 3 dB | `1 - clamp(abs(delta) / 20, 0, 1)` |
| Frame rate | 0 fps | 24 fps (expected) | Absolute: `candidate_rate / expected_rate` |
| Latency | 5000 ms | 100 ms | Absolute: inverted, clamped |

The first four metrics are relative to the reference snapshot. Frame rate and latency are absolute — a source that can't deliver frames is broken regardless of what the reference looks like.

### Minimum Viable Score

A fallback candidate must score above 0.1 to be included in the suggestion list. This filters out sources that technically respond but whose reception looks nothing like the current stream — wrong spectral shape, wildly different levels, or broken frame delivery.

### Score Staleness

If a suggestion hasn't been re-probed in 15 minutes (3 missed cycles), its score decays linearly toward 0. This ensures stale suggestions don't persist when the probe loop is interrupted or slow, while giving enough headroom for the normal 5-minute cycle plus some jitter.

---

## Quality Monitor Details

### Frame-Level Metrics Collection

The quality monitor hooks into the existing `startPump` loop. Instead of a separate goroutine reading from a channel, it's a lightweight struct that gets called on each frame:

```go
type QualityMonitor struct {
    state           DegradationState  // HEALTHY, DEGRADED, FAILING, SWITCHING
    lastFrameAt     time.Time
    frameCount      int64
    windowStart     time.Time
    windowFrames    int64             // frames received in current 10-second window
    consecutiveErrs int               // consecutive read errors
    degradedSince   time.Time
    failoverCount   int
    lastFailoverAt  time.Time
    onDegraded      func(reason string) // callback to fallback session
}

func (q *QualityMonitor) RecordFrame(frame []byte) {
    now := time.Now()
    q.lastFrameAt = now
    q.frameCount++
    q.windowFrames++
    q.consecutiveErrs = 0
    // check frame rate over sliding window
    // transition state machine if needed
}

func (q *QualityMonitor) RecordError() {
    q.consecutiveErrs++
    // 3+ consecutive errors → DEGRADED
}

func (q *QualityMonitor) CheckTimeout() {
    // called on a 1-second ticker in the pump
    // detects frame gaps > 2 seconds
    // checks frame rate over the last 10-second window
}
```

No RMS tracking, no silence detection. The quality monitor is purely a transport-layer health check: are frames arriving at the expected rate, and is the connection alive? Audio content analysis is the probe scorer's domain.

### Integration with Pump

The quality monitor is only active when `auto_fallback` is on. It adds negligible overhead — one RMS computation per frame (~2 µs for 512 samples) and a few comparisons.

```go
// In startPump:
case frame, ok := <-client.Samples():
    // ... existing processing ...
    if as.qualityMonitor != nil {
        as.qualityMonitor.RecordFrame(filtered)
    }

case <-qualityTicker.C:
    if as.qualityMonitor != nil {
        as.qualityMonitor.CheckTimeout()
    }
```

---

## Package Layout

```
internal/
  fallback/
    manager.go          // FallbackManager, session lifecycle, Enable/Disable
    discovery.go        // candidate discovery (Haversine, source filtering)
    prober.go           // deep prober (connect, collect, score)
    scorer.go           // quality scoring logic (normalization, weighting)
    quality.go          // QualityMonitor (frame-level degradation detection)
    types.go            // FallbackSuggestion, ProbeMetrics, candidateSource, etc.
    haversine.go        // Haversine distance calculation
    manager_test.go     // tests
```

---

## Performance Budget

| Operation | Frequency | Cost | Notes |
|-----------|-----------|------|-------|
| Discovery (Haversine sort) | Every 5min per stream | <1ms (sort ~5K sources in Go) | Pure arithmetic, no DB round-trip beyond source cache |
| Status checks (stage 1) | 10 candidates × every 5min | ~1s total (concurrent HTTP GETs) | Eliminates 2–5 candidates cheaply |
| Deep probes (stage 2) | ~6 candidates × every 5min | ~30s total, 1 listener slot at a time | Freed after 3s analysis window each |
| Probe analysis | Per deep probe, 70 frames | ~50µs (RMS + comparisons) | No FFT needed — WF data arrives pre-transformed |
| Quality monitor | Per audio frame (~24/sec) | ~2µs per frame | RMS computation only |
| DB persistence | 3 rows upserted per cycle | ~1ms | DELETE + INSERT in transaction |
| WebSocket broadcast | On suggestion change | ~1KB JSON | Same as existing broadcasts |

The system adds no measurable CPU or memory overhead to the audio hot path. The status check stage filters out ~40% of candidates before any WebSocket connections are opened. The most expensive operation is the deep probe connection itself, which consumes a KiwiSDR listener slot for ~5 seconds. With the global concurrency cap (default 3), the system uses at most 3 listener slots across all streams for probing at any given moment.

---

## Implementation Order

| Step | Task | Scope | Depends On |
|------|------|-------|------------|
| 1 | DB migration: `auto_fallback`, `auto_fallback_kind` columns | Backend | Nothing |
| 2 | Add fields to `models.Stream`, update DB read/write | Backend | Step 1 |
| 3 | Haversine utility + candidate discovery (in-memory sort) | Backend | Nothing |
| 4 | Deep prober: connect, collect, disconnect | Backend | Nothing |
| 5 | Probe scorer: metric extraction, normalization, weighting | Backend | Step 4 |
| 6 | `FallbackManager` + `fallbackSession` lifecycle | Backend | Steps 2, 3, 5 |
| 7 | Quality monitor: frame-level metrics, state machine | Backend | Nothing |
| 8 | Wire quality monitor into `startPump` | Backend | Steps 6, 7 |
| 9 | Failover execution: backoff, source switch, re-probe | Backend | Steps 6, 8 |
| 10 | Override "stop if no subscribers" when `auto_fallback=true` | Backend | Step 2 |
| 11 | Integrate `ensureReconnect` with fallback suggestions | Backend | Steps 6, 10 |
| 12 | WebSocket events: `fallback_updated`, `fallback_switch`, `fallback_probing` | Backend | Step 6 |
| 13 | WebSocket handler: `switch_fallback` and `reprobe_fallbacks` messages from client | Backend | Step 12 |
| 14 | PATCH handler: toggle `auto_fallback`, call Enable/Disable | Backend | Steps 2, 6 |
| 15 | REST endpoint: `GET /api/streams/{id}/fallbacks` | Backend | Step 6 |
| 16 | Frontend: `FallbackPanel` component | Frontend | Nothing |
| 17 | Frontend: integrate panel into `stream-player-page.tsx` | Frontend | Steps 12, 16 |
| 18 | Frontend: handle `fallback_updated`, `fallback_switch`, `fallback_probing` events | Frontend | Steps 12, 17 |
| 19 | Frontend: toast notifications for auto-switch events | Frontend | Step 18 |

**Recommended sequencing:**

**Phase 1 — Foundation (steps 1–6):** Build the data layer, discovery, prober, and manager lifecycle. Verify by enabling auto-fallback on a stream and observing probe connections in logs.

**Phase 2 — Failover (steps 7–11):** Add quality monitoring and automatic switching. Test by killing a KiwiSDR connection and confirming the stream switches to a fallback.

**Phase 3 — Frontend (steps 12–19):** Wire up the WebSocket events and build the UI. End-to-end verification with the fallback panel visible and functional.

---

## Testing Strategy

### Unit Tests

| Test | Method |
|------|--------|
| Haversine distance | Known lat/lon pairs with expected distances |
| Candidate ranking | Mock sources at various distances, verify sort order |
| Probe scoring | Feed synthetic audio/WF data, verify scores match expected |
| Score normalization | Edge cases: all silence, max RMS, zero latency |
| Quality monitor state machine | Simulate frame patterns (healthy, degraded, gap, silence) and verify state transitions |
| Backoff calculation | Verify exponential backoff timing and reset after stability window |

### Integration Tests

| Test | Method |
|------|--------|
| Full probe cycle | Start a probe against a real or mocked KiwiSDR, verify connection, data collection, scoring, and disconnection |
| Failover execution | Mock a stream with degraded quality, verify it switches to fallback source |
| Keep-alive behavior | Enable auto-fallback, remove all subscribers, verify stream stays alive |
| Discovery refresh | Change source availability mid-session, verify candidate list updates |

### Manual Testing

| Scenario | How to Test |
|----------|------------|
| Happy path | Enable auto-fallback, verify 3 suggestions appear in UI |
| Source goes offline | Kill the current source's KiwiSDR, observe automatic switch |
| All fallbacks bad | Enable on a frequency with no nearby good sources, verify graceful degradation |
| Rapid toggling | Toggle auto-fallback on/off/on/off rapidly, verify no goroutine leaks |
| Multi-stream | Enable auto-fallback on 3 streams simultaneously, verify probe concurrency cap |

---

## Known Hard Parts

1. **Probe connection etiquette.** KiwiSDR receivers have limited listener slots (typically 4). Each probe consumes a slot for ~5 seconds. On a busy receiver, this could prevent a real listener from connecting. The global concurrency cap and short analysis window mitigate this, but it's still a concern. Consider adding a config option to skip probing sources that are at `users = max_listeners - 1` (only 1 slot left).

2. **Probe accuracy vs. duration.** A 3-second analysis window may miss intermittent signals (CW transmissions, digital mode bursts). Extending the window improves accuracy but consumes the listener slot longer and slows the probe cycle. The comparative scoring model helps here — if the reference snapshot is also silent during a gap between transmissions, a candidate that's equally silent scores well on silence agreement. The 3-second window doesn't need to capture a transmission; it just needs to capture the *same conditions* the reference captured.

3. **Geographic proximity ≠ signal similarity.** Two receivers 100 km apart on the same continent will likely receive similar HF signals, but propagation is complex. A receiver 100 km away on the other side of a mountain range might receive very differently. The deep probe addresses this — it doesn't trust geography alone, it verifies actual signal quality. Geography is only used to narrow the candidate list to a manageable size.

4. **Reference snapshot timing.** The reference snapshot is taken once at the start of a probe cycle. If the signal changes during the ~30 seconds of probing (e.g., a transmission starts or stops), later candidates are compared against a stale reference. This is acceptable — the snapshot represents "what the stream looked like when we started probing," and a 30-second staleness window is fine for HF signals. If conditions change drastically, the user can hit Reprobe.

5. **Race between manual and automatic switch.** If the user clicks "Switch" on a fallback at the same moment the quality monitor triggers an automatic switch, two `Reconfigure` calls race. The stream manager's existing generation counter handles this — only one will win, and the other's connection will be discarded. The UI may briefly show a confusing state (source A → source B, then immediately → source C), but it will converge.

6. **WF data availability.** Some KiwiSDR sources don't send waterfall data (broken W/F connection, or the source is audio-only). The prober must handle this gracefully — score only on audio metrics and set WF-derived metrics to neutral values (0.5 normalized).

---

## Future Considerations

**Persistent fallback history.** Track which sources have been used as fallbacks over time, and how long each lasted before the next failover. This data could feed a longer-term source reliability model — sources that consistently work well as fallbacks get a ranking boost.

**Cooperative fallback.** If multiple users are listening to the same frequency in the same region, their fallback managers are independently probing the same candidate sources. A shared probe cache (keyed by source + frequency + time window) could eliminate redundant connections. Not needed initially — probe connections are cheap and short.

**Fallback chains.** If the first fallback also fails, the system currently re-probes and picks a new top candidate. A future optimization could maintain a pre-computed failover chain (source A → source B → source C) so the second switch is instant, without waiting for a re-probe cycle.

**Smart radius adjustment.** If no candidates score above the minimum threshold within the default 2000 km radius, automatically expand the search. Conversely, if many excellent candidates exist nearby, shrink the radius to reduce probe time. This adaptive behavior isn't needed initially — 2000 km covers most continental use cases.

**Probe result sharing.** When one stream probes a source at frequency X, and another stream is also tuned to frequency X, the second stream could use the first stream's probe results. This requires a probe result cache keyed by `(source_id, frequency_khz, mode, timestamp)`. Useful at scale but adds complexity.
