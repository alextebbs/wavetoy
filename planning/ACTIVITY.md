# Chunk Activity Detection: Flagging Broadcasts vs. Noise

## The Idea

When monitoring mode is on (`offload_chunks = true`), every 1-minute chunk gets uploaded to S3 regardless of whether it contains anything interesting. Most shortwave monitoring sessions are dominated by noise — a broadcast might occupy 20% of the day, and the rest is empty band. Every chunk costs the same to store and retrieve, but 80% of them are dead air.

Before offloading a chunk, compute an in-band SNR reading from the waterfall frames it contains. Store that reading alongside the chunk in the `offloaded_chunks` manifest. This gives every chunk a single number that answers: "was something disturbing the noise floor during this minute?"

This isn't voice activity detection. The signals we care about include voice, Morse, RTTY, digital modes, number stations, over-the-horizon radar — anything that raises the in-band energy above the noise floor. SNR captures all of these. A chunk with 3 dB SNR is noise. A chunk with 18 dB SNR has something in it. The flag doesn't say *what* — just that something was there.

---

## What We Already Have

### SNR computation (`internal/snr/`)

`snr.FromWFFrame` and `snr.FromWFFrames` compute in-band SNR from waterfall frame data. They take a `BandConfig` (center frequency + passband edges) and WF frame bins, identify the in-band and out-of-band regions, and return a `Result` with `InBandSNRdB`, `SignalPowerdB`, and `NoiseFloordB`.

This is already used in:
- **Probe scoring**: `snr.FromWFFrames` on a 30-second probe window
- **Quality monitor**: `snr.FromWFFrame` every 10s on the live stream

### Chunk waterfall frames

Each `Chunk` stores `[]WFFrame`, where each frame carries `Bins`, `XBin`, `Zoom`, `FreqKHz`, `PassbandLo`, and `PassbandHi`. A typical 1-minute chunk at standard frame rates has ~60 WF frames. The tuning state (frequency and passband) is recorded per-frame, so we know exactly what was being listened to at each moment.

### S3Sink and offloaded_chunks

`S3Sink.OnChunkComplete` serializes audio, waterfall, and events to S3, then writes a manifest row to `offloaded_chunks` with metadata like `size_bytes`, `wf_frames`, `events`, `stream_state`, and `health_flags`. This is where the activity flag would be recorded.

### Quality monitor SNR baseline

The `quality.Monitor` already maintains a rolling SNR baseline for degradation detection. But this is per-stream, in-memory, and serves a different purpose (detecting when *your* source got worse). The chunk activity flag is about whether there was a signal to begin with, for any chunk, stored persistently.

---

## Design

### Compute per-chunk SNR at rotation time

When a chunk completes and is handed to the S3Sink, compute the aggregate in-band SNR from its WF frames before uploading. This uses the existing `snr.FromWFFrames` function — we just need to build the `BandConfig` from the chunk's own frame metadata.

```go
func chunkSNR(chunk *chunkring.Chunk) (float64, bool) {
    if len(chunk.WFFrames) == 0 {
        return 0, false
    }

    f := chunk.WFFrames[0]
    band := snr.BandConfig{
        CenterKHz:    float64(f.FreqKHz),
        PassbandLoHz: int(f.PassbandLo),
        PassbandHiHz: int(f.PassbandHi),
    }

    frames := make([]snr.WFFrameData, 0, len(chunk.WFFrames))
    for _, wf := range chunk.WFFrames {
        frames = append(frames, snr.WFFrameData{
            Bins:         wf.Bins,
            XBin:         wf.XBin,
            Zoom:         wf.Zoom,
        })
    }

    result, err := snr.FromWFFrames(frames, band)
    if err != nil {
        return 0, false
    }

    return result.InBandSNRdB, true
}
```

The computation happens synchronously in the sink worker goroutine, before the S3 upload. It's cheap — averaging ~60 byte arrays and doing arithmetic. The WF frames are already in memory as part of the completed chunk.

### Store SNR on the offloaded_chunks row

Add `in_band_snr_db` to the `offloaded_chunks` table:

```sql
ALTER TABLE offloaded_chunks ADD COLUMN in_band_snr_db DOUBLE PRECISION;
```

Nullable — chunks offloaded before this feature, or chunks where the SNR couldn't be computed (no WF frames, passband outside view), get `NULL`.

Update `InsertOffloadedChunk` to accept and store the value:

```go
type InsertOffloadedChunkParams struct {
    // ... existing fields ...
    InBandSNRdB *float64   // nil if computation failed
}
```

### Derive the activity flag from the SNR value

Rather than storing a separate boolean, the activity flag is derived from the SNR value at query time. This avoids baking in a threshold that we might want to change later.

```sql
-- Chunks with signal activity (threshold: 6 dB above noise floor)
SELECT * FROM offloaded_chunks
WHERE in_band_snr_db IS NOT NULL AND in_band_snr_db >= 6.0;

-- Chunks that are just noise
SELECT * FROM offloaded_chunks
WHERE in_band_snr_db IS NULL OR in_band_snr_db < 6.0;
```

