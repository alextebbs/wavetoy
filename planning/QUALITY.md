# Quality Monitor & Automatic Source Switching

## Goal

A single per-stream capability: **if anything goes wrong with your source or the connection to it, we switch to a better one automatically.** The user's eventual interaction is one button. The backend keeps the concerns separate so each subsystem can be developed, tested, and reasoned about independently.

---

## Current State & What's Wrong

### Three systems that should work together but don't

**`auto_probe`** — Periodically probes nearby KiwiSDR sources, scores them, maintains ranked fallback suggestions. Works well. But it also *owns automatic source switching* via the reconnect loop, which it shouldn't. Probing is about keeping your options fresh. Switching is a separate decision.

**`quality_fallback`** — Exists in the DB, the model, the API, and the frontend toggle. Does absolutely nothing. It was intended to be a continuous quality monitor that triggers `HandleDegraded`, but was never built.

**Health flags** (`audio_stale`, `wf_stale`, `too_busy`) — Fully wired for display. `syncHealth()` detects them, persists to DB, broadcasts via WebSocket, bakes them into chunk metadata. But they're purely informational — nothing reads them to trigger action.

### The reconnect loop does too much

The reconnect loop in `ensureReconnect` currently owns the fallback decision, gated on `autoProbe`:

- After 3 consecutive **failed** reconnects → `HandleDegraded("reconnect_failed")`
- After 10 unstable reconnects → error state + `HandleDegraded("unstable_reconnect")`

This only fires when reconnects **fail**. If a source keeps kicking us off every 10 seconds but we reconnect successfully each time, the fallback never triggers. The connection is technically "working" — but we're losing data on every cycle and the experience is garbage.

### What "degraded" means is unclear

Today, degradation is binary: either the reconnect loop ran out of patience, or it didn't. There's no continuous quality assessment. A source delivering audio with a -80 dB noise floor and dropping waterfall frames every 30 seconds is treated identically to a clean source delivering perfect data.

---

## The New Model

### `auto_probe` — keeps your options fresh

Unchanged in behavior. Periodic probe cycles (every 10 min), discovers nearby sources, probes them, maintains ranked suggestions. **Does not trigger source switching on its own.** The reconnect loop no longer checks `autoProbe` to decide whether to call `HandleDegraded`. Probing produces scores and in-band SNR measurements that the QualityMonitor uses to make switching decisions.

### `quality_fallback` — owns all automatic switching

When enabled:

1. **Starts the QualityMonitor** — a per-stream goroutine that continuously evaluates connection health and triggers `HandleDegraded` when quality is unacceptable.
2. **Implies keep-alive** — a stream being quality-monitored should never idle-disconnect. If `quality_fallback` is on, the stream stays connected regardless of subscriber count.
3. **Implies auto-probe** — if `quality_fallback` is on but `auto_probe` is off, the system enables probing automatically. You can't switch to a better source if you haven't found one. (The backend enables probing as a side effect; the `auto_probe` DB field stays as-is so the user can still independently toggle it off if they later disable `quality_fallback`.)

When the QualityMonitor decides the current source is degraded, it calls `HandleDegraded(streamID, reason)` with a specific, loggable reason. `HandleDegraded` picks the top probe suggestion and switches via `Reconfigure`, same as today.

### `keep_alive` — independent but subsumable

Stays as its own toggle. `quality_fallback = true` implies keep-alive behavior (the monitor needs the connection alive), but a user can enable `keep_alive` without `quality_fallback` if they just want the connection held open.

---

## Health Flags: Expanded

The current three health flags are necessary but not sufficient. Add one new flag that captures the "kicked every 10 seconds" pattern:

### Existing

| Flag | Trigger | Current behavior |
|---|---|---|
| `audio_stale` | No audio frames for ≥ 10s | Set in pump, display-only |
| `wf_stale` | No WF frames for ≥ 10s | Set in WF pump, display-only |
| `too_busy` | KiwiSDR sends `too_busy` MSG | Set via `SetOnTooBusy`, display-only |

### New

| Flag | Trigger | Behavior |
|---|---|---|
| `reconnect_churn` | ≥ 3 reconnects within a 5-minute rolling window where each connection lasted < 30s | Set in `ensureReconnect`, tracked via a small ring of timestamps |

#### Reconnect churn detection

The reconnect loop already tracks `reconnectAttempts` and `lastConnectedAt`. Add a small rolling window (e.g. a `[8]time.Time` ring buffer on `activeStream`) that records the timestamp of each reconnect. On each reconnect, check: in the last 5 minutes, how many reconnects happened where the preceding connection lasted < `reconnectStabilityThreshold` (30s)? If ≥ 3, set `reconnect_churn`.

This catches the exact pattern the user described: sources that accept the connection, deliver data briefly, then drop us — repeatedly. Each individual reconnect "succeeds," so the existing fallback logic never fires. But the pattern is clearly degraded.

### Health flag encoding

Add `HealthReconnectChurn` to the bitmask in `state.go`:

```go
const (
    HealthAudioStale    uint8 = 1 << iota
    HealthWFStale
    HealthTooBusy
    HealthReconnectChurn
)
```

