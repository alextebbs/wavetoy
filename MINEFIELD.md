# Chunk Minefield Stress Test

A built-in stress test that serves 20 deliberately pathological chunks through the real
rewind API, exercising every edge case in the frontend's chunk parsing, waterfall rendering,
and audio playback pipeline.

## Quick Start

1. Start the dev server: `make dev`
2. Navigate to: `http://localhost:5173/streams/__minefield__`
3. Open the timeline (rewind button, top right)
4. Scroll back — you'll see ~21 minutes of fake history with a visible gap
5. Hit play and watch the frontend navigate the minefield
6. Scrub through the timeline to stress the scrub controller

No real KiwiSDR is needed. No database entry is created. The minefield handler
intercepts all requests for stream ID `__minefield__` and generates synthetic data on the fly.

## How It Works

The handler lives in `internal/api/minefield.go`. Guards at the top of the existing
`getStream`, `streamManifest`, and `streamRewindChunk*` handlers detect the special
stream ID and delegate to the minefield. A guard in the WebSocket subscribe path sends
a fake `connected` message so the frontend's prefill logic triggers normally.

All chunk audio/waterfall/events are generated in-memory using the standard
`chunkring.Serialize*` serialization path. The frontend uses the exact same
`RemoteChunkSource` → `chunk-parser` → renderer/player code paths it always does.

### Data Generation

- **Audio baseline**: 440 Hz sine wave, PCM16 mono, 12 kHz sample rate.
  `math.Sin(2*pi*440*t/12000)` scaled to int16 range.
- **Waterfall baseline**: Diagonal gradient — bin `i` gets value `(i + frameIndex) % 256`
  across 1024 bins at 8 fps. Produces a visible stripe pattern so rendering issues
  are immediately obvious.
- **Events**: One log event per chunk identifying the scenario by name.

### Timestamps

The minefield epoch is aligned to the start of the previous hour (`floor(now/3600)*3600 - 3600`).
Each chunk occupies a 60-second slot. The total timeline spans 21 slots (0–20), with slot 14
intentionally empty (the gap test). All chunks fall within the last 2 hours, so the frontend's
24-hour manifest request always includes them.

## Scenario Matrix

20 chunks spanning ~21 minutes of timeline. The scenarios are ordered to create a brutal
sequence — the frontend must gracefully handle transitions between all of these.

### 1. `baseline` (slot 0)

Normal 60-second chunk. 440 Hz sine wave, 480 WF frames, 1024 bins, zoom 5.
Everything is valid. This is the sanity check before the carnage begins.

**Tests**: Nothing specific — confirms the baseline renders and plays correctly.

### 2. `empty-audio` (slot 1)

Normal waterfall, but zero bytes of audio (WAV header only, no PCM data).

**Tests**: `HistoricalAudioPlayer.nextPlayableChunk()` must skip this chunk.
Waterfall should render normally even when there's no audio to accompany it.

**Frontend code paths**: `historical-audio-player.ts` skip logic, `chunk-parser.ts`
`parseWAVChunk` with buffer < 44 bytes.

### 3. `empty-wf` (slot 2)

Normal audio, but zero waterfall frames.

**Tests**: Audio plays normally. Waterfall should show a "missing" overlay
via `drawChunkMissingOverlay()` for this chunk's row span.

**Frontend code paths**: `waterfall-renderer-base.ts` missing overlay drawing.

### 4. `both-empty` (slot 3)

Zero audio AND zero waterfall frames. A complete void.

**Tests**: Playback skips this chunk entirely. Waterfall shows missing overlay.
No crash, no hang.

### 5. `huge-audio` (slot 4)

180 seconds of audio (3x the 60-second chunk duration) with normal waterfall.

**Tests**: Does the audio scheduler overlap with the next chunk? Does playback
duration tracking break when audio exceeds the chunk boundary? The
`HistoricalAudioPlayer` schedules `source.start(chunkEndTime)` — does the
oversized audio bleed into the next chunk's playback window?

### 6. `huge-wf` (slot 5)

Normal audio, but 1440 waterfall frames (3x the expected 480).

