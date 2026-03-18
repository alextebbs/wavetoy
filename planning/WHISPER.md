# Voice Interpreter — Whisper Integration Plan

## Overview

Add a **Voice** interpreter type that uses [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
to transcribe and translate spoken audio on AM/SSB/FM streams. The user enables
it like any other interpreter — toggle it on, and translated or transcribed text
appears in the output panel.

Whisper's built-in `translate` task handles both transcription and translation in
a single inference pass. If the source language is English, the output is a
transcription. If it's another language, the output is an English translation. No
separate toggle is needed — one button does both.

This is the heaviest interpreter (the only one requiring an ML model) and the
most impactful for usability. Shortwave broadcasts, foreign-language ham QSOs,
and utility stations become accessible to anyone.

---

## How it fits into the existing interpreter framework

The voice interpreter implements the same `Interpreter` interface as Morse:

```go
type Interpreter interface {
    Feed(pcm []byte) []Output
    Reconfigure(cfg Config)
    Reset()
}
```

The stream manager calls `Feed()` on every audio frame — the **post-filter**
PCM16 LE at 12 kHz. This means the voice interpreter benefits from any upstream
filters the user has enabled (noise reduction, bandpass, etc.) without doing
anything special. The interpreter buffers frames internally, segments them into
fixed-length chunks, resamples, and submits to whisper.cpp. Decoded text comes
back as `Output` structs, which the stream manager pushes to clients via the
existing `interpreter_output` WebSocket event.

No changes to the stream manager, WebSocket plumbing, or broadcast logic are
needed. The voice interpreter is just another `Interpreter` implementation.

---

## Architecture

```
Filtered PCM16 frames (12 kHz, post-filter-chain)
  │
  ▼
┌─────────────────────────────┐
│  Voice Interpreter          │
│                             │
│  ┌───────────────────────┐  │
│  │ Fixed-window buffer   │  │
│  │ accumulates N seconds │  │
│  └──────────┬────────────┘  │
│             │ chunk full    │
│             ▼               │
│  ┌───────────────────────┐  │
│  │ (optional) VAD gate   │  │  ← on by default, toggle via global var
│  └──────────┬────────────┘  │
│             │               │
│             ▼               │
│  ┌───────────────────────┐  │
│  │ Resample 12 → 16 kHz │  │
│  │ (linear interp)       │  │
│  └──────────┬────────────┘  │
│             │               │
│             ▼               │
│  ┌───────────────────────┐  │
│  │ whisper.cpp inference │  │
│  │ task = "translate"    │  │
│  │ model = tiny/base/sm  │  │
│  └──────────┬────────────┘  │
│             │               │
│             ▼               │
│  Output{Text, Lang, ...}   │
└─────────────────────────────┘
  │
  ▼
stream manager → WebSocket → clients
```

The interpreter receives **post-filter** audio. If the user has noise reduction,
bandpass, or other filters enabled, the interpreter sees the cleaned-up signal.
This is important — upstream filtering dramatically improves transcription
quality on noisy HF audio without the interpreter needing to do its own DSP.

### Key design decisions

1. **Inference runs in a separate goroutine.** `Feed()` never blocks on
   inference — it appends samples to a buffer and returns immediately. A
   background goroutine drains completed chunks and runs Whisper. This keeps
   the audio pump's frame budget untouched.

2. **One inference at a time per stream.** A mutex or single-goroutine-consumer
   ensures whisper.cpp calls are serialized. If chunks arrive faster than
   inference completes, they queue (bounded). This prevents memory blowup and
   keeps CPU usage predictable.

3. **Fixed-window chunking with VAD gate.** Audio is segmented into
   fixed-length chunks (e.g., 5–10 seconds). By default, a simple energy-based
   VAD skips chunks that are pure noise (saves CPU, reduces junk output). The
   VAD can be disabled via a global var (`EnableVAD = false`) to send all audio
   to Whisper unconditionally. Raw model output is passed through unfiltered
   either way.

4. **Model is loaded once, shared across streams.** If multiple streams have
   voice interpreters active, they share a single loaded model. Inference is
   serialized through a global worker pool (initially size 1). This bounds
   memory to one model copy regardless of concurrent streams.

---

## whisper.cpp integration

### Binding approach

Use whisper.cpp's C API directly via CGo. The official Go bindings
(`github.com/ggerganov/whisper.cpp/bindings/go`) exist but are tightly coupled
to the whisper.cpp repo structure and version. A thin custom CGo wrapper gives
more control over the build and avoids pulling in the entire repo as a
dependency.

#### Build strategy

```
internal/whisper/
  whisper.go          # Go API (load model, run inference)
  whisper_cgo.go      # CGo bridge (#cgo LDFLAGS, extern declarations)
  whisper.h           # vendored whisper.cpp header (single file)
  libwhisper.a        # pre-built static library (per-platform)
  BUILD.md            # instructions for rebuilding libwhisper.a
```

**Why vendor a static library instead of building from source?**

- whisper.cpp is ~15k lines of C/C++. Building it as part of `go build` via
  CGo is slow and fragile (needs cmake, C++ compiler, platform-specific flags).
- A pre-built `libwhisper.a` for each target (linux/amd64, darwin/arm64) keeps
  Go builds fast and reproducible.
- The library rarely changes — we pin to a specific whisper.cpp release and
  rebuild only when upgrading.

**Alternative: build tag to skip CGo.**
A `//go:build !whisper` build tag on the CGo files lets the project compile
without whisper support. The `New()` function returns nil for `type: "voice"`
when compiled without the tag, and the interpreter panel shows
"Voice interpreter not available on this build." This is important because:
- CI/tests don't need whisper.cpp to build.
- Development on machines without the library isn't blocked.
- The Dockerfile explicitly enables the `whisper` tag.

### C API surface used

Only a handful of whisper.cpp functions are needed:

```c
struct whisper_context * whisper_init_from_file(const char * path);
void                     whisper_free(struct whisper_context * ctx);

struct whisper_full_params whisper_full_default_params(enum whisper_sampling_strategy);

int whisper_full(
    struct whisper_context * ctx,
    struct whisper_full_params params,
    const float * samples,      // 16 kHz mono f32
    int n_samples
);

int         whisper_full_n_segments(struct whisper_context * ctx);
const char * whisper_full_get_segment_text(struct whisper_context * ctx, int i);
const char * whisper_full_lang(struct whisper_context * ctx);
```

The Go wrapper exposes:

```go
package whisper

type Context struct { /* holds *C.whisper_context */ }

type InferenceParams struct {
    Task       string  // "transcribe" or "translate"
    Language   string  // ISO 639-1 or "" for auto-detect
    Threads    int     // CPU threads for inference
    NoContext  bool    // don't use previous text as context
}

type Segment struct {
    Text  string
    Start time.Duration
    End   time.Duration
}

func LoadModel(path string) (*Context, error)
func (c *Context) Close()
func (c *Context) Infer(samples []float32, params InferenceParams) ([]Segment, string, error)
//                       returns: segments, detected language, error
```

---

## Model management

### Model files

| Model | File size | RAM | CPU speed (4-core) | Quality |
|-------|-----------|-----|--------------------|---------|
| tiny  | 75 MB     | ~400 MB | ~10× real-time | Usable for clear audio |
| base  | 142 MB    | ~500 MB | ~5× real-time  | Good default |
| small | 466 MB    | ~1 GB   | ~2× real-time  | Best translation quality |

"5× real-time" = 10 seconds of audio takes ~2 seconds to process.

### Model storage

Models ship with the deployment. They live in a directory (default:
`data/whisper-models/`) and are checked into the Docker image or placed there
during setup. The files are freely available from Hugging Face:

```
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{size}.bin
```

Download them once during dev setup or image build:

```bash
mkdir -p data/whisper-models
curl -L -o data/whisper-models/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

The Makefile or Dockerfile should include a target that fetches the model(s).
There is no runtime download, no progress UI, no management API for model
downloads. The model is expected to be on disk when the server starts.

### Model lifecycle

- The model is loaded into memory on first inference request, not at server
  startup. Loading takes 1-3 seconds depending on model size.
- A loaded model stays in memory for the lifetime of the process (no
  eviction). This is intentional — loading is expensive and the models fit
  comfortably in modern server RAM.
- Only one model is loaded at a time. If a stream requests a different model
  size than what's currently loaded, the old model is freed and the new one
  loaded. This is a rare operation (user changes model size in settings).

---

## Audio segmentation

### Default: fixed-window chunking

The interpreter accumulates audio into fixed-length chunks (configurable,
default 5 seconds). When a chunk is full, it's sent to inference. Simple,
predictable, no tuning required.

The chunk length is a latency/quality tradeoff:
- **Shorter (3-5s):** Lower latency, but Whisper has less context per chunk
  and may produce more fragmented output.
- **Longer (8-10s):** Better transcription quality (more context), but the
  user waits longer for text to appear.

5 seconds is a good starting point. Can be tuned based on real-world results.

### Optional: VAD gating

A VAD (Voice Activity Detection) is layered in front of the chunker to
skip inference on chunks that are pure noise. This is **on by default** —
controlled by a Go global var:

```go
// Set to true to enable VAD gating before Whisper inference.
// When off, all audio chunks are sent to Whisper regardless of content.
var EnableVAD = true
```

When VAD is on (default), chunks where the energy never exceeds the noise
floor are skipped (not sent to inference). This saves CPU on dead air but
risks missing quiet speech. Flip it off to send everything to Whisper and
get raw model output — including whatever it makes of noise.

VAD implementation details (for when we turn it on):

- Energy-based, not ML-based. Radio audio has no true silence (AGC keeps
  noise level up), so standard WebRTC/Silero VADs don't work well.
- Compare short-term frame energy against a running noise floor estimate.
- Threshold: ~10 dB above noise floor to consider a chunk "has speech."
- This is intentionally simple — a gate, not a segmenter. It doesn't try
  to find utterance boundaries, just answers "is there likely speech in
  this chunk?"

---

## Resampling

Whisper requires 16 kHz mono float32 audio. The stream delivers 12 kHz PCM16.

Resampling from 12 to 16 kHz is a 3:4 ratio. Use linear interpolation — it's
fast, simple, and the quality difference vs. sinc interpolation is irrelevant
for speech recognition on noisy HF audio.

```go
func resample12to16(in []int16) []float32 {
    ratio := 12000.0 / 16000.0 // 0.75
    outLen := int(float64(len(in)) / ratio)
    out := make([]float32, outLen)
    for i := range out {
        srcPos := float64(i) * ratio
        idx := int(srcPos)
        frac := float32(srcPos - float64(idx))
        if idx+1 < len(in) {
            out[i] = float32(in[idx])*(1-frac) + float32(in[idx+1])*frac
        } else {
            out[i] = float32(in[idx])
        }
    }
    // Normalize int16 → float32 [-1, 1]
    for i := range out {
        out[i] /= 32768.0
    }
    return out
}
```

---

## Inference pipeline

### Feed → buffer → chunk → infer → output

```go
type VoiceInterpreter struct {
    cfg        Config
    sampleRate int

    // Audio accumulation (fixed-window chunking)
    pcmBuf     []int16       // accumulates raw PCM from Feed()
    chunkSize  int           // samples per chunk (sampleRate * chunkSeconds)

    // Inference
    inferCh    chan audioChunk // bounded channel to inference goroutine
    cancel     context.CancelFunc
    outputFn   func(Output)

    // Shared model reference
    pool       *WorkerPool
}

type audioChunk struct {
    samples []float32   // 16 kHz f32, ready for whisper
}
```

**`Feed(pcm []byte) []Output`:**

1. Convert `pcm` (LE bytes) to `[]int16`.
2. Append to `pcmBuf`.
3. If `len(pcmBuf) >= chunkSize`:
   a. Extract the chunk.
   b. (If `EnableVAD` and chunk energy is below threshold, discard.)
   c. Resample 12→16 kHz.
   d. Send to `inferCh` (non-blocking, drop if full).
   e. Reset `pcmBuf`.
4. Return `nil` — text output comes asynchronously.

**Why `Feed()` returns nil:** Whisper inference takes 1-3 seconds. `Feed()` is
called in the audio pump's hot path and must return in microseconds. The actual
text output is delivered asynchronously via a callback registered on the
interpreter:

```go
type AsyncInterpreter interface {
    Interpreter
    SetOutputCallback(func(Output))
}
```

The stream manager detects this interface and wires up the callback to
`notifyInterpreterOutput`. This is a small extension to the existing framework:

```go
if async, ok := interp.(AsyncInterpreter); ok {
    async.SetOutputCallback(func(o Output) {
        m.notifyInterpreterOutput(streamID, o)
    })
}
// For sync interpreters (Morse), Feed() still returns outputs directly.
```

### Inference goroutine

Started in the interpreter's constructor, stopped on `Reset()`:

```go
func (v *VoiceInterpreter) runInference(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case chunk := <-v.inferCh:
            segments, lang, err := v.pool.Infer(chunk.samples, InferenceParams{
                Task:     "translate",
                Language: v.cfg.SourceLang,
                Threads:  runtime.NumCPU(),
            })
            if err != nil {
                continue
            }
            for _, seg := range segments {
                text := strings.TrimSpace(seg.Text)
                if text == "" {
                    continue
                }
                v.outputFn(Output{
                    Interpreter: "voice",
                    Text:        text + " ",
                    Language:    lang,
                })
            }
        }
    }
}
```

Raw model output is passed through to the client. No filtering, no
hallucination detection. If Whisper produces garbage on noise, the user sees
it — and can turn down VAD sensitivity or enable upstream filters to improve
input quality. Keeping the output raw makes it easier to evaluate what the
model is actually doing.

---

## Worker pool (shared model)

```go
package whisper