Frontend gets `reconnect_churn` in the health array, displays as `S/CHURN` or similar chip.

---

## The QualityMonitor

A per-stream goroutine, created when `quality_fallback` is enabled, destroyed when disabled.

### What it watches

The monitor doesn't collect its own data. It reads the health flags and reconnect history that `streammgr` already maintains, plus a few new lightweight metrics.

| Signal | Source | How it's read |
|---|---|---|
| `audio_stale` | `activeStream.audioStale` | Atomic bool, already updated by pump |
| `wf_stale` | `activeStream.wfStale` | Atomic bool, already updated by WF pump |
| `too_busy` | `activeStream.tooBusy` | Atomic bool, already updated via kiwi client |
| `reconnect_churn` | New rolling window on `activeStream` | Check ring of reconnect timestamps |
| Stream state | `activeStream` state | `reconnecting`, `error` |
| Connection age | `activeStream.lastConnectedAt` | How long we've been connected |
| In-band SNR | Most recent WF frame from pump | Computed every 10s by the monitor itself (see "In-Band SNR Monitoring") |

### Decision logic

The monitor ticks every 5 seconds. On each tick:

```
if state == error:
    trigger("stream_error")

if too_busy:
    trigger("too_busy")

if reconnect_churn:
    trigger("reconnect_churn")

if audio_stale AND wf_stale:
    trigger("all_data_stale")

if audio_stale for >= 30s:
    trigger("audio_stale_prolonged")

if wf_stale for >= 30s:
    trigger("wf_stale_prolonged")

if in_band_snr dropped >= 15 dB from baseline for >= 60s:
    trigger("signal_degraded")

if probe suggestion has in-band SNR >= 15 dB better than ours, sustained across 2+ probe cycles:
    trigger("better_source_available")
```

The triggers fall into two categories:

**Reactive (something broke):** `stream_error`, `too_busy`, `reconnect_churn`, `all_data_stale`, `audio_stale_prolonged`, `wf_stale_prolonged`. These fire when the current source has a clear problem. Conservative thresholds — a brief stale period during reconnection is normal, but 30+ seconds of stale data is unacceptable.

**Proactive (something better exists):** `signal_degraded`, `better_source_available`. These fire when the current source is technically working but a better option is available. This is the key shift — we don't wait for the source to break. If our in-band SNR is 3 dB and a probe candidate consistently measures 25 dB, that candidate is hearing a broadcast we're missing. We should switch.

`better_source_available` requires the SNR advantage to persist across 2+ consecutive probe cycles (20+ minutes). This prevents switching on a single lucky measurement. HF propagation is volatile — a candidate that's 15 dB better for one 10-minute window might equalize in the next. Two consecutive cycles means the advantage is real and sustained.

`signal_degraded` is the same idea but triggered by our own stream's SNR dropping, rather than a candidate being better. It has a 60-second grace period because propagation fluctuates. When it triggers, the monitor checks whether any suggestion has meaningfully better SNR before switching — if everyone's SNR is low, the broadcast went off the air and switching won't help.

### Debounce, cooldown, and anti-thrashing

After triggering `HandleDegraded`, the monitor enters a 60-second cooldown. During cooldown, it continues monitoring but won't trigger again.

If the switch fails (no suggestions available, or `Reconfigure` errors), the monitor logs a warning and backs off to a 5-minute cooldown before trying again.

**Source blacklist.** When we switch *away* from a source due to a quality problem, that source is blacklisted for 30 minutes. The blacklist is a `map[string]time.Time` on the QualityMonitor — source ID to expiry time. `HandleDegraded` skips blacklisted sources when picking a suggestion. This prevents the A→B→A loop: if we left source A because it was churning, we won't switch back to it 60 seconds later just because it's the top probe suggestion.

The blacklist also feeds into discovery — blacklisted sources are excluded from candidate lists during probe cycles, so we don't waste a probe slot on a source we recently abandoned.

Blacklist entries expire after 30 minutes. If a source was bad due to a transient issue (temporary overload, brief network problem), 30 minutes is enough time for it to recover. If the problem is persistent, the next probe cycle will score it poorly and it won't become a top suggestion anyway.

**Escalating cooldown.** If the monitor switches twice within 5 minutes, the cooldown extends to 5 minutes. If it switches three times within 15 minutes, cooldown extends to 15 minutes. This is the backstop against cascading failures where every available source is bad. The log clearly shows what happened: three switches in quick succession, each with a reason, and then a 15-minute pause.

### Favorites

Favorited sources (per-tenant, already in `favorite_sources` table) get special treatment throughout the probe and switching pipeline:

**Probe priority, not exemption.** Favorites follow the same rules as every other candidate — they must be in range and they get probe-cooled if they don't make the top 3. The difference: when filling the 7 exploration slots, eligible favorites sort to the front of the queue ahead of non-favorites. We expect them to be good, so we check them first. But if they bomb, they cool down like anyone else.

