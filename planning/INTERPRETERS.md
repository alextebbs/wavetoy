# Interpreters

## Concept

An **Interpreter** is a real-time signal analysis module that decodes structured
information from a demodulated audio stream and presents it as human-readable
output (text, symbols, metadata) in the UI.

Interpreters are opt-in per stream — the user enables one from a control in the
stream player, selects the interpreter type, and decoded output appears in a
dedicated panel.

### Interpreter difficulty ranking

Ordered from easiest to hardest. "Hardest part" is the single biggest
implementation or integration challenge for each.

| Rank | Interpreter | Difficulty | Hardest part |
|------|-------------|------------|--------------|
| 1 | **Morse / CW** | Easy | Adaptive WPM detection — the decoder must infer dit length from noisy, variable-speed operators. A fixed-WPM decoder is trivial; one that auto-adapts reliably across different fists and SNR levels is the real work. |
| 2 | **RTTY** | Easy–Medium | Clock recovery — locking onto bit boundaries in a noisy FSK signal. The dual-Goertzel demod is simple, but if the bit-clock PLL drifts or never locks, you get garbage. Baudot shift-state tracking also causes subtle errors that are hard to debug. |
| 3 | **FT8 / FT4 / WSPR** | Medium | Integration, not DSP — the actual decoder (LDPC, Costas sync) is too complex to rewrite, so you wrap ft8_lib via CGo. The hard part is the CGo build/cross-compile story, precise 15-second time-windowed buffering aligned to NTP, and building a completely different UI (structured table, not text stream). |
| 4 | **SSTV** | Medium–Hard | Robust sync recovery — horizontal sync pulses are short (5–9 ms) and easily missed in noise, causing the image to slant or tear. Supporting multiple modes (Martin, Scottie, Robot, PD) multiplies the work because each has different line timing, color encoding, and sync patterns. Also a unique output type (progressive image) requiring different WebSocket payloads and UI. |
| 5 | **Voice** | Hard | Everything outside the model — whisper.cpp integration via CGo, model file management (download, storage, selection), VAD tuning for radio audio (which has no silence — just noise), and the fact that HF voice is 3 kHz bandwidth with heavy QRM/QRN that degrades accuracy. The model does the heavy lifting, but wiring it into a real-time streaming pipeline with acceptable latency is substantial. |

Morse code is the first target. The sections below detail how each interpreter
type would work technically.

---

## Interpreter designs

### 1. Morse / CW

