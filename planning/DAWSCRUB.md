# DAW Scrub Effect: Implementation Plan

## The Goal

When the user drags or scrolls the minimap timeline during historical audio playback,
they should hear the audio at the scrub position in real time — the same "tape scrub"
or "record scratch" sound you hear when scrubbing in Pro Tools, Logic, Ableton, etc.
Not silence. Not choppy micro-bursts. A continuous, natural, responsive scrub sound.

---

## Why This Is Hard

### 1. AudioBufferSourceNode is fire-and-forget

The Web Audio API's `AudioBufferSourceNode` is designed for one-shot playback. You call
`source.start(when, offset)` and it plays forward from that point. You cannot reposition
the playhead while it's playing. To "seek," you must `.stop()` the current node, create
a brand-new node, and `.start()` it at the new offset. Each node transition produces an
audible click (discontinuity in the waveform). At scrub rates (dozens of position changes
per second), this creates a horrible staccato of clicks.

### 2. The 250ms debounce hides the problem with silence

Our current approach calls `scrubPause()` on every scroll event (killing all audio sources)
and sets a 250ms debounce timer before calling `seek()`. This means the user hears:

```
[audio playing] → scroll starts → [silence for entire scrub] → scroll stops → [250ms silence] → [audio resumes]
```

This is correct behavior for "seek to new position," but it's the opposite of scrubbing.
Scrubbing means *hearing the audio at the position under your finger, continuously*.

### 3. Micro-sample bursts don't work

A naive approach is: on each scroll event, create a short AudioBufferSourceNode playing
~50ms of audio at the target position. This fails because:

- **Click artifacts**: Each tiny source node starts and stops abruptly, producing a click
  at the boundary. Even with fade-in/fade-out envelopes, you hear a machine-gun stutter.
- **Timing jitter**: Scroll events arrive at irregular intervals (8ms–50ms depending on
  input device and browser). The micro-samples either overlap (phasing artifacts) or leave
  gaps (silence pops).
- **Scheduling latency**: `AudioBufferSourceNode.start()` schedules against
  `audioCtx.currentTime`, which advances in hardware buffer increments (typically 128
  samples / 2.67ms at 48kHz). You can't start a source "right now" — there's always a
  quantum of latency, and it's not deterministic enough for gapless micro-sample chains.
- **GC pressure**: Creating and discarding dozens of AudioBufferSourceNodes per second
  triggers garbage collection pauses, which cause audible dropouts.

### 4. The audio data is chunked and remote

Historical audio lives in 1-minute WAV chunks on the backend. `decodeAudioData()` is async
and takes 5-50ms depending on chunk size. During a fast scrub, the user can cross chunk
boundaries faster than we can fetch and decode the adjacent chunk.

---

## How DAWs Actually Do It

DAWs don't use their "normal" playback engine for scrubbing. They use a dedicated
**varispeed / granular scrub engine** that has direct random access to the audio buffer
and a controllable read head.

There are two classic techniques:

### Varispeed Scrub (Tape Machine Style)

The read head moves through the audio buffer at a speed proportional to the user's
scroll velocity:

- Scroll slowly → audio plays slowly (pitch drops proportionally, like slowing a record)
- Scroll fast → audio plays fast (pitch rises)
- Scroll backward → audio plays backward
- Stop scrolling → silence (or a very short loop at the last position)

This is the classic "reel-to-reel" sound. It's the most physical and intuitive scrub
sound. It's also the simplest to implement because it's just reading samples at a
variable rate with interpolation.

### Granular Scrub (Pro Tools Style)

Short overlapping grains (20–80ms) of audio are played at the scrub position. Each
grain is windowed (Hann/Hamming) and overlap-added:

- Scroll slowly → grains repeat at the same position, creating a "stuttering" loop
- Scroll fast → grains are spread out across the buffer
- Grains always play at original pitch regardless of scrub speed

This sounds more "digital" and is better for dialogue/voice editing where pitch
preservation matters.

### What We Should Use

**Varispeed**. Our source material is radio audio at 12kHz — voice, CW, digital modes.
Varispeed is simpler, more responsive, and the pitch-shifting effect is actually
*desirable* because it gives the user an intuitive sense of speed and direction. It's
also the approach that requires the least DSP complexity in the worklet.

---

## Architecture

The core insight: **move the scrub playback path into an AudioWorklet that has direct
random access to a decoded audio buffer and a controllable read position.**