**Score bonus (+0.10).** A favorite scoring 0.70 ranks equal to a non-favorite scoring 0.80. The user's endorsement is real information — "this source sounds clean and never kicks us off" — that the automated scoring can't easily capture. But it's not an override; a favorite with 3 dB in-band SNR won't beat a non-favorite with 25 dB.

**Switching tiebreaker.** When `HandleDegraded` picks a suggestion and two candidates are within 0.05 score of each other, prefer the favorite.

**Shorter blacklist (10 min vs 30 min).** The user already told us this source is reliable. If we switched away from it due to a transient issue, try it again sooner.

The probe cycle needs access to the tenant's favorite list. Since streams belong to tenants, the cycle can load `ListFavoriteSourceIDs` once at the start and pass them into discovery and scoring.

### Relationship to the reconnect loop

The reconnect loop **no longer calls `HandleDegraded` directly**. It still does its job — reconnecting with backoff, tracking attempts, entering error state after `maxUnstableReconnects`. But the decision to switch sources belongs to the QualityMonitor.

The reconnect loop's `autoProbe` checks on lines 1290 and 1324 are removed. Instead, the QualityMonitor observes the stream state (`reconnecting`, `error`) and the health flags, and makes the switching decision.

This means: if `quality_fallback` is off, no automatic switching ever happens, regardless of `auto_probe`. The reconnect loop retries the same source until it succeeds or gives up. If `quality_fallback` is on, the monitor watches the reconnect loop's behavior (via health flags and state) and intervenes when it detects a pattern that won't resolve itself.

---

## Better Probing

The current probe system connects to a candidate for 3 seconds, collects audio + waterfall, scores against a reference snapshot, disconnects. This works but has meaningful limitations.

### Problem 1: 3 seconds is too short

A shortwave broadcast might have a 5-second fade cycle. A Morse code transmission has gaps. 3 seconds can land entirely in a null, giving a misleading silence ratio and RMS. The probe scores the candidate as "both silent, high agreement!" when in reality the candidate has a much noisier noise floor that would be apparent with more data.

**Fix: 30-second probe window.** Listen for 30 seconds. This gives us multiple fade cycles, a much better read on the noise floor, a real picture of frame delivery consistency, and enough data to compute a meaningful in-band SNR. The 3-second window was chosen for politeness, but 30 seconds is still a brief visit — a human listener typically stays on a KiwiSDR for minutes to hours.

**Probe audio storage:** Currently we store the full PCM of each probe in the DB (for the debug audio download endpoints). At 30 seconds, that's ~720 KB per candidate. We don't need to store the whole thing. Store the first 3 seconds of audio (for the debug playback UI) and the computed metrics. The full 30 seconds is used for scoring, then discarded.

### Problem 2: Too few candidates, probed too slowly, always the same ones

Currently we discover 5 candidates, probe them sequentially, sorted by distance. The same 5 nearest sources get probed every cycle. A quiet rural KiwiSDR 500 km away never gets a chance because 5 noisy urban receivers are closer.

**Fix: 10 candidate slots, parallel probing, with probe rotation.**

Probe in parallel (up to 4 concurrent). A full cycle of 10 candidates at 30 seconds each with parallelism of 4 completes in ~90 seconds.

The 10 slots are filled in two tiers:

1. **Re-verify (top suggestions).** The current top 3 suggestions always get slots. Their scores need to stay fresh since they're what we'd actually switch to.

2. **Explore (discovery).** The remaining slots fill from `DiscoverCandidates`, sorted by distance, but **skipping sources that were probed in a recent cycle and didn't make the top 3 cut.** These sources get a probe cooldown of 3 cycles (30 minutes). When the cooldown expires, they're eligible again.

The effect: the search naturally expands outward. Cycle 1 probes the 10 closest sources. Suppose 3 make the cut. Cycle 2 re-probes those 3 plus 7 new sources further out (the 7 low-scorers from cycle 1 are cooled down). Cycle 3 goes further still. Over several cycles, the system explores a wide area without needing a fixed large radius. When cooldowns expire, nearby sources are re-checked — conditions may have changed.

The radius limit (`DefaultMaxRadiusKm`) is bumped from 2,000 km to 10,000 km. It matters less now because the rotation mechanism naturally reaches further when nearby sources are poor — the radius is just a safety net, not the primary filter.

```go
const (
    ProbeCycleInterval  = 10 * time.Minute
    MaxCandidates       = 10
    MaxConcurrentProbes = 4
    ProbeAnalysisWindow = 30 * time.Second
    ProbeStoredAudio    = 3 * time.Second   // how much PCM to persist for debug
    ProbeCooldownCycles = 3                 // skip low-scorers for this many cycles
)
```

### Problem 3: The reference snapshot is taken once, at the start

The probe cycle takes a reference snapshot from the live stream, then probes candidates in parallel. But the band can change during the cycle — a broadcast can start or stop, propagation can shift.

**Fix: Bracketing reference snapshots.** Take a reference snapshot at the start, and a "check" snapshot from the live stream's recent data when scoring each candidate. Score against both, take the higher score. The "check" snapshot is just the last ~1 second of audio from the pump — no additional connection needed. This catches the case where conditions changed during the probe window.

### Problem 4: Cosine similarity on waterfall bins is naive