See [Morse decoder design](#morse-decoder-design) below for the full pipeline.

**Summary:** Goertzel tone detection → binary envelope → timing classifier →
Morse tree lookup → text. Lightweight, pure Go, no external dependencies.

---

### 2. RTTY (Radioteletype)

RTTY encodes text as two alternating audio tones (mark and space) using FSK.
The standard amateur encoding is 45.45 baud Baudot with a 170 Hz shift.

#### Signal processing pipeline

```
PCM16 frames (12 kHz)
  │
  ▼
Bandpass filter (center on mark/space pair, ~200 Hz wide)
  │
  ▼
Dual Goertzel filters
  ├─ Mark  frequency (e.g., 2125 Hz)
  └─ Space frequency (e.g., 2295 Hz)
  │
  ▼
Magnitude comparison → binary bitstream (mark = 1, space = 0)
  │
  ▼
Clock recovery (PLL or oversampling + bit-center detection)
  │
  ▼
Baudot frame decoder
  ├─ 1 start bit (space)
  ├─ 5 data bits
  └─ 1.5 stop bits (mark)
  │
  ▼
Baudot → ASCII lookup (with LTRS/FIGS shift tracking)
  │
  ▼
Text buffer → pushed to clients via WebSocket
```

#### Key parameters (user-configurable)

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| Mark frequency | 2125 Hz | 1000–3000 Hz | Standard ham RTTY |
| Shift | 170 Hz | 23–850 Hz | Space = mark + shift |
| Baud rate | 45.45 | 45–300 | 45.45 is standard, 50 used in EU |
| Polarity | Normal | Normal / Reverse | Swap mark and space |
| Character set | Baudot (ITA2) | Baudot / ASCII | ASCII for 8-bit RTTY |
| Unshift on space | On | On / Off | Reset to LTRS after space character |

#### Implementation notes

- Dual-Goertzel is the standard approach for RTTY demodulation — two single-bin
  DFTs running in parallel, comparing magnitudes to decide mark vs space.
- Clock recovery is the tricky part. A simple approach: oversample the binary
  signal at 8× the baud rate, then use a phase-locked loop to track bit
  boundaries. A simpler fallback is to just sample at the center of each bit
  period using a free-running clock that resyncs on start-bit edges.
- Baudot uses two "shift" states (LTRS and FIGS). The decoder must track which
  shift is active to map 5-bit codes to the correct character. The "unshift on
  space" convention resets to LTRS after each space, which helps recover from
  shift errors.
- RTTY is often received in USB mode with the mark/space pair falling in the
  audio passband. The user tunes until the two tones align with the decoder's
  expected frequencies — the UI should show a tuning indicator
  (e.g., a crosshair scope showing mark/space balance).

#### UI additions beyond base interpreter controls

- Mark/space frequency inputs or a "standard presets" dropdown
- Tuning scope: a small XY or bar display showing mark vs space magnitude
  (classic RTTY tuning indicator)
- Baudot vs ASCII toggle

#### Effort estimate

Medium. The core DSP is similar to Morse (Goertzel filters), but clock recovery
and Baudot framing add complexity. ~2–3 days for a working decoder.

---

### 3. Voice (translation + transcription)

Real-time translation of spoken voice on AM/SSB audio. From the user's
perspective this is simple: turn it on and see English text for whatever language
is being spoken on the radio. Under the hood it's transcription + translation in
a single pass — Whisper does both natively.

This is the heaviest interpreter and the only one that requires an ML model.

#### What the user sees

The user tunes to a foreign-language broadcast or ham operator, enables the Voice
interpreter, and translated English text appears in the output panel in near
real-time. There is no separate "transcribe" vs "translate" toggle — it always
translates to the user's language. If the source audio is already in the target
language, the output is just a transcription.

#### How Whisper handles this

Whisper has a built-in `translate` task that transcribes any of its 99 supported
languages directly into English in a single inference pass — no separate
translation step or second model needed. When the source language matches the
target, it falls back to plain transcription automatically.

For non-English target languages, a lightweight post-translation step would be
needed (Whisper only translates *to* English). This could be deferred — English
output covers the primary use case.

#### Approaches

| Approach | Pros | Cons |
|----------|------|------|
| **Local Whisper (whisper.cpp)** | No API costs, no network dependency, private | Requires CPU/GPU on server, ~1 GB RAM for base model, adds C dependency via CGo |
| **Cloud STT (OpenAI Whisper API, Google STT, Deepgram)** | No local compute, high accuracy, easy language support | Per-minute cost, network latency, privacy concerns for some users |
| **Hybrid** | Use local for real-time streaming, cloud for high-accuracy "refine" pass | Complexity of two paths |

#### Recommended approach: local Whisper via whisper.cpp

For an SDR app, privacy and self-containment matter. Many users run these on
home servers and don't want audio leaving the network.

#### Signal processing pipeline

```
PCM16 frames (12 kHz)
  │
  ▼
Voice Activity Detection (VAD)
  ├─ Energy-based gate (simple) or WebRTC VAD / Silero VAD
  └─ Segments audio into utterances with start/end timestamps
  │
  ▼
Utterance buffer (accumulate ~3-10 seconds of speech)
  │
  ▼
Resample to 16 kHz (Whisper's native rate)
  │
  ▼
whisper.cpp inference (task = "translate")
  ├─ Model: tiny / base / small (configurable, trade accuracy vs speed)
  ├─ Source language: auto-detect or user-specified hint
  ├─ Always translates to English (transcribes if source is already English)
  └─ Returns: timestamped translated text segments
  │
  ▼
Translated text → pushed to clients via WebSocket
```

#### Key parameters (user-configurable)

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| Source language hint | Auto | Auto / list of ISO 639-1 codes | Hint improves accuracy; auto-detect costs ~1s extra per segment |
| Model size | base | tiny / base / small | Larger = more accurate, slower. Larger models are significantly better at translation. |
| VAD sensitivity | Medium | Low / Medium / High | Higher = more aggressive silence gating |
| Min utterance length | 2s | 1–10s | Don't transcribe very short bursts |

Note: there is no "translate on/off" toggle. Translation is always on. If the
source language is English, the output is a transcription — same result either
way. This keeps the UX to a single button.

#### No API key required

whisper.cpp is fully local and open-source. You download a model file once and
run inference on your own hardware. No API key, no network calls, no per-minute
billing. The model files are freely available from Hugging Face.

The optional cloud fallback (OpenAI Whisper API) *would* need an API key, but
the recommended path is entirely self-contained.

#### Performance and hosting requirements

whisper.cpp runs on **CPU only** — no GPU required. GPU (CUDA on Linux, Metal
on Mac) accelerates it but is not needed. Most SDR servers are CPU-only and
it works fine.

**Benchmarks** (CPU-only, no GPU, translating to English):

| Model | File size | RAM needed | 4-core CPU | 8-core CPU | Translation quality |
|-------|-----------|------------|------------|------------|---------------------|
| tiny | 75 MB | ~400 MB | ~10× real-time | ~15× | Usable for clear audio, poor on noise/accents |
| base | 142 MB | ~500 MB | ~5× real-time | ~8× | Good sweet spot |
| small | 466 MB | ~1 GB | ~2× real-time | ~4× | Best translation quality |

"5× real-time" = 10 seconds of audio takes ~2 seconds to process.

With VAD gating (only processing when someone is actually talking — radio audio
is mostly dead air or noise), the actual CPU duty cycle is much lower than
continuous processing. A typical ham QSO has ~30-50% talk time.

**Fly.io machine sizing:**

| Fly machine | vCPU | RAM | Can run | Notes |
|-------------|------|-----|---------|-------|
| `shared-cpu-2x` | 2 shared | 512 MB | tiny only | Tight on RAM, might struggle under load |
| `shared-cpu-4x` | 4 shared | 1 GB | tiny, base | Good for base model on 1-2 streams |
| `performance-2x` | 2 dedicated | 4 GB | tiny, base, small | Dedicated cores = consistent latency |
| `performance-4x` | 4 dedicated | 8 GB | all models comfortably | Recommended for production use |

The key constraint is **RAM** (the model must fit in memory) more than CPU.
A single stream with voice active is easy on any of these. The concern is
concurrent streams — if 5 streams all have voice translation active, they share
one model instance but queue for inference time. A `performance-4x` handles
~3-4 concurrent voice streams with the base model before latency becomes
noticeable.

**Scaling strategy:** If voice translation is popular, the interpreter could run
as a separate Fly machine (a dedicated "interpreter worker") that the main app
sends audio chunks to via internal networking. This isolates the CPU-heavy work
from the main stream-serving process. But this is an optimization — start with
in-process and see how it goes.

#### Implementation notes

- **whisper.cpp** has Go bindings (`github.com/ggerganov/whisper.cpp/bindings/go`).
  The binary ships with the model files.
- **Translation quality vs model size:** The tiny model can translate but makes
  frequent errors on complex sentences. The base model is a good sweet spot. The
  small model is noticeably better for translation accuracy, especially on
  languages distant from English (Chinese, Arabic, Japanese).
- **Streaming:** Whisper is not natively a streaming model — it works on fixed
  audio segments. The standard approach is to use VAD to detect utterances, buffer
  them, and run inference on each utterance as a batch. Latency is therefore
  utterance-length + inference-time (typically 1–3 seconds for base model on
  modern CPU).
- **Partial results:** To reduce perceived latency, the decoder could run Whisper
  on a sliding window, showing provisional text that gets refined as more audio
  arrives. This doubles compute but gives a much more responsive feel.
- **Radio-specific challenges:** HF voice audio is narrow-bandwidth (~3 kHz),
  noisy, and uses radio conventions (phonetic alphabet, callsigns, Q-codes).
  Whisper handles this surprisingly well out of the box, but a prompt like
  "Amateur radio HF voice communication" improves accuracy. Foreign-language
  shortwave broadcasts (e.g., Chinese, Russian, Arabic SW stations) are a strong
  use case — these are typically cleaner audio than ham QSOs and translate well.
- **Cloud fallback:** The config could include an optional API key field. If
  present, use the OpenAI Whisper API instead of local inference. This lets users
  on smaller machines offload the work. Costs ~$0.006/min.
- **Non-English target languages (future):** Whisper only translates *to* English.
  To support other target languages, a second translation step would be needed
  (e.g., pipe Whisper's English output through a lightweight translation API or
  local model). This is a future enhancement — English output covers the vast
  majority of users.

#### UI additions beyond base interpreter controls

- Source language hint selector (dropdown with common languages + auto-detect)
- Model size selector (with RAM/speed guidance)
- Detected source language badge (e.g., "Detected: Russian")
- Confidence indicators on translated segments (Whisper provides per-token
  log-probabilities — lower confidence segments could be dimmed)
- Speaker diarization indicator (stretch — Whisper doesn't do this natively, but
  energy-based heuristics can approximate it for radio where transmissions
  alternate)

#### Effort estimate

High. Integrating whisper.cpp via CGo, managing model downloads, VAD, and
buffering strategy. ~1–2 weeks for a working implementation, more for polish.

---

### 4. SSTV (Slow-Scan Television)

SSTV encodes images as audio tones. Each scan line is a series of tones
representing pixel brightness (or color components), with sync pulses separating
lines.

#### Signal processing pipeline

```
PCM16 frames (12 kHz)
  │
  ▼
VIS (Vertical Interval Signaling) detector
  ├─ Listen for 1900 Hz leader tone (~300 ms)
  ├─ Then 1200 Hz sync (30 ms)
  ├─ Then 8-bit VIS code (alternating 1100/1300 Hz tones, 30 ms each)
  └─ VIS code identifies the SSTV mode (Martin, Scottie, PD, Robot, etc.)
  │
  ▼
Mode-specific line decoder
  ├─ Measure instantaneous frequency (zero-crossing or Goertzel bank)
  ├─ Map frequency → pixel value (1500 Hz = black, 2300 Hz = white)
  ├─ Detect 1200 Hz horizontal sync pulses to align lines
  └─ Assemble R/G/B or Y/R-Y/B-Y components depending on mode
  │
  ▼
Image buffer (built up line by line, ~1-2 minutes per image)
  │
  ▼
Progressive image → pushed to clients via WebSocket as base64 PNG chunks
```

#### Supported modes (initial set)

| Mode | Resolution | Time | Color | Notes |
|------|-----------|------|-------|-------|
| Martin M1 | 320×256 | ~114s | RGB | Most popular |
| Martin M2 | 320×256 | ~58s | RGB | Faster, lower quality |
| Scottie S1 | 320×256 | ~110s | RGB | Popular in EU |
| Scottie S2 | 320×256 | ~71s | RGB | |
| Robot 36 | 320×240 | ~36s | YCbCr | Fast, common on ISS |
| PD 120 | 640×496 | ~126s | YCbCr | High resolution |

#### Key parameters (user-configurable)

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| Mode | Auto-detect (via VIS) | Auto / specific mode | Auto is usually right |
| Slant correction | Auto | Auto / manual angle | Compensates for sample rate mismatch |
| Noise reduction | Light | Off / Light / Heavy | Temporal averaging across lines |

#### Implementation notes

- **Frequency estimation** is the core DSP challenge. SSTV maps audio frequency
  to pixel brightness, so accurate instantaneous frequency measurement matters.
  A bank of Goertzel filters across the 1500–2300 Hz range works, or a
  zero-crossing detector with interpolation.
- **Sync recovery:** Horizontal sync pulses (1200 Hz, 5–9 ms depending on mode)
  must be reliably detected to align scan lines. Missing a sync causes the image
  to slant. A PLL that locks onto the sync interval helps.
- **Slant correction:** If the SDR's sample rate is slightly off from nominal
  12 kHz, the image will slant. Auto-correction can measure the actual sync
  interval and adjust.
- **Progressive display:** Unlike text-based interpreters, SSTV output is an
  image that builds up over 1–2 minutes. The server should push partial images
  to the client periodically (e.g., every 5 scan lines) so the user sees the
  image forming in real-time — this is a big part of the SSTV experience.
- **Output message format:** Instead of `text`, the `interpreter_output` payload
  would carry image data:

```json
{
  "type": "interpreter_output",
  "topic": "stream:abc123",
  "payload": {
    "interpreter": "sstv",
    "mode": "Martin M1",
    "progress": 0.45,
    "line": 115,
    "image": "<base64-encoded PNG of image so far>",
    "complete": false
  }
}
```

- **Go libraries:** There isn't a mature Go SSTV library, but the algorithm is
  well-documented and not complex — it's frequency estimation + table lookup.
  A pure Go implementation is feasible. Alternatively, call out to `qsstv` or
  a Python decoder as a subprocess, but that adds deployment complexity.

#### UI additions beyond base interpreter controls

- Image display area that progressively reveals the image line by line
- Gallery of previously decoded images (within the session)
- Mode indicator showing detected SSTV mode
- Sync/slant status indicator
- Save image button

#### Effort estimate

Medium-high. The VIS detector and basic line decoding are straightforward, but
supporting multiple modes and getting robust sync recovery takes work.
~1–2 weeks for Martin M1 support, more for additional modes.

---

### 5. FT8 / FT4 / WSPR

Digital weak-signal modes designed for making contacts with very low SNR.
These are structured, time-slotted protocols — very different from the
continuous-stream interpreters above.

#### How FT8 works (and why it's different)

FT8 transmissions are exactly 12.64 seconds long, start on specific time
boundaries (every 15 seconds), and encode 77 bits of payload using 8-FSK
modulation with LDPC error correction. Decoding requires:

1. Precise time synchronization (±1 second)
2. FFT analysis of the full 12.64-second window
3. Candidate detection (find signals in the time-frequency plane)
4. Costas array sync + LDPC decoding per candidate
5. Message unpacking (callsigns, grid squares, signal reports)

This is fundamentally a **batch** operation, not a continuous stream.

#### Signal processing pipeline

```
PCM16 frames (12 kHz)
  │
  ▼
Accumulate exactly 15-second windows (aligned to clock)
  │
  ▼
FFT-based candidate detection
  ├─ Compute spectrogram (time-frequency matrix)
  ├─ Search for 8-FSK tone patterns matching FT8 timing
  └─ Typically 0–50 candidates per window
  │
  ▼
Per-candidate decoding
  ├─ Costas synchronization array (7×7 known pattern)
  ├─ Extract 58 symbols → 174 bits (with Gray coding)
  ├─ LDPC decode (174,91) → 91 bits
  ├─ CRC-14 check → 77 payload bits
  └─ Unpack message type (CQ, grid, report, RR73, etc.)
  │
  ▼
Decoded messages → pushed to clients via WebSocket
```

#### Output message format

FT8 output is structured data, not free-form text:

```json
{
  "type": "interpreter_output",
  "topic": "stream:abc123",
  "payload": {
    "interpreter": "ft8",
    "cycle": "2026-03-15T14:30:00Z",
    "messages": [
      {
        "snr": -12,
        "dt": 0.3,
        "freq": 1284,
        "message": "CQ W1AW FN31",
        "callsign": "W1AW",
        "grid": "FN31",
        "type": "cq"
      },
      {
        "snr": -18,
        "dt": -0.1,
        "freq": 842,
        "message": "K1ABC W1AW -14",
        "callsign": "K1ABC",
        "type": "report"
      }
    ]
  }
}
```

#### Key parameters (user-configurable)

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| Protocol | FT8 | FT8 / FT4 / WSPR | Each has different timing and encoding |
| Depth | Normal | Fast / Normal / Deep | Decoding passes — deeper finds weaker signals but uses more CPU |
| Time source | System clock | System / NTP server | Accurate clock is critical |
| Frequency range | Full passband | Custom Hz range | Limit decoding to a sub-band |

#### Implementation notes

- **Don't rewrite the decoder.** The reference FT8 decoder is extremely well
  optimized and tricky to reimplement correctly. Options:
  - **ft8_lib** (C library by Karlis Goba) — small, embeddable, no dependencies.
    Can be called via CGo. This is the best option.
  - **WSJT-X** — the reference implementation. Could be run as a subprocess, fed
    WAV data, and have its output parsed. Heavy but battle-tested.
  - **go-ft8** — a pure Go port exists but may lag behind on decoder improvements.
- **Time sync:** FT8 decoding fails if the clock is off by more than ~2 seconds.
  The server should use NTP. The UI should show clock offset and warn if it's
  too large.
- **Batch vs streaming UX:** Unlike Morse (continuous text), FT8 produces a
  burst of decoded messages every 15 seconds. The UI should show these in a
  table/list grouped by cycle, similar to WSJT-X.
- **WSPR** is similar but uses 2-FSK, 110.6-second transmissions, and encodes
  callsign + grid + power. The same pipeline applies with different parameters.
  ft8_lib supports WSPR too.
- **FT4** is a faster variant of FT8 (7.5-second transmissions, 4-FSK) — also
  supported by ft8_lib.

#### UI additions beyond base interpreter controls

- Table view with columns: UTC, SNR (dB), DT (s), Freq (Hz), Message
- Color-coding by message type (CQ = green, report = yellow, RR73 = blue)
- Clock sync status indicator
- Band activity heatmap (frequency vs time, showing where signals are)
- Clickable callsigns → QRZ.com lookup
- Protocol selector (FT8 / FT4 / WSPR)

#### Effort estimate

Medium if using ft8_lib via CGo (the hard math is done). The integration work
is mostly around time-windowed buffering, CGo bindings, and the table-style UI
which differs from the text-stream UI used by other interpreters. ~1–2 weeks.

---

### Interpreter comparison matrix

| | Morse | RTTY | Voice | SSTV | FT8/WSPR |
|---|---|---|---|---|---|
| **DSP complexity** | Low | Medium | N/A (model) | Medium | High (use library) |
| **External deps** | None | None | whisper.cpp | None | ft8_lib |
| **CPU cost** | Trivial | Low | High | Low | Medium (bursty) |
| **Output type** | Text stream | Text stream | Translated text stream | Image | Structured table |
| **Timing** | Continuous | Continuous | Continuous | Per-image (~2 min) | Batch (15s cycles) |
| **Implementation effort** | ~1 week | ~2-3 days | ~1-2 weeks | ~1-2 weeks | ~1-2 weeks |
| **Priority** | **Phase 1** | Phase 2 | Phase 4 | Phase 5 | Phase 3 |

---

## Architecture decision: client-side vs server-side

### How audio flows today

```
KiwiSDR → Go backend (filter chain) → WebSocket (PCM16 @ 12 kHz) → Browser (resample → playback)
```

The browser already receives the full PCM16 audio stream. No additional plumbing
is needed to tap into it on the client. On the server, the stream manager's
fan-out already delivers PCM frames to subscribers, so a server-side decoder
could subscribe the same way the audio pump does.

### Recommendation: **server-side**, with results pushed over the existing WebSocket

| Concern | Client-side | Server-side |
|---------|-------------|-------------|
| **Latency** | Slightly lower (no round-trip) | Negligible — audio is already streaming from the server, and decoded text is tiny |
| **CPU load** | Offloaded to browser | On the server — but Morse decoding is very cheap (a few % of one core) |
| **Library ecosystem** | Limited — would need a JS/WASM Morse decoder | Rich — mature Go and C libraries (`libcw`, Goertzel filters are trivial in Go) |
| **Shared sessions** | Each client decodes independently; no consistency between peers | All peers on the same stream see the same decoded output |
| **Future interpreters** | Voice translation would require shipping a model to the browser or calling an API from the client (auth/key leak risk) | Server can call Whisper / cloud STT APIs securely |
| **Complexity** | Keeps backend simple | Adds a new subsystem, but fits naturally into the stream manager's subscriber model |

The strongest arguments for server-side:

1. **Peer consistency** — the app already supports multiple peers on one stream.
   Server-side decoding means everyone sees the same decoded text.
2. **Future-proofing** — voice translation and heavier decoders belong on the
   server. Starting server-side avoids a migration later.
3. **Library availability** — Goertzel tone detection and Morse timing logic are
   straightforward in Go, and the server already processes PCM frames.

---

## Morse decoder design

### Signal processing pipeline (server-side)

```
PCM16 frames (12 kHz)
  │
  ▼
Goertzel filter (tuned to CW sidetone, ~600-800 Hz)
  │
  ▼
Magnitude → binary envelope (tone on / tone off)
  │
  ▼
Debounce / hysteresis (ignore glitches < ~10 ms)
  │
  ▼
Timing classifier
  ├─ short pulse  → dit
  ├─ long pulse   → dah  (~3× dit length)
  ├─ short gap    → element separator
  ├─ medium gap   → character separator (~3× dit)
  └─ long gap     → word separator (~7× dit)
  │
  ▼
Morse tree lookup → characters
  │
  ▼
Assembled text buffer → pushed to clients via WebSocket
```

### Adaptive timing

The decoder should auto-detect WPM by measuring the shortest consistent pulse
length (the dit) using a running median or histogram. This lets it adapt to
different operators without manual WPM configuration.

A manual WPM override and sidetone frequency knob should be available as
advanced settings.

---

## Data model

### Interpreter config (per-stream, persisted)

```go
type InterpreterConfig struct {
    Type     string  `json:"type"`      // "morse", "rtty", "voice", "sstv", "ft8"
    Enabled  bool    `json:"enabled"`

    // Morse-specific
    SidetoneHz  int  `json:"sidetone_hz,omitempty"`   // 0 = auto-detect
    WPM         int  `json:"wpm,omitempty"`            // 0 = auto-detect

    // RTTY-specific
    MarkHz      int    `json:"mark_hz,omitempty"`       // 0 = 2125
    ShiftHz     int    `json:"shift_hz,omitempty"`      // 0 = 170
    BaudRate    float64 `json:"baud_rate,omitempty"`    // 0 = 45.45
    RTTYInvert  bool   `json:"rtty_invert,omitempty"`

    // Voice-specific (always translates — transcribes if source is already English)
    SourceLang  string `json:"source_lang,omitempty"`    // "" = auto-detect
    ModelSize   string `json:"model_size,omitempty"`     // "tiny", "base", "small"

    // SSTV-specific
    SSTVMode    string `json:"sstv_mode,omitempty"`      // "" = auto-detect

    // FT8/WSPR-specific
    FTProtocol  string `json:"ft_protocol,omitempty"`    // "ft8", "ft4", "wspr"
    FTDepth     string `json:"ft_depth,omitempty"`       // "fast", "normal", "deep"
}
```

This lives on the `Stream` model and is persisted as a JSONB column, same
pattern as `filters`:

```sql
ALTER TABLE streams ADD COLUMN IF NOT EXISTS interpreter JSONB NOT NULL DEFAULT '{}';
```

When `enabled` is false or the column is `'{}'`, no interpreter runs. When a
stream starts (or is reconfigured), the stream manager checks if an interpreter
is enabled and spins up the appropriate decoder goroutine.

Each interpreter type implements a common interface:

```go
type Interpreter interface {
    // Start begins processing. Reads PCM frames from the channel,
    // sends decoded output to the output channel.
    Start(ctx context.Context, audio <-chan []int16, output chan<- InterpreterOutput) error

    // Reconfigure updates parameters without restarting.
    Reconfigure(cfg InterpreterConfig) error
}

type InterpreterOutput struct {
    Type       string      `json:"interpreter"`
    Text       string      `json:"text,omitempty"`       // Morse, RTTY, Voice
    Image      []byte      `json:"image,omitempty"`      // SSTV (PNG)
    Messages   []FTMessage `json:"messages,omitempty"`   // FT8/WSPR
    Metadata   map[string]any `json:"metadata,omitempty"` // WPM, SNR, mode, etc.
    Clear      bool        `json:"clear,omitempty"`
    Complete   bool        `json:"complete,omitempty"`    // SSTV image complete
    Progress   float64     `json:"progress,omitempty"`   // SSTV progress 0-1
}
```

### WebSocket messages

**Client → server** (via existing `patch` mechanism):

```json
{
  "type": "patch",
  "topic": "stream:abc123",
  "payload": {
    "interpreter": {
      "type": "morse",
      "enabled": true,
      "sidetone_hz": 700
    }
  }
}
```

**Server → client** (new event type):

```json
{
  "type": "interpreter_output",
  "topic": "stream:abc123",
  "payload": {
    "interpreter": "morse",
    "text": "CQ CQ CQ DE W1AW",
    "wpm": 18,
    "snr_db": 12.5
  }
}
```

Output is pushed incrementally — each message appends new characters. The client
maintains the full decoded text buffer locally and displays it in the panel.

A `clear` flag can reset the client buffer (e.g., on interpreter restart or
manual clear).

---

## UI

### Controls

Add a new **Interpreter** section to the info panel (as a new tab, or within the
existing Filters tab). Controls:

- **Enable/disable** toggle
- **Type** dropdown (initially only "Morse")
- **Sidetone frequency** slider (200–1200 Hz, default 700, or "Auto")
- **WPM** input (5–60, or "Auto")

### Output panel

A scrollable text area below the controls (or in a bottom drawer) showing the
decoded text stream. Features:

- Monospace font, dark background (terminal aesthetic)
- Auto-scroll with "pinned to bottom" behavior
- Copy-to-clipboard button
- Clear button
- Subtle real-time indicator (blinking cursor or pulsing dot)
- WPM and SNR shown as small badges

### Waterfall integration (stretch goal)

Highlight the detected sidetone frequency on the spectrum/waterfall display with
a subtle marker, so the user can visually confirm the decoder is locked onto the
right tone.

---

## Implementation plan

### Phase 1: Interpreter framework + Morse

- [ ] Define `Interpreter` interface and `InterpreterOutput` types (`internal/interpreter/interpreter.go`)
- [ ] Implement Goertzel tone detector (`internal/interpreter/goertzel.go`)
- [ ] Implement Morse timing classifier and tree decoder (`internal/interpreter/morse.go`)
- [ ] Unit tests with synthetic CW audio samples
- [ ] Integrate with stream manager — subscribe to PCM frames when interpreter is enabled
- [ ] Add `InterpreterConfig` to the stream model, migration for `interpreter_config` column
- [ ] Handle `interpreter` field in the `patch` WebSocket message
- [ ] Push `interpreter_output` events to subscribed clients
- [ ] Interpreter controls in the info panel (toggle, type selector, Morse settings)
- [ ] Decoded text output panel with auto-scroll, copy, clear
- [ ] Adaptive WPM detection, sidetone auto-detection

### Phase 2: RTTY

- [ ] Implement dual-Goertzel FSK demodulator (`internal/interpreter/rtty.go`)
- [ ] Implement clock recovery and Baudot frame decoder
- [ ] Add RTTY-specific controls to UI (mark/space, shift, baud rate)
- [ ] Add tuning scope component (mark vs space magnitude indicator)

### Phase 3: FT8 / FT4 / WSPR

- [ ] Integrate ft8_lib via CGo (`internal/interpreter/ft8.go`)
- [ ] Implement time-windowed buffer (15s aligned to clock)
- [ ] NTP clock sync verification and status reporting
- [ ] Build table-style UI for decoded messages (different from text stream UI)
- [ ] Add FT4 and WSPR support (same library, different parameters)

### Phase 4: Voice (translation + transcription)

- [ ] Integrate whisper.cpp via Go bindings (`internal/interpreter/voice.go`)
- [ ] Implement VAD for utterance segmentation
- [ ] Model download/management (tiny, base, small)
- [ ] Language selection and auto-detect
- [ ] Optional cloud STT fallback path
- [ ] Confidence indicators in UI

### Phase 5: SSTV

- [ ] Implement VIS code detector (`internal/interpreter/sstv.go`)
- [ ] Implement frequency → pixel decoder for Martin M1
- [ ] Progressive image assembly and WebSocket delivery
- [ ] Add image display component to UI
- [ ] Support additional modes (Scottie, Robot 36, PD 120)
- [ ] Image gallery within session

---

## Design decisions

1. **Decoded output is ephemeral.** It is not persisted to the database or stream
   logs. The client holds the buffer in memory for the current session; switching
   interpreters or leaving the page clears it.

2. **One interpreter per stream.** Switching types disables the current
   interpreter and starts the new one. No concurrent interpreters.

3. **Interpreters are read-only consumers of the audio stream.** An interpreter
   receives raw PCM frames and must not modify the filter chain, bandpass, or any
   other part of the audio pipeline. If an interpreter needs narrower filtering
   (e.g., Morse benefits from a tight CW bandpass), it applies that internally
   to its own copy of the samples without affecting what the user hears.