**Tests**: Waterfall tile height far exceeds expected. Tests rendering performance,
scrolling behavior, and chunk eviction logic (`EVICT_DISTANCE_ROWS`). Does the
oversized chunk blow up the canvas or cause OOM?

### 7. `short-audio` (slot 6)

Only 10 seconds of audio in a 60-second chunk. Normal waterfall (480 frames).

**Tests**: Audio ends early, creating a gap before the next chunk starts.
Does `HistoricalAudioPlayer` handle the premature end gracefully? Does row
tracking drift because `frameCount` doesn't match audio duration?

### 8. `short-wf` (slot 7)

Normal audio (60s), but only 80 WF frames (~10 seconds worth).

**Tests**: Waterfall ends early but audio keeps playing. Should show a
missing overlay for the unfilled portion. Does the playback head continue
scrolling past the last rendered WF row?

### 9. `wf-zoom-change` (slot 8)

Normal audio. First 240 WF frames at zoom=5, then 240 frames at zoom=8.

**Tests**: Mid-chunk zoom split. The `insertFramesAsChunkTiles()` logic must
create separate tiles for each zoom level. Does the frequency scale update
correctly? Do tiles stitch together without visual seams?

**Frontend code paths**: `waterfall-renderer-base.ts` tile splitting by zoom,
`coverageFromFrame()`.

### 10. `wf-512-bins` (slot 9)

Normal audio. All 480 WF frames have 512 bins instead of the expected 1024.

**Tests**: WebGL renderer's `normalizeRow` receives bins shorter than `numBins`.
The remaining bytes in the texture row are uninitialized. Canvas renderer uses
`Math.min(bins.length, this.numBins)` and fills the rest with black. Does either
crash or produce garbled output?

**Frontend code paths**: `waterfall-renderer-gl.ts` `normalizeRow`,
`waterfall-renderer.ts` `colorMapLine`.

### 11. `wf-mixed-bins` (slot 10)

Normal audio. Even-indexed frames have 1024 bins, odd-indexed frames have 512 bins.

**Tests**: Per-frame bin count variation within a single chunk. The renderer must
handle alternating row widths without corruption. More aggressive than `wf-512-bins`
because the inconsistency is per-frame, not per-chunk.

### 12. `wrong-sample-rate` (slot 11)

Audio PCM generated at 12 kHz, but the WAV header claims 44100 Hz. Normal waterfall.

**Tests**: `decodeAndResampleWav()` reads the WAV header and resamples based on
the declared rate. With 720,000 samples (60s at 12 kHz) but a header claiming
44100 Hz, the frontend thinks it's ~16.3 seconds of audio. It will resample to
AudioContext rate producing audio that plays too fast and pitched up. Does this
cause a crash, or just sound wrong?

**Frontend code paths**: `resample.ts` `decodeAndResampleWav`, `parseWAVChunk`.

### 13. `truncated-wav` (slot 12)

Only 20 bytes are served (a truncated RIFF header). Normal waterfall.
The manifest claims normal `audio_bytes` so the frontend attempts to play it.

**Tests**: `parseWAVChunk` checks `buffer.byteLength < 44` and returns empty PCM
with 12 kHz fallback. Does the player gracefully skip this chunk? No crash.

**Frontend code paths**: `chunk-parser.ts` `parseWAVChunk` early return.

### 14. `corrupt-wav` (slot 13)

Valid 44-byte WAV header, but the PCM data is random noise bytes from a
deterministic PRNG (seed 42). Odd byte count (1,440,001 bytes) to test alignment.

**Tests**: The resampler receives garbage data. Does it crash, or just produce
noise? The odd byte length tests `pcm[:len(pcm)&^1]` rounding in serialization
and `Int16Array` alignment in the parser.

### GAP (slot 14)

No chunk exists at slot 14. The manifest simply doesn't include it.

**Tests**: A 60-second hole in the timeline. Does `HistoricalAudioPlayer` jump
over the gap? Does the waterfall show the gap correctly? Does scrubbing across
the gap work?

### 15. `wf-timestamps-reversed` (slot 15)

Normal audio. All 480 WF frames are present but their timestamps are in
reverse chronological order.