The spectral similarity metric does cosine similarity on the raw WF bin values. This is sensitive to gain differences between receivers, which are common — two receivers can have 20 dB gain offset.

**Fix: Normalize WF bins to zero-median before comparison.** Subtract the median bin value from each receiver's spectrum before computing cosine similarity. This removes the DC offset from gain differences and focuses on the spectral *shape* — where are the peaks relative to the noise floor?

### Problem 5: Scoring asks "how similar?" when it should ask "how good?"

The current scorer is almost entirely comparative — it measures how much a candidate *resembles* our current source. This is fundamentally the wrong question. If our source is hearing noise, a scorer that rewards similarity will find us another source that also hears noise. We want the source that's hearing the actual signal.

The goal isn't "find me a backup that sounds like what I have." The goal is "find me the best available source for this frequency." Scoring should be primarily about absolute reception quality.

**In-band SNR** is the centerpiece — an absolute metric computed entirely from the candidate's own data, no reference to our stream needed. See "SNR Package" below for the reusable computation. A candidate with 25 dB in-band SNR is hearing a clear signal. A candidate with 3 dB is hearing noise. This is the single most important thing to know about a candidate.

**Noise floor (absolute)** — not compared to our noise floor, just: how quiet is this receiver? Lower is better. A KiwiSDR in a rural area with a -55 dB floor is a better receiver than one in a city with -35 dB, period. Computed from out-of-band WF bins.

**Frame delivery consistency** — over a 30-second window, measure not just average frame rate but the jitter. Are frames arriving steadily, or in bursts with gaps? Computed as the coefficient of variation of inter-frame arrival times. A source with steady frame delivery is more reliable than one that averages the same rate but has 2-second dropouts.

The remaining comparative metrics (silence agreement, spectral similarity) are kept as minor tiebreakers. They're useful when multiple candidates have similar absolute quality — pick the one whose spectral character matches what we expect at this frequency. But they should never override a candidate with clearly better reception.

### Problem 6: No historical score tracking

A source that scored 0.85 once might have been lucky — good propagation at that moment. A source that scored 0.75 three cycles in a row is more reliable.

**Fix: Exponential moving average on probe scores.** Store a `score_ema` on `fallback_suggestions` alongside the raw `score`. Update: `score_ema = 0.3 * new_score + 0.7 * old_ema`. When ranking suggestions for `HandleDegraded`, sort by `score_ema` instead of raw score. This naturally favors consistently good sources over one-hit wonders.

**Favorite bonus.** After computing the raw score, add +0.10 if the source is in the tenant's favorites list. This bonus applies before EMA blending. Favorites represent the user's explicit trust — a strong prior that complements the automated metrics.

The EMA persists across probe cycles in the DB. When a source is re-probed, its row is updated with the new score and the blended EMA. Sources that weren't reachable in the latest cycle keep their old EMA but aren't bumped — staleness is a signal too.

EMA scores are invalidated (wiped) when the stream's frequency, mode, or bandwidth changes — see "Invalidation on tuning changes" above.

### Problem 7: Probing doesn't account for listener slot pressure

The current system filters out sources where `users >= max_listeners` during discovery. But it doesn't consider how close a source is to full. A KiwiSDR with 3/4 slots used is a riskier fallback target than one with 1/4 slots used.

**Fix: Add a slot availability factor to the score.** `slot_score = 1.0 - (users / max_listeners)`. Weight at 0.05 (minor tiebreaker). This gently prefers sources with more headroom.

### Summary of scoring changes

| Metric | Current Weight | Proposed Weight | Type | What it answers |
|---|---|---|---|---|
| **In-band SNR** | — | **0.35** | Absolute | Is this candidate hearing a clear signal at our frequency? |
| **Noise floor** | 0.10 (comparative) | **0.15** | Absolute | How quiet is this receiver? |
| **Frame delivery** | 0.10 (rate only) | **0.15** | Absolute | Steady data flow, low jitter? |
| Latency | 0.10 | 0.10 | Absolute | Responsive connection? |
| Slot availability | — | 0.05 | Absolute | Listener headroom? |
| Silence agreement | 0.30 | 0.10 | Comparative | Tiebreaker: similar activity pattern? |
| Spectral similarity | 0.25 | 0.10 | Comparative | Tiebreaker: same spectral shape? |
| ~~RMS similarity~~ | 0.15 | — | — | Removed: redundant with in-band SNR |

**80% absolute, 20% comparative.** The score now primarily answers "how good is this source?" rather than "how similar is this source to what we already have?" RMS similarity is dropped entirely — in-band SNR subsumes it. The comparative metrics remain as minor tiebreakers for cases where two candidates have similar absolute quality.

---

## Switching Protocol

When `HandleDegraded` fires, the switch must be well-documented. Today it logs `fb.failover` and `source.switch` and broadcasts `fallback_switch`. This is good but should be formalized.

### Required log entries on switch

Every automatic switch produces exactly these log entries:

```
[WARN]  quality.degraded    reason=reconnect_churn
[WARN]  fb.failover         reason=reconnect_churn target=src_XYZ score=0.82 score_ema=0.79
[INFO]  source.switch       src_ABC → src_XYZ (auto, reason=reconnect_churn)
```

The `reason` field is always one of a closed set:

| Reason | Meaning |
|---|---|
| `reconnect_churn` | Source keeps disconnecting us (≥3 short-lived connections in 5 min) |
| `too_busy` | Source sent `too_busy` message |
| `audio_stale_prolonged` | No audio frames for ≥ 30s |
| `wf_stale_prolonged` | No waterfall frames for ≥ 30s |
| `all_data_stale` | Both audio and waterfall stale simultaneously |
| `signal_degraded` | In-band SNR dropped ≥ 15 dB from baseline for ≥ 60s |
| `better_source_available` | A probe candidate has ≥ 15 dB better in-band SNR, sustained across 2+ probe cycles |
| `stream_error` | Stream entered error state (10 unstable reconnects) |

### WebSocket broadcast

The existing `fallback_switch` event already includes `from_source_id`, `to_source_id`, and `reason`. Add `reason_detail` for the frontend to show a human-readable explanation:

```json
{
  "type": "fallback_switch",
  "from_source_id": "src_ABC",
  "to_source_id": "src_XYZ",
  "reason": "reconnect_churn",
  "reason_detail": "Source disconnected 5 times in 3 minutes. Switched to KiwiSDR @ AB1CDE (score 0.82, 145 km away)."
}
```

### Frontend display

On switch, the log panel shows a prominent entry: "Auto-switched from [source A] to [source B]: source was disconnecting repeatedly." The status chip briefly flashes to indicate the transition.

### Post-switch behavior

After switching:
1. Clear existing probe suggestions (they were scored against the old source).
2. If `auto_probe` is on, immediately start a new probe cycle (re-probe with the new source as reference).
3. The QualityMonitor enters its 60-second cooldown, then resumes monitoring the new source.
4. If the new source is also bad and triggers another switch within 5 minutes, the cooldown extends to 5 minutes. This prevents thrashing across multiple bad sources.

### Invalidation on tuning changes

All probe suggestions — including EMA scores, reference audio, and probe audio — are specific to the stream's frequency, mode, and bandwidth at the time of probing. If any of these change, the suggestions are meaningless.

Today, `OnStreamUpdated` only reprobes when the source changes. It must also reprobe when any tuning parameter changes:

```go
func (m *Manager) OnStreamUpdated(stream models.Stream, sourceChanged bool, tuningChanged bool) {
    // ...
    if sourceChanged || tuningChanged {
        m.Reprobe(context.Background(), stream.ID)
    }
}
```

`tuningChanged` is true when `frequency_khz`, `mode`, `bandwidth_low_hz`, or `bandwidth_high_hz` differ from the previous values. `Reprobe` already deletes all `fallback_suggestions` rows (which wipes EMA scores) and starts a fresh probe cycle.

The in-band SNR baseline (see below) must also be reset on tuning changes — a different frequency has a completely different expected SNR.

---

## Data Model Changes

### Migration

```sql
-- Add score_ema and in-band SNR to fallback_suggestions
ALTER TABLE fallback_suggestions ADD COLUMN score_ema DOUBLE PRECISION;
ALTER TABLE fallback_suggestions ADD COLUMN in_band_snr_db DOUBLE PRECISION;
```

No schema changes needed for `quality_fallback` — the column already exists. The `reconnect_churn` health flag is computed in-memory from the reconnect timestamp ring buffer and persisted via the existing `UpdateStreamHealth` path (same as `audio_stale`, `wf_stale`, `too_busy`).

### Model changes

```go
type activeStream struct {
    // ... existing fields ...

    // Reconnect churn detection
    reconnectTimes [8]time.Time  // rolling window of reconnect timestamps
    reconnectIdx   int           // next write position in the ring
    reconnectChurn atomic.Bool   // derived health flag
}
```

### QualityMonitor state

```go
type Monitor struct {
    streamID    string
    onDegraded  func(streamID, reason string)
    getHealth   func() HealthSnapshot
    getWFFrame  func() *kiwi.WFFrame          // most recent WF frame from pump

    // SNR baseline
    snrSamples  [12]float64                    // rolling 2-min window (sampled every 10s)
    snrIdx      int
    snrBaseline float64                        // median of samples after establishment
    snrReady    bool                           // true after 2 min of samples

    // Anti-thrashing
    blacklist       map[string]time.Time       // source_id → expiry
    lastSwitchTimes [3]time.Time               // for escalating cooldown
    cooldownUntil   time.Time
}
```

---

## SNR Package

The in-band SNR calculation appears in three contexts today and will appear in more:

1. **Probe scoring** — compute SNR for each candidate during a probe cycle.
2. **Live monitoring** — the QualityMonitor samples SNR on the current source every 10 seconds.
3. **Frontend display** — stream the current source's SNR reading to the UI, show SNR per fallback suggestion.

It should be a small, pure, reusable package: `internal/snr/`.

### API