The AudioWorklet `process()` method runs on the audio render thread at exactly the
hardware sample rate (typically 48kHz), called every 128 samples (~2.67ms). This gives
us sample-accurate, jitter-free output — no gaps, no clicks, no GC pauses. We control
what comes out by controlling where we read from the buffer.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Main Thread                              │
│                                                                 │
│  Timeline scroll event                                          │
│       │                                                         │
│       ▼                                                         │
│  ScrubController                                                │
│   ├─ maps scrollOffset → buffer position (fractional sample)    │
│   ├─ computes velocity from scroll delta / dt                   │
│   ├─ posts { position, velocity, mode } to worklet              │
│   └─ manages chunk fetch/decode/cache for buffer window         │
│                                                                 │
│  ChunkBufferManager                                             │
│   ├─ maintains LRU cache of decoded Float32Arrays               │
│   ├─ pre-fetches chunks adjacent to current position            │
│   └─ transfers chunk data to worklet via postMessage            │
│                                                                 │
└───────────────────────┬─────────────────────────────────────────┘
                        │ port.postMessage
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Audio Render Thread                            │
│                                                                 │
│  ScrubWorkletProcessor                                          │
│   ├─ holds contiguous sample buffer (multiple chunks stitched)  │
│   ├─ maintains fractional read position                         │
│   ├─ mode: 'scrub' | 'play' | 'idle'                           │
│   │                                                             │
│   │  SCRUB MODE:                                                │
│   │   ├─ smoothly interpolate read position toward target       │
│   │   ├─ read samples at interpolated position (cubic interp)   │
│   │   ├─ apply soft envelope on direction/speed changes         │
│   │   └─ output 128 samples per process() call                  │
│   │                                                             │
│   │  PLAY MODE:                                                 │
│   │   ├─ advance read position by 1.0 per output sample         │
│   │   ├─ cubic interpolation for sub-sample accuracy            │
│   │   └─ crossfade from scrub position on mode transition       │
│   │                                                             │
│   │  IDLE MODE:                                                 │
│   │   └─ output silence                                         │
│   │                                                             │
│   └─ output → scrubGain → gainNode → destination                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## The Scrub AudioWorklet

### Processor Design

```js
class ScrubProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Audio buffer: contiguous decoded samples covering multiple chunks.
    // Stored as a single Float32Array. Main thread sends chunk data with
    // an offset into this buffer so we can stitch them together.
    this.buffer = null;           // Float32Array
    this.bufferLength = 0;
    this.bufferStartRow = 0;      // which waterfall row the buffer starts at
    this.samplesPerRow = 0;       // for row→sample mapping

    // Read state
    this.position = 0.0;          // fractional sample position in buffer
    this.targetPosition = 0.0;    // where the user is scrubbing to
    this.velocity = 0.0;          // samples per output sample (1.0 = normal speed)
    this.mode = 'idle';           // 'idle' | 'scrub' | 'play'

    // Smoothing
    this.positionSmooth = 0.0;    // low-pass filtered position for scrub
    this.prevSample = 0.0;        // for DC-blocking / click suppression
    this.envelope = 0.0;          // soft start/stop envelope [0..1]

    this.port.onmessage = (ev) => this.handleMessage(ev.data);
  }
}
```

### Message Protocol

Main thread → Worklet messages:

| Message | Fields | Purpose |
|---------|--------|---------|
| `load-buffer` | `{ type, samples: Float32Array, startRow, samplesPerRow, totalRows }` | Load/replace the audio buffer |
| `append-chunk` | `{ type, samples: Float32Array, offset }` | Append decoded chunk data at offset in buffer |
| `scrub` | `{ type, targetPosition: number, velocity: number }` | Update scrub target (position in samples) |
| `play` | `{ type, position: number }` | Switch to normal playback from position |
| `idle` | `{ type }` | Stop producing audio |

Position values are in **sample indices** within the buffer (fractional for sub-sample
accuracy). The main thread converts from waterfall rows using `samplesPerRow`.

### The process() Method — Scrub Mode

The heart of the scrub effect. On every `process()` call (128 samples at 48kHz):

```
for each output sample:
  1. Smoothly move this.position toward this.targetPosition
     - Use exponential smoothing: position += (target - position) * alpha
     - alpha controls "scrub feel":
       - Higher alpha (0.3–0.5) = tighter, more responsive
       - Lower alpha (0.05–0.1) = smoother, more "elastic" feel
     - This smoothing is what prevents clicks: the read head never jumps
       discontinuously; it always slides to the target

  2. Read a sample at this.position using cubic interpolation
     - Cubic (Hermite) interpolation between the 4 nearest integer samples
       gives much better quality than linear for varispeed playback
     - Handle buffer boundary: clamp or wrap

  3. Apply envelope
     - When scrub starts: ramp envelope from 0→1 over ~64 samples (~1.3ms)
     - When scrub stops (no position updates for ~100ms): ramp 1→0
     - Multiply output sample by envelope

  4. Write to output buffer
```