type WorkerPool struct {
    mu       sync.Mutex
    ctx      *Context       // loaded model (nil until first use)
    modelDir string
    size     string         // "tiny", "base", "small"
    loading  bool
}

func NewWorkerPool(modelDir string) *WorkerPool { ... }

func (wp *WorkerPool) Infer(samples []float32, params InferenceParams) ([]Segment, string, error) {
    wp.mu.Lock()
    defer wp.mu.Unlock()

    if wp.ctx == nil {
        // lazy load
        ctx, err := LoadModel(filepath.Join(wp.modelDir, "ggml-"+wp.size+".bin"))
        if err != nil {
            return nil, "", err
        }
        wp.ctx = ctx
    }

    return wp.ctx.Infer(samples, params)
}

func (wp *WorkerPool) SetModel(size string) {
    wp.mu.Lock()
    defer wp.mu.Unlock()
    if size == wp.size {
        return
    }
    if wp.ctx != nil {
        wp.ctx.Close()
        wp.ctx = nil
    }
    wp.size = size
}
```

The `WorkerPool` is created once at server startup (in `main.go`) and passed
to voice interpreters via a field on the interpreter `Config` or via a
package-level registration. The mutex serializes all inference calls across
all streams — only one inference runs at a time. This is intentional:

- whisper.cpp already uses all available CPU cores internally.
- Concurrent inferences would fight for CPU and both run slower.
- Serial execution gives predictable latency: each utterance waits at most
  one inference duration in the queue.

---

## Config changes

### `interpreter.Config` (Go)

```go
type Config struct {
    Type    string `json:"type,omitempty"`
    Enabled bool   `json:"enabled,omitempty"`

    // Morse-specific
    SidetoneHz int `json:"sidetone_hz,omitempty"`
    WPM        int `json:"wpm,omitempty"`

    // Voice-specific
    SourceLang string `json:"source_lang,omitempty"` // "" = auto-detect
    ModelSize  string `json:"model_size,omitempty"`  // "tiny", "base", "small"
}
```

### `InterpreterConfig` (TypeScript)

```typescript
export type InterpreterConfig = {
  type?: string;
  enabled?: boolean;
  sidetone_hz?: number;
  wpm?: number;
  source_lang?: string;
  model_size?: string;
};
```

### `Output` (Go)

```go
type Output struct {
    Interpreter string `json:"interpreter"`
    Text        string `json:"text,omitempty"`
    WPM         int    `json:"wpm,omitempty"`
    SidetoneHz  int    `json:"sidetone_hz,omitempty"`
    Clear       bool   `json:"clear,omitempty"`

    // Voice-specific
    Language    string `json:"language,omitempty"` // detected source language
}
```

### `InterpreterOutput` (TypeScript)

```typescript
export type InterpreterOutput = {
  interpreter: string;
  text?: string;
  wpm?: number;
  sidetone_hz?: number;
  clear?: boolean;
  language?: string;
};
```

---

## Frontend UI

### Interpreter panel changes

The `InterpreterPanel` component currently hardcodes Morse controls. It needs
to become type-aware: show different controls based on `config.type`.

```
┌──────────────────────────────────────┐
│  Interpreter Type  [Morse ▼]         │   ← type selector (new)
│  ─────────────────────────────       │
│  [ON/OFF toggle]                     │
│                                      │
│  ┌─ type === "morse" ─────────────┐  │
│  │  Sidetone: [====●=======] 700  │  │
│  │  WPM:      [●===========] Auto │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌─ type === "voice" ─────────────┐  │
│  │  Model: [base ▼]               │  │
│  │  Language: [Auto-detect ▼]     │  │
│  │                                │  │
│  │  Detected: Russian              │  │
│  └────────────────────────────────┘  │
│                                      │
│  ── Decoded ────────── [📋] [🗑] ──  │
│  │ CQ CQ CQ this is Romeo Alpha    │ │
│  │ calling any station...           │ │
│  │ █                                │ │
│  └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### Voice-specific controls