```go
package snr

// BandConfig defines the frequency region of interest.
type BandConfig struct {
    CenterKHz    float64  // tuned frequency
    PassbandLoHz int      // lower edge of passband relative to center (e.g. -4900)
    PassbandHiHz int      // upper edge of passband relative to center (e.g. 4900)
}

// Result holds a single SNR measurement.
type Result struct {
    InBandSNRdB   float64  // signal power minus noise floor, in dB
    SignalPowerdB float64  // mean power of in-band bins
    NoiseFloordB  float64  // mean power of out-of-band reference bins
    BinsUsed      int      // how many WF bins contributed to the measurement
}

// FromWFFrame computes in-band SNR from a single waterfall frame.
// The frame's metadata (xBin, zoom, frequency) is used to map bin
// indices to frequencies. Returns the measurement, or an error if
// the frame doesn't cover the passband.
func FromWFFrame(frame kiwi.WFFrame, band BandConfig) (Result, error)

// FromWFFrames computes a time-averaged SNR from multiple frames.
// Averages the bin values across frames before computing SNR,
// reducing noise in the measurement.
func FromWFFrames(frames []kiwi.WFFrame, band BandConfig) (Result, error)
```

### How it works

1. **Map bins to frequencies.** Each WF frame carries `xBin` (the starting bin index) and `zoom` level. Combined with the KiwiSDR's fixed 30 MHz bandwidth and the total bin count, each bin index maps to a frequency in kHz. This mapping is already implicit in the waterfall renderer — the SNR package makes it explicit.

2. **Identify in-band bins.** The bins whose frequencies fall within `CenterKHz + PassbandLoHz/1000` to `CenterKHz + PassbandHiHz/1000`.

3. **Identify out-of-band reference bins.** Bins in the region 2–5 kHz beyond each passband edge. These are close enough to share similar receiver characteristics (antenna gain, preamp response) but far enough to not contain signal energy from the tuned frequency.

4. **Compute.** `SignalPowerdB = mean(in-band bin values)`. `NoiseFloordB = mean(out-of-band bin values)`. `InBandSNRdB = SignalPowerdB - NoiseFloordB`.

### Users

| Caller | Input | How it's used |
|---|---|---|
| `fallback.ScoreCandidate` | Candidate's WF frames from 30s probe | Primary scoring metric (weight 0.35) |
| `quality.Monitor` | Live stream's most recent WF frame, every 10s | Baseline tracking, degradation detection |
| `api.StreamWS` (future) | Live stream's WF frame on each tick | Stream SNR reading to frontend via WebSocket |
| `api.GetFallbacks` (future) | Each suggestion's stored `in_band_snr_db` | Display SNR per fallback suggestion in UI |

The package has no dependencies on `streammgr`, `fallback`, or `quality` — it takes WF frame data in and returns a number. Any system that has access to WF frames can compute SNR.

---

## Implementation Order

### Phase 1: Health flag expansion + QualityMonitor skeleton

| # | Task | Notes |
|---|---|---|
| 1 | Add `reconnect_churn` health flag to `state.go` | New constant, bitmask, string |
| 2 | Add reconnect timestamp ring to `activeStream` | `[8]time.Time` + write position |
| 3 | Record reconnect timestamps in `ensureReconnect` | On each reconnect attempt, push to ring |
| 4 | Compute `reconnect_churn` from ring in `syncHealth` | Check: ≥3 entries in last 5 min with connection < 30s |
| 5 | Create `internal/quality/monitor.go` — QualityMonitor skeleton | Goroutine, 5s tick, reads health flags, calls `onDegraded` |
| 6 | Wire QualityMonitor into `streammgr` | Create/destroy on `quality_fallback` toggle |

**Verification:** Toggle `quality_fallback` on. Simulate `reconnect_churn` (manually set the flag). Confirm the monitor fires `HandleDegraded` and a source switch occurs with proper logging.

### Phase 2: Decouple auto_probe from switching

| # | Task | Notes |
|---|---|---|
| 7 | Remove `autoProbe` fallback checks from reconnect loop | Lines 1290 and 1324 — delete the `shouldFallback` blocks |
| 8 | QualityMonitor watches stream state for `error` | Replaces the old `maxUnstableReconnects` → `HandleDegraded` path |
| 9 | `quality_fallback` implies keep-alive | Skip idle disconnect if `quality_fallback` is on |
| 10 | `quality_fallback` implies auto-probe | On enable, if `auto_probe` is off, call `fallbackMgr.Enable()` |

**Verification:** With only `auto_probe` on and `quality_fallback` off, confirm that reconnect failures do NOT trigger automatic switching (just retry forever or enter error state). With `quality_fallback` on, confirm the monitor detects the error state and switches.

### Phase 3: Better probing