The exponential smoothing is the key trick. When the user scrolls, `targetPosition`
jumps in discrete steps, but `position` glides smoothly. The distance between position
and target divided by time is the effective playback speed. Large jumps (fast scroll) =
fast playback = high-pitched tape sound. Small jumps (slow scroll) = slow playback =
low-pitched sound. Natural, physical, intuitive.

### Cubic Hermite Interpolation

For reading samples at fractional positions:

```js
cubicInterp(buf, pos) {
  const i = Math.floor(pos);
  const f = pos - i;
  const s0 = buf[Math.max(0, i - 1)];
  const s1 = buf[i];
  const s2 = buf[Math.min(buf.length - 1, i + 1)];
  const s3 = buf[Math.min(buf.length - 1, i + 2)];

  // Hermite interpolation
  const c0 = s1;
  const c1 = 0.5 * (s2 - s0);
  const c2 = s0 - 2.5 * s1 + 2 * s2 - 0.5 * s3;
  const c3 = 0.5 * (s3 - s0) + 1.5 * (s1 - s2);
  return ((c3 * f + c2) * f + c1) * f + c0;
}
```

### Idle Timeout

The worklet tracks `samplesSinceLastUpdate`. If no `scrub` message arrives for
~4800 samples (100ms at 48kHz), it begins fading the envelope to zero. This creates the
natural "scrub stops → audio fades out" behavior. When a new `scrub` message arrives,
the envelope fades back in.

---

## Buffer Management (Main Thread)

### ChunkBufferCache

A class that manages decoded audio data and feeds it to the scrub worklet.

```
ChunkBufferCache
  ├─ decodedChunks: Map<string, Float32Array>   // startedAt → decoded samples
  ├─ currentWindow: Float32Array                 // stitched buffer sent to worklet
  ├─ windowStartRow: number                      // row offset of the window
  ├─ windowChunkRange: [startIdx, endIdx]        // which chunks are in the window
  └─ pendingFetches: Set<string>                 // in-flight chunk fetches
```

**Strategy**: Maintain a sliding window of 3 decoded chunks centered on the current
scrub position (~3 minutes of audio). When the scrub position moves within the window,
only send a `scrub` message (position update). When the position approaches a window
edge, fetch and decode the next chunk, stitch a new window, and send `load-buffer` or
`append-chunk` to the worklet.

**Why 3 chunks**: At 1 minute per chunk, a 3-chunk window gives ±1 minute of scrub
room on either side of the current position. Even at aggressive scroll speeds, this
provides enough runway for async fetch/decode of the next chunk before the user hits
the edge.

### Row-to-Sample Mapping

The scrub worklet operates in sample space, but the timeline operates in row space.
The main thread converts:

```
samplePosition = (targetRow - windowStartRow) * samplesPerRow

where:
  samplesPerRow = chunkBuffer.length / chunk.frameCount
  (derived from the decoded AudioBuffer's sample count and the chunk's frameCount)
```

This mapping is sent to the worklet in the `load-buffer` message so it can also do
row-based math if needed.

### Resampling Consideration

Backend chunks are 12kHz PCM16. `decodeAudioData()` upsamples to AudioContext rate
(48kHz) automatically. The scrub worklet operates at 48kHz. All position math should
be in 48kHz sample indices after decode.

---

## Integration with Existing Code

### New Gain Node in the Audio Graph

Add a `scrubGain` node alongside `liveGain` and `histGain`:

```
workletNode → liveGain ─┐
                         ├→ gainNode → destination
scrubWorklet → scrubGain ┘
histGain ────────────────┘
```

During scrub, `scrubGain.value = 1` and `histGain.value = 0`.
During normal historical playback, `scrubGain.value = 0` and `histGain.value = 1`.
Crossfade between them using `linearRampToValueAtTime` over ~50ms.

### Modified onScrollOffset Handler

Replace the current "scrubPause → debounce 250ms → seek" pattern:

```
onScrollOffset(offset):
  1. Set waterfall scroll position (unchanged)
  2. Compute targetRow from offset (unchanged)

  3. IF scrub worklet is not loaded for this region:
       - Fetch/decode chunks around targetRow
       - Load buffer into scrub worklet
       - Crossfade histGain → scrubGain

  4. Post { type: 'scrub', targetPosition, velocity } to scrub worklet
     (velocity computed from delta of targetRow / delta time since last event)

  5. Reset the idle timer (for "scroll stopped" detection)

  6. On idle timer expiry (250ms after last scroll):
     - Post { type: 'play', position: currentScrubPosition } to scrub worklet
       OR switch back to HistoricalAudioPlayer.seek(targetRow)
     - Crossfade scrubGain → histGain
```

### ScrubController Class

New class that encapsulates the scrub state machine:

```ts
class ScrubController {
  private workletNode: AudioWorkletNode;
  private bufferCache: ChunkBufferCache;
  private lastScrollTime: number;
  private lastRow: number;

  // Called on every scroll event during historical playback
  onScroll(targetRow: number, chunks: ChunkInfo[]): void;

  // Called when scrolling stops (idle timeout)
  onScrollEnd(): void;

  // Transition back to normal HistoricalAudioPlayer
  handoffToPlayer(player: HistoricalAudioPlayer, targetRow: number): void;
}
```

Owns the scrub worklet lifecycle, buffer cache, and the `scrubGain` crossfade.

---

## Handling Chunk Boundaries During Scrub

This is the trickiest part. When the user scrubs across a chunk boundary, we need
audio data from the next (or previous) chunk already loaded.

### Pre-fetch Strategy

```
Current position in chunk N:
  - If position > 70% of chunk N: pre-fetch chunk N+1
  - If position < 30% of chunk N: pre-fetch chunk N-1
  - Always keep chunk N decoded in memory
```

When the pre-fetched chunk arrives, stitch it onto the existing buffer and send an
`append-chunk` message to the worklet with the new samples and their offset.

### Buffer Stitching

The worklet maintains a single contiguous Float32Array. When chunks are appended:

```
Existing buffer: [--- chunk N-1 ---][--- chunk N ---]
Append chunk N+1:
New buffer:      [--- chunk N-1 ---][--- chunk N ---][--- chunk N+1 ---]
```

If this grows too large (>5 chunks), trim from the opposite end to keep memory bounded.

### Fallback: Position Clamping

If the user scrubs into a region where the chunk isn't loaded yet:
1. Clamp the position to the buffer boundary
2. Show a subtle loading indicator on the timeline
3. When the chunk arrives, extend the buffer and release the clamp

This should be rare with 3-chunk pre-fetching, but it's the safe fallback.

---

## Implementation Phases

### Phase 1: Scrub AudioWorklet

Create `scrub-processor.ts` — the AudioWorkletProcessor with:
- Float32Array buffer storage
- Fractional read position with cubic interpolation
- Exponential smoothing from target position
- Envelope for fade-in/fade-out
- Message handling for `load-buffer`, `scrub`, `play`, `idle`
- Idle timeout detection

Deliverable: A worklet that, given a pre-loaded buffer and position messages,
produces smooth varispeed scrub audio.

Test: Load a single decoded chunk into the worklet, send position updates from
`requestAnimationFrame`, confirm smooth scrub output through speakers.

### Phase 2: Buffer Management

Create `ChunkBufferCache` in `lib/chunk-buffer-cache.ts`:
- Decoded chunk LRU cache (Map of startedAt → Float32Array)
- Window stitching (combine multiple chunk Float32Arrays into one)
- Row-to-sample-position mapping
- Pre-fetch logic (fetch adjacent chunks when near boundaries)
- Integration with existing `ChunkSource` for fetching

Deliverable: A class that, given a target row and chunk manifest, maintains a
ready-to-use Float32Array window and handles async loading.

### Phase 3: ScrubController + Integration

Create `ScrubController` in `lib/scrub-controller.ts`:
- Owns the scrub AudioWorkletNode and `scrubGain` node
- Velocity computation from scroll events
- State machine: idle → scrubbing → settling → handoff
- Crossfade logic between scrub and historical playback
- Integration with `onScrollOffset` in stream-player-page

Wire into `stream-player-page.tsx`:
- Create scrub worklet and gain node in `ensureAudio()`
- Replace scrubPause/debounce pattern with ScrubController calls
- Handle transitions between scrub mode and normal playback
- Handle transitions between historical mode and live mode

### Phase 4: Polish

- Tune the smoothing alpha for optimal scrub feel (expose as a constant, iterate)
- Tune idle timeout duration
- Tune crossfade duration between scrub ↔ normal playback
- Add velocity scaling so very fast scrolls don't produce ear-piercing chipmunk audio
  (clamp effective speed to ~4x or apply a soft limiter curve)