| Control | Type | Values | Notes |
|---------|------|--------|-------|
| Model size | Select | tiny / base / small | Determines accuracy vs speed tradeoff |
| Source language | Select | Auto-detect + list of common languages | ISO 639-1 codes. Auto is default. |

### Status indicators

- **Detected language:** Badge showing the language detected by Whisper
  (e.g., "Detected: Russian"). Updates per chunk.
- **Inference indicator:** Subtle pulsing dot while inference is in progress,
  so the user knows the system is working on a chunk.

### Output panel

Same scrollable monospace text area as Morse, but:
- Text color is white (not green) to differentiate from Morse.
- Detected language badge shown inline when the language changes.
- No WPM badge (irrelevant for voice).

---

## Performance budget

### Audio pump impact

`Feed()` does PCM conversion and buffer append. No FFT, no inference.

| Operation | Cost per frame | Notes |
|-----------|---------------|-------|
| PCM bytes → int16 | ~1 µs | memcpy + endian conversion |
| Buffer append | ~1 µs | slice copy |
| **Total** | **~2 µs** | Well within the ~100 µs frame budget |

### Inference (background goroutine)

| Model | 5s utterance | 10s utterance | 30s utterance |
|-------|-------------|---------------|---------------|
| tiny  | ~0.5s | ~1.0s | ~3.0s |
| base  | ~1.0s | ~2.0s | ~6.0s |
| small | ~2.5s | ~5.0s | ~15.0s |