| # | Task | Notes |
|---|---|---|
| 11 | Increase probe window to 30s | Change `ProbeAnalysisWindow`, update `analyzeFrames` for longer windows |
| 12 | Parallelize probing (4 concurrent limit) | Launch probe goroutines with a limiter channel instead of sequential loop |
| 13 | Increase candidates to 10 (3 re-verify + 7 explore) | Top 3 suggestions always re-probed; remaining slots from discovery |
| 14 | Probe cooldown for low-scorers | Track per-source cooldown (3 cycles). Sources that didn't make top 3 are skipped in discovery for the next 30 min |
| 15 | Change probe interval to 10 min | Change `ProbeCycleInterval` |
| 16 | Truncate stored probe audio to first 3s | Only persist `ProbeStoredAudio` worth of PCM to DB |
| 17 | Normalize WF bins to zero-median before cosine similarity | Subtract median in `spectralSimilarity` |
| 18 | Create `internal/snr/` package | `FromWFFrame`, `FromWFFrames`, `BandConfig`, `Result` — reusable across scorer, monitor, and future API |
| 19 | Use `snr.FromWFFrames` in probe scoring | Primary metric, weight 0.35. Also use `Result.NoiseFloordB` for absolute noise floor metric (weight 0.15) |
| 20 | Add frame delivery consistency metric | Coefficient of variation of inter-frame intervals, weight 0.15 |
| 21 | Remove RMS similarity, demote comparative metrics | Silence agreement + spectral similarity to 0.10 each |
| 22 | Add slot availability factor | `1.0 - users/max_listeners`, weight 0.05 |
| 23 | Bracketing reference snapshots | `RecentSnapshot` from chunk ring, score against both, take max |
| 24 | Add `score_ema` to `fallback_suggestions` | DB migration, update on re-probe, sort by EMA for switching |
| 25 | Store `in_band_snr_db` per suggestion | Used by monitor for proactive switching comparison |
| 26 | Invalidate suggestions on tuning changes | Expand `OnStreamUpdated` to check freq/mode/bandwidth, call `Reprobe` |
| 27 | Favorites integration | Probe priority (not exemption), +0.10 score bonus, switching tiebreaker, 10-min blacklist |

**Verification:** Run probe cycles. Confirm parallel probing completes in ~90s for 10 candidates. Confirm probe rotation: low-scorers are skipped in subsequent cycles, more distant sources fill their slots. Confirm in-band SNR is high for candidates hearing a signal, low for noise. Confirm EMA smooths across cycles. Confirm tuning change wipes suggestions. Confirm favorited sources sort first in exploration slots and receive scoring bonus.

### Phase 4: In-band SNR monitoring + proactive switching

| # | Task | Notes |
|---|---|---|
| 27 | Add SNR sampling to QualityMonitor | Use `snr.FromWFFrame` on most recent WF frame every 10s |
| 28 | Baseline establishment | Collect 2 min of SNR samples, compute median |
| 29 | Degradation detection (`signal_degraded`) | Track sustained drops ≥ 15 dB below baseline for ≥ 60s |
| 30 | Proactive switching (`better_source_available`) | After each probe cycle, compare our SNR to top suggestion's SNR. If suggestion is ≥ 15 dB better for 2+ consecutive cycles, trigger |
| 31 | Cross-reference with probe suggestions on trigger | Only switch if a suggestion actually has better SNR |
| 32 | Reset baseline on tuning changes | Clear SNR history when freq/mode/bandwidth changes |

**Verification:** Connect to a source with a strong signal. Confirm baseline establishes. Simulate propagation loss (switch to a source with worse reception). Confirm `signal_degraded` triggers after 60s. Confirm `better_source_available` triggers after two probe cycles where a candidate has ≥ 15 dB advantage.

### Phase 5: Switching polish + anti-thrashing

| # | Task | Notes |
|---|---|---|
| 33 | Source blacklist (30-min expiry) | `map[string]time.Time` on QualityMonitor |
| 34 | Exclude blacklisted sources from `HandleDegraded` selection | Skip blacklisted suggestions |
| 35 | Exclude blacklisted sources from probe discovery | Filter in `DiscoverCandidates` |
| 36 | Escalating cooldown (60s → 5m → 15m) | Track switch timestamps, extend cooldown on rapid switches |
| 37 | Formalize switch logging (structured reason set) | Ensure every switch path produces the three log lines |
| 38 | Add `reason_detail` to `fallback_switch` WS event | Human-readable explanation |
| 39 | Post-switch re-probe trigger | Clear suggestions, start new probe cycle with new source as reference |

### Phase 6: Frontend

| # | Task | Notes |
|---|---|---|
| 40 | Display `reconnect_churn` as `S/CHURN` chip | Same pattern as `S/BUSY`, `S/SND`, `S/WF` in both stream player and streams list |
| 41 | Enable the `quality_fallback` toggle | Remove `disabled` prop from stream settings panel |
| 42 | Log panel entry for auto-switch | Prominent styling for `fallback_switch` events with reason detail |
| 43 | Show SNR per fallback suggestion | Display `in_band_snr_db` in the fallback suggestions panel |
| 44 | Stream live SNR to frontend | Add current in-band SNR to the WebSocket state broadcast, display in stream player |

---

## In-Band SNR Monitoring

This is the content-based quality signal. Rather than just watching for connection failures (stale data, churn, too_busy), we continuously measure whether the source is delivering a good signal at our specific frequency. This catches the case where the connection is technically fine but propagation has shifted and we're just hearing noise.

### How it works