**Tests**: Tile insertion with non-monotonic timestamps. Does the waterfall
render frames in visual order or timestamp order? Does scrubbing break when
frame timestamps don't match their position in the array?

### 16. `wf-zero-bins-frame` (slot 16)

Normal audio. The first 10 WF frames have `numBins=0` (empty bin arrays),
followed by 470 normal frames.

**Tests**: The parser must handle 0-length bin arrays. The renderer must not
crash on empty rows. Does `SerializeWF` write correct headers for 0-bin frames?
Does `parseWFChunk` parse them without getting stuck in an infinite loop?

### 17. `manifest-lies-audio` (slot 17)

Normal audio (60s) and normal waterfall, but the manifest reports `audio_bytes: 0`.

**Tests**: The frontend uses `audio_bytes` to decide if a chunk is playable.
With `audio_bytes=0`, `nextPlayableChunk()` will skip it — even though the
actual audio endpoint returns a full WAV. This tests whether the manifest
metadata is the sole gatekeeper, or if the player has fallback logic.

### 18. `manifest-lies-wf` (slot 18)

Normal audio and normal waterfall, but the manifest reports `wf_frames: 0`.

**Tests**: Does the frontend skip loading WF data when the manifest says there
are no frames? If so, the waterfall shows a missing overlay even though the data
is available. Tests whether the renderer trusts the manifest or probes the endpoint.

### 19. `source-change` (slot 19)

Normal audio and waterfall, but `source_id` is `"minefield-alt"` instead of
`"minefield"` (which all other chunks use).

**Tests**: Source ID transition handling. Does the waterfall show a source
boundary marker? Does the player handle the transition? Does any deduplication
or caching logic break when the source changes?

### 20. `baseline-end` (slot 20)

Another normal chunk. Identical to slot 0.

**Tests**: After surviving the gauntlet, does everything recover? Can the
frontend resume normal playback and rendering after 18 chunks of abuse?

## What to Look For

### Playback

- Does audio play continuously through normal chunks?
- Does the player skip unplayable chunks without hanging?
- Does the player handle the gap (slot 14) without crashing?
- Does scrubbing work across pathological chunks?
- Does the `huge-audio` chunk bleed into the next chunk's time slot?

### Waterfall

- Do missing overlays appear for chunks with no/short WF data?
- Does the zoom change (slot 8) create a clean visual split?
- Do short-bin frames (512 bins) render without visual corruption?
- Does the gap show as empty space in the waterfall?
- Do reversed timestamps cause visual artifacts?

### Console

- Watch for uncaught exceptions, OOM warnings, or WebGL errors.
- Check `streamLog` output for retry storms or error cascades.
- Look for "minefield chunk: <id>" in the events panel to confirm
  which scenario is currently active.

## Architecture

```
Frontend (unchanged)
  │
  ├─ RemoteChunkSource.fetchManifest()
  │   └─ GET /api/streams/__minefield__/manifest/{from}/{to}
  │       └─ minefieldManifest() → synthetic JSON
  │
  ├─ RemoteChunkSource.fetchAudio()
  │   └─ GET /api/streams/__minefield__/rewind/{ts}/audio
  │       └─ minefieldAudio() → SerializeAudioWAV (or truncated bytes)
  │
  ├─ RemoteChunkSource.fetchWF()
  │   └─ GET /api/streams/__minefield__/rewind/{ts}/wf
  │       └─ minefieldWF() → SerializeWF
  │
  └─ WebSocket subscribe("stream:__minefield__")
      └─ minefieldWSConnected() → fake "connected" message
```

## Files

| File | Change |
|------|--------|
| `internal/api/minefield.go` | New. Scenario table, chunk builders, all handlers. |
| `internal/api/stream_rewind.go` | 4 guards: early return for `__minefield__` in manifest + 3 rewind handlers. |
| `internal/api/streams_read.go` | 1 guard: early return for `__minefield__` in `getStream`. |
| `internal/api/global_ws.go` | 1 guard: sends fake `connected` for `stream:__minefield__` subscribe. |
| Frontend | No changes. |