These are wall-clock times on a 4-core CPU. The inference goroutine is fully
independent of the audio pump — it can take as long as it needs without
affecting audio playback or other interpreters.

### Memory

| Model | Model in RAM | Per-stream buffers | Total |
|-------|-------------|-------------------|-------|
| tiny  | ~400 MB | ~2 MB | ~402 MB |
| base  | ~500 MB | ~2 MB | ~502 MB |
| small | ~1 GB | ~2 MB | ~1002 MB |

The model is shared. Per-stream overhead is just the PCM chunk buffer (~5s
of 12 kHz int16 ≈ 120 KB) plus the resampled chunk buffer.

---

## Prompt engineering

Whisper accepts an optional `initial_prompt` parameter that biases the decoder
toward specific vocabulary and formats. For radio audio:

```
"Amateur radio communication. Callsigns, phonetic alphabet, signal reports, Q-codes. Over."
```

This significantly improves recognition of:
- Callsigns (W1AW, VK3ABC, JA1XYZ)
- Phonetic alphabet (Alpha, Bravo, Charlie...)
- Signal reports ("five nine", "59")
- Q-codes (QTH, QSL, QRZ)
- Radio jargon ("roger", "copy", "over", "73")

The prompt should be configurable but default to the above for ham radio use.
For shortwave broadcast listening, a different default would be appropriate:

```
"International shortwave radio broadcast. News, commentary, music programs."
```

The interpreter could auto-select the prompt based on the stream's frequency
band (HF ham bands → ham prompt, broadcast bands → broadcast prompt), or
expose it as an advanced setting.

---

## Error handling and edge cases

### No speech / noisy audio

With VAD on (default), chunks that are pure noise are skipped — no inference
runs, no CPU used, no junk output. If the VAD is too aggressive and misses
quiet speech, flip `EnableVAD = false` to send all chunks to Whisper
unconditionally.

When a noise chunk does reach Whisper (either because VAD is off or the noise
was energetic enough to pass the gate), the raw model output goes to the
client. If the output is useless, the user can:
- Enable upstream filters (noise reduction, bandpass) to clean the signal.
- Retune to a stronger station.
- Turn the interpreter off.

### Model file missing

If the model file isn't on disk when the interpreter starts, inference fails
and the error is logged. The interpreter continues buffering and retries on
each subsequent chunk (the `WorkerPool.Infer` call returns an error, which
is logged and skipped). The user sees no output until the model file is
placed in the expected directory and the model loads successfully.

### Interpreter switched while inferring

If the user switches from voice to Morse (or disables the interpreter) while
an inference is in flight, the inference goroutine finishes its current work
but the output callback has been cleared — the result is silently discarded.
The `Reset()` method cancels the inference context and drains the channel.

### Multiple streams with voice active

All streams share the single `WorkerPool`. Inference is serialized. If
stream A and stream B both have active utterances:

1. Stream A's utterance is inferred first.
2. Stream B's utterance waits in the queue.
3. Stream B sees slightly higher latency (~2-4s extra for base model).