We're already receiving waterfall frames on the live stream — the WF pump delivers them continuously. Each frame contains spectral bin values across the full KiwiSDR bandwidth. We can compute in-band SNR from this data with zero additional connections or data collection.

Every 10 seconds, the QualityMonitor samples the most recent WF frame and computes:

1. **In-band power:** Mean bin value within the stream's passband (`bandwidth_low_hz` to `bandwidth_high_hz`).
2. **Out-of-band noise floor:** Mean bin value in a reference region 2–5 kHz outside the passband edges. This region is close enough to share similar receiver characteristics but far enough that it shouldn't contain signal energy from the tuned frequency.
3. **In-band SNR:** `in_band_power − noise_floor`, in dB.

### Baseline establishment

When the stream first connects (or after a tuning change), the monitor collects 2 minutes of SNR samples to establish a baseline. The baseline is the median SNR over that window. This accounts for the normal range of the frequency — a quiet HF band might baseline at 5 dB SNR, a strong broadcast at 30 dB.

### Degradation detection

After the baseline is established, the monitor watches for sustained drops:

- **SNR drops ≥ 15 dB below baseline for ≥ 60 seconds** → `signal_degraded`

The 15 dB threshold is large enough that normal fading (5–10 dB swings) doesn't trigger it. The 60-second sustained period filters out brief dips. This catches the real scenario: propagation changed, the signal that was there is gone, and we're now listening to noise.

When `signal_degraded` triggers, the monitor checks the top probe suggestion's last known in-band SNR. If the suggestion has meaningfully better SNR (≥ 10 dB higher), that's strong evidence that the signal is still out there and another source can hear it. If the suggestion's SNR is also low, the broadcast probably went off the air — switching won't help, and the monitor skips the switch and logs `signal_degraded but no better source available`.

### What this is NOT

This is not a full audio quality analyzer. We're not running FFTs on the audio stream, detecting clipping, measuring decode quality, or analyzing modulation integrity. Those are interesting future ideas but require DSP expertise and careful threshold tuning. In-band SNR from existing waterfall data is simple, cheap, and addresses the most common real-world degradation mode: propagation loss.

### Why not use the KiwiSDR's reported SNR?

The KiwiSDR's `SNRDBM` value from its `/status` endpoint is a global measurement across its entire receive bandwidth. A KiwiSDR might report 25 dB SNR because of a strong broadcast at 9 MHz while our stream at 14 MHz is hearing nothing. The in-band SNR computed from WF bins is specific to the exact frequency and bandwidth we care about.

---

## Edge Cases

1. **`quality_fallback` on, no probe suggestions available.** The monitor fires `HandleDegraded`, but `HandleDegraded` finds no suggestions. It logs a warning and the monitor backs off to 5-minute cooldown. The stream stays on the current (bad) source. This is the correct behavior — switching to nothing is worse than a bad source.

2. **`quality_fallback` on, `auto_probe` manually turned off.** The system still calls `fallbackMgr.Enable()` as a side effect. If the user explicitly disables `auto_probe` while `quality_fallback` is on, the probe session is disabled but existing suggestions are preserved. The monitor can still switch using stale suggestions, but won't get new ones. This is an unusual configuration and the user is explicitly opting into it.

3. **Source switch during chunk offload.** Chunks are self-describing (each carries its `SourceID`). The chunk that spans the switch moment has data from two sources. This is already handled — the chunk records the source_id at rotation time. The switch boundary is visible in the event log within the chunk.

4. **Cascading failures (A→B→C loop).** Source A is bad → switch to B, blacklist A for 30 min → B is also bad → switch to C, blacklist B → all suggestions are blacklisted → monitor logs "no viable suggestions, all recently abandoned" and enters 15-minute cooldown. The blacklist prevents cycling back to A. The escalating cooldown prevents burning through sources in seconds. The log clearly shows what happened and why.

5. **Reconnect churn on a source that eventually stabilizes.** A source might kick us 3 times in 2 minutes then hold steady for an hour. The `reconnect_churn` flag is set when the pattern is detected, but if the rolling window clears (no more short-lived connections in the last 5 min), the flag is unset. If the monitor hasn't triggered yet (or is in cooldown), the churn resolves naturally.

6. **Multiple streams on the same source.** Each stream has its own QualityMonitor. If source X is bad, multiple streams connected to it will each independently detect degradation and switch. They might switch to different fallback sources (each has its own probe results). This is correct — each stream has its own frequency/bandwidth and the best alternative may differ.

7. **User changes frequency while `quality_fallback` is on.** All probe suggestions are invalidated (wiped), the in-band SNR baseline is reset, and a fresh probe cycle starts. The monitor continues running but with a clean slate. There's a 2-minute window after the tuning change where the SNR baseline is being re-established and `signal_degraded` cannot trigger.

8. **`signal_degraded` fires but the broadcast just went off the air.** The monitor checks the top probe suggestion's last known in-band SNR. If the suggestion also has low SNR, the broadcast is probably gone — not a propagation issue. The monitor logs `signal_degraded but no better source available` and does not switch. It re-checks on the next probe cycle in case a distant source still has propagation.