- Handle edge case: scrubbing to the very beginning or end of the chunk ring
- Handle edge case: chunks with no audio data (`audioBytes === 0`)
- Test with different input devices (mouse wheel, trackpad, touch)
- Test with different browsers (Chrome, Firefox, Safari — Safari has AudioWorklet
  quirks worth testing)

---

## Smoothing Parameter Tuning Guide

The exponential smoothing alpha in the worklet's scrub mode is the single most
important parameter for "feel." Here's a reference:

| Alpha | Feel | Use Case |
|-------|------|----------|
| 0.02  | Very elastic, laggy | Sound design, ambient scrub |
| 0.05  | Smooth, musical | General-purpose DAW scrub |
| 0.10  | Responsive but smooth | **Recommended starting point** |
| 0.20  | Tight, immediate | Precision editing |
| 0.50  | Nearly instant | Feels glitchy at low scroll rates |

Alpha is applied per-sample in `process()`. At 48kHz with alpha=0.1, the read head
reaches 90% of a position jump in ~1100 samples (~23ms). This feels "instant" to the
user but is smooth enough to avoid discontinuities in the output waveform.

For very large jumps (user scrolls several chunks instantly), a secondary "jump
threshold" should kick in: if `|target - position| > jumpThreshold` samples, snap the
position directly (with a short envelope dip to mask the discontinuity) rather than
letting the smoothing create a long pitch-shifted sweep.

```
Jump threshold: ~48000 samples (1 second of audio)
On jump: envelope → 0 over 32 samples, snap position, envelope → 1 over 32 samples
```

---

## Velocity Calculation

Scroll velocity determines the perceived scrub speed. Compute it from consecutive
scroll events:

```ts
onScroll(targetRow: number) {
  const now = performance.now();
  const dt = now - this.lastScrollTime;
  const dRow = targetRow - this.lastRow;

  // Rows per millisecond → scale to a useful range
  const rawVelocity = dt > 0 ? dRow / dt : 0;

  // Exponential moving average for smoothness
  this.smoothVelocity = this.smoothVelocity * 0.7 + rawVelocity * 0.3;

  this.lastScrollTime = now;
  this.lastRow = targetRow;
}
```

The velocity is informational — it's sent to the worklet for potential use in grain
scheduling or speed clamping, but the primary scrub mechanism derives its effective
speed from the position smoothing itself. The distance between current and target
position, divided by the smoothing rate, *is* the playback speed. No explicit speed
calculation is needed in the worklet.

---

## Memory Budget

| Item | Size | Notes |
|------|------|-------|
| 1 decoded chunk (1 min @ 48kHz mono) | ~11.5 MB | `60 * 48000 * 4` bytes |
| 3-chunk scrub window | ~34.5 MB | Sent to worklet |
| LRU cache (5 chunks max) | ~57.5 MB | Main thread, for fast re-stitching |
| Total worst case | ~92 MB | Acceptable for a desktop web app |

The LRU cache prevents redundant fetch/decode when the user scrubs back and forth
across the same region. 5 chunks covers ±2 minutes of scrub history.

To reduce memory, we could:
- Use a 2-chunk window instead of 3 (still ~2 min of room)
- Evict cache entries more aggressively
- Store at 12kHz in the cache and resample in the worklet (saves 4x memory but adds
  complexity and CPU in the render thread — not recommended)

---

## Why This Approach Will Actually Work

1. **No AudioBufferSourceNode churn**: The worklet reads from a buffer directly.
   No node creation, no scheduling, no GC pressure.

2. **Sample-accurate, jitter-free output**: `process()` runs on the render thread
   at hardware-locked intervals. Every 128 samples, guaranteed.

3. **No clicks or pops**: Exponential smoothing means the read head never jumps
   discontinuously. The output waveform is always continuous.

4. **Low latency**: Position updates via `postMessage` to the worklet arrive within
   1-2 render quanta (~3-5ms). The smoothing covers the rest.

5. **Natural sound**: Varispeed scrub is physically intuitive — it sounds like
   speeding up or slowing down a record. No synthetic grain artifacts.

6. **Graceful degradation**: If a chunk isn't loaded, the position clamps and the
   user hears a brief fade-out/fade-in. No crash, no silence gap.

7. **Clean integration**: The scrub worklet sits alongside the existing live worklet
   and historical BufferSourceNode path. A gain crossfade switches between them.
   The existing code barely changes — we're adding a parallel path, not rewriting
   the playback engine.