This is acceptable for typical usage (1-2 concurrent voice streams). If
it becomes a bottleneck, the pool can be expanded to 2 workers (requires
loading the model twice, doubling memory).

---

## File layout

```
data/
  whisper-models/
    ggml-base.bin          # Pre-downloaded model file (not checked into git)

internal/
  whisper/
    whisper.go             # Go API: LoadModel, Context, Infer
    whisper_cgo.go         # CGo bridge (//go:build whisper)
    whisper_stub.go        # No-op stub (//go:build !whisper)
    whisper.h              # Vendored whisper.cpp C header
    libwhisper.a           # Pre-built static library
    pool.go                # WorkerPool (shared model, serialized inference)

  interpreter/
    interpreter.go         # (modify) Add voice fields to Config, Output
    voice.go               # VoiceInterpreter implementation
    voice_test.go          # Tests with synthetic speech WAVs
    resample.go            # 12→16 kHz resampler
    resample_test.go

frontend/src/
  components/
    interpreter-panel.tsx  # (modify) Add type selector, voice controls
  lib/
    api.ts                 # (modify) Add voice fields to InterpreterConfig/Output
```

---

## Implementation phases

### Phase 1: Resampler + scaffolding + whisper.cpp integration

- [ ] Implement 12→16 kHz resampler in `internal/interpreter/resample.go`
- [ ] Round-trip test: resample and verify output sample count and range
- [ ] Add voice fields to `Config` and `Output` structs
- [ ] Add `AsyncInterpreter` interface and wire into stream manager
- [ ] Scaffold `VoiceInterpreter` with `Feed()` → fixed-window buffer → resample → infer
- [ ] Vendor whisper.cpp header and build static library for dev platform (darwin/arm64)
- [ ] Implement CGo bridge in `internal/whisper/whisper_cgo.go`
- [ ] Implement stub in `internal/whisper/whisper_stub.go` for builds without whisper
- [ ] `WorkerPool` with lazy model loading and serialized inference
- [ ] Download base model to `data/whisper-models/`, add Makefile target
- [ ] Wire `VoiceInterpreter` to `WorkerPool` for actual inference
- [ ] End-to-end test: WAV file → voice interpreter → text output

### Phase 2: Frontend + UX

- [ ] Add type selector dropdown to `InterpreterPanel` (Morse / Voice)
- [ ] Voice controls UI (model size, source language) — wired to config
- [ ] Detected language badge in output panel
- [ ] Inference-in-progress indicator (pulsing dot)
- [ ] Radio-specific Whisper prompt (ham vs broadcast, auto-select by band)

### Phase 3: Production readiness

- [ ] Build `libwhisper.a` for linux/amd64 (Docker/Fly.io)
- [ ] Dockerfile changes: install build deps, enable `whisper` build tag, bundle model
- [ ] Fly.io machine sizing validation (base model on performance-2x)
- [ ] Concurrent stream load testing (2-3 voice streams on one machine)
- [ ] Graceful degradation when inference queue is full (drop + log)

### Future: VAD optimization

- [ ] Implement energy-based VAD gate (behind `EnableVAD` global var)
- [ ] Skip inference on chunks with no energy above noise floor
- [ ] Tune threshold for radio audio characteristics

---

## Open questions

1. **Should the prompt be user-editable?** An advanced text field for the
   Whisper prompt would let power users tune recognition for specific use
   cases (aviation, maritime, specific languages). Risk: confusing for
   casual users. Could be hidden behind an "Advanced" toggle.

2. **Sliding window for partial results?** Running Whisper on a sliding
   window (e.g., every 3 seconds, on the last 8 seconds of audio) gives
   faster perceived output — the user sees provisional text that gets
   refined. This doubles CPU usage and adds complexity (de-duplicating
   overlapping segments). Worth trying if latency feels too high after
   Phase 1.

3. **Non-English target languages?** Whisper only translates *to* English.
   Supporting Japanese→French would require a second translation step
   (pipe Whisper's English output through a translation API or local
   model). Defer unless there's demand — English covers the primary use
   case.

4. **GPU acceleration?** whisper.cpp supports Metal (macOS) and CUDA
   (Linux). Metal gives ~5-10× speedup on Mac dev machines. The CGo build
   could detect availability and enable it. Defer — CPU-only is fast
   enough for the base model.

5. **Optimal chunk length?** 5 seconds is a guess. Shorter chunks give
   lower latency but less context for Whisper. Longer chunks give better
   transcription but more delay. Need to experiment with real radio audio
   to find the sweet spot.