6 dB is a reasonable starting threshold — it means the in-band signal power is ~4× the noise floor power. Strong broadcasts are typically 15–30 dB. Weak but intelligible signals are 8–12 dB. Below 6 dB is usually noise or extremely faint signal that wouldn't be useful to review. We can tune this on the frontend without schema changes.

### Why SNR and not VAD?

Voice Activity Detection (VAD) answers a narrower question: "is someone talking?" But shortwave monitoring captures much more than voice:

- **CW/Morse code**: Carrier on/off keying. No voice at all.
- **Digital modes** (RTTY, FT8, SSTV): Tonal or modulated data bursts.
- **Number stations**: Often synthesized voice or tonal patterns.
- **Utility stations**: STANAG, ALE link establishment, OTH radar sweeps.
- **Broadcast intermissions**: Carrier present with music or silence between segments.

All of these disturb the noise floor. SNR catches them all with a single metric. A VAD-based approach would miss everything except voice, which is a subset of what we care about.

Additionally, the SNR computation is essentially free — we already have the waterfall data and the `snr` package. A proper VAD would require decoding the audio, running an inference model or energy-based detector, and handling the various audio sample rates across KiwiSDR configurations. It's a lot of machinery for a narrower answer.

---

## The Edge Case: Passband Outside the Waterfall View

### The problem

The KiwiSDR has independent tuning for the audio/passband and the waterfall view. A user can be listening to 7200 kHz with a ±5 kHz passband while viewing 14000–14350 kHz on the waterfall (to watch a different band visually). In this configuration, the waterfall frames don't contain bins for the listen frequency — the `snr.FromWFFrame` call will return `ErrPassbandOutside`.

This is a real usage pattern. Some users set up the waterfall to watch a band of interest while listening to a different frequency. The two views are independent in the KiwiSDR protocol.

### How often does this happen?

Rarely, in practice. Most users keep the waterfall centered on their listen frequency — it's the natural default and the UI encourages it. The split-view pattern is an advanced use case. But when it happens, we can't compute in-band SNR and the chunk gets `NULL` for its activity reading. That's not the end of the world, but if someone enables monitoring mode they probably want the activity flag to work.

### The fix: validate on monitoring mode enable

When `offload_chunks` is set to `true`, check whether the current passband falls within the current waterfall view. If it doesn't, we have two options:

**Option A: Auto-adjust the waterfall view.** Snap the WF view to include the passband. This is what we'd do for `view_locked` streams already — the view follows the tuning. The user can always re-adjust the view afterward, though it'll need to keep covering the passband while monitoring is on.

**Option B: Reject with an error.** Return an API error: "Monitoring mode requires the listen frequency to be within the waterfall view. Adjust your waterfall view or listen frequency." The user adjusts, tries again. Clear and explicit.

**Recommendation: Option B with a soft constraint.** Don't silently move the waterfall view — that's surprising behavior. Instead:

1. On `offload_chunks` enable: validate that the passband is within the WF view. If not, return an error with a descriptive message.
2. While `offload_chunks` is on: if the user changes the WF view to exclude the passband, allow it but emit a warning event via WebSocket. The frontend shows a chip or toast: "Activity detection disabled — passband outside waterfall view." Chunks uploaded during this period get `NULL` for `in_band_snr_db`.
3. If the user changes the listen frequency while `offload_chunks` is on, the same validation applies — if the new frequency falls outside the current WF view, emit the warning.

This keeps the constraint visible without being blocking. Power users who intentionally split their view can do so — they just lose the activity flag until they re-align.

### Validation logic

```go
func passbandInView(stream models.Stream) bool {
    passLo := stream.FrequencyKHz + float64(stream.BandwidthLowHz)/1000.0
    passHi := stream.FrequencyKHz + float64(stream.BandwidthHighHz)/1000.0
    return passLo >= stream.WFViewStartKHz && passHi <= stream.WFViewEndKHz
}
```

This check goes in:
1. `UpdateStream` — when `offload_chunks` is being set to `true`
2. `OnStreamUpdated` — when tuning or WF view changes while `offload_chunks` is already on

---

## Data Flow

```
1. Chunk completes (rotation timer fires)
2. ChunkRing hands completed chunk to S3Sink via sinkCh
3. S3Sink.OnChunkComplete:
   a. Compute in-band SNR from chunk's WF frames (chunkSNR)
   b. Serialize audio → S3
   c. Serialize WF → S3
   d. Serialize events → S3
   e. INSERT into offloaded_chunks with in_band_snr_db
4. Frontend can query/filter offloaded chunks by activity
```

Step 3a is the only new work. It happens before the uploads because we want the SNR value for the manifest row. If the computation fails (no WF frames, passband outside view), `in_band_snr_db` is `NULL` and everything else proceeds normally.

---

## API Changes

### `GET /streams/{id}/rewind/chunks` (existing)

The existing chunk listing endpoint returns `ChunkMeta` for each offloaded chunk. Add `in_band_snr_db` to the response:

```json
{
    "started_at": "2026-03-22T14:00:00Z",
    "ended_at": "2026-03-22T14:01:00Z",
    "wf_frames": 62,
    "events": 3,
    "in_band_snr_db": 18.4,
    "has_activity": true
}
```

`has_activity` is derived server-side using the threshold (default 6 dB). This keeps the threshold decision in one place rather than duplicating it in the frontend.

### Future: Activity timeline

Once chunks have activity flags, a natural next step is a timeline view showing when broadcasts were active across hours or days. This is a frontend concern — the API already returns the data. A simple visualization: a horizontal bar where each minute is colored green (activity) or gray (noise), with the SNR value available on hover. This isn't part of this plan but the data model supports it.

---

## Schema Change

Single migration, additive:

```sql
ALTER TABLE offloaded_chunks ADD COLUMN in_band_snr_db DOUBLE PRECISION;
```

Since we consolidated all migrations into `001_initial`, this goes directly into the initial schema:

```sql
CREATE TABLE offloaded_chunks (
  stream_id    TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ NOT NULL,
  size_bytes   INT NOT NULL,
  wf_frames    INT NOT NULL DEFAULT 0,
  events       INT NOT NULL DEFAULT 0,
  audio_bytes  INT NOT NULL DEFAULT 0,
  stream_state SMALLINT NOT NULL DEFAULT 0,
  health_flags SMALLINT NOT NULL DEFAULT 0,
  in_band_snr_db DOUBLE PRECISION,
  PRIMARY KEY (stream_id, started_at)
);
```

---

## Implementation Order

### Phase 1: Core — compute and store SNR per chunk

| # | Task | Notes |
|---|------|-------|
| 1 | Add `in_band_snr_db` column to `offloaded_chunks` | Add to `001_initial.up.sql` (or new migration if already deployed) |
| 2 | Update `InsertOffloadedChunkParams` to include `InBandSNRdB *float64` | In `internal/db/` |
| 3 | Write `chunkSNR` helper | In `internal/chunkring/`, uses `snr.FromWFFrames` with band config from the chunk's first WF frame |
| 4 | Call `chunkSNR` in `S3Sink.OnChunkComplete`, pass result to `InsertOffloadedChunk` | Before uploads. `nil` on failure, value on success |
| 5 | Update `InsertOffloadedChunk` SQL to include `in_band_snr_db` | Simple column addition |

**Verification:** Enable monitoring mode on a stream tuned to a frequency with a known broadcast. Confirm `offloaded_chunks` rows have non-null `in_band_snr_db`. Confirm the values correlate with audible signal presence. Tune to an empty frequency, confirm SNR values are low (~0–5 dB).

### Phase 2: Passband validation

| # | Task | Notes |
|---|------|-------|
| 6 | Add `passbandInView` validation helper | Simple frequency range check |
| 7 | Validate on `offload_chunks` enable | Return error if passband is outside WF view |
| 8 | Warn on tuning/view change while offloading | Emit WebSocket event when passband drifts outside view. Chunks get `NULL` SNR |

**Verification:** Try enabling monitoring mode with the WF view set to a different band than the listen frequency. Confirm the API rejects it. Enable monitoring mode normally, then pan the WF view away. Confirm the warning event fires and subsequent chunks have `NULL` SNR.

### Phase 3: API and frontend

| # | Task | Notes |
|---|------|-------|
| 9 | Add `in_band_snr_db` and `has_activity` to chunk listing response | Derive `has_activity` from threshold |
| 10 | Display activity indicator on chunk timeline (minimap) | Color coding: green = activity, gray = noise |
| 11 | Add filter: "show only chunks with activity" in rewind UI | Filter on `has_activity` |

---

## Threshold Tuning

The 6 dB starting threshold is a guess. After collecting real data across different bands and times of day, we might find that:

- **Strong broadcast bands** (e.g. 49m, 31m) have a higher ambient SNR even when "quiet" because of adjacent-channel splatter. The threshold might need to be 8–10 dB.
- **Quiet utility bands** (e.g. 8 MHz aero) have very clean noise floors, and 4 dB above noise is a real signal.

For now, a single global threshold is fine. If it turns out that different bands need different thresholds, the SNR value is stored raw — we can re-derive the activity flag at any time by changing the threshold in the query or adding a per-stream threshold setting.

---

## Cost of Doing Nothing

Without activity detection, a user monitoring a frequency 24/7 stores 1,440 chunks per day. If the frequency is only active for 4 hours, 1,120 of those chunks are pure noise. That's:

- **Storage**: ~1,120 × (audio + WF + events) ≈ 1,120 × ~800 KB ≈ 870 MB/day of useless data
- **Review time**: A user scrubbing through 24 hours of recordings has to listen/scan through 20 hours of nothing to find 4 hours of content

The activity flag doesn't reduce storage (we still upload everything — selective upload is a future optimization). But it makes the recorded data *searchable*. "Show me the chunks where something was happening" turns a 24-hour haystack into a 4-hour playlist.
