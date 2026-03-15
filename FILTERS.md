# Audio Filter Pipeline Plan

## Overview

Add a configurable chain of audio filters that process PCM16 frames in the Go backend, after receiving audio from the KiwiSDR client but before broadcasting to WebSocket subscribers and writing to the ring buffer. Every listener hears the same processed audio, and captured recordings contain the filtered result.

---

## Current Audio Flow

```
KiwiSDR → kiwi.Client (decode ADPCM/endian) → pcm channel → startPump()
                                                                │
                                                                ├──→ ringBuffer.Write(ts, frame)
                                                                └──→ broadcast(subscribers) → WebSocket → browsers
```

The raw PCM16 frames flow unmodified from the KiwiSDR through the entire pipeline. There is no processing step between decode and delivery.

---

## Proposed Audio Flow

```
KiwiSDR → kiwi.Client → pcm channel → startPump()
                                          │
                                          ▼
                                    ┌─────────────┐
                                    │ filterChain  │
                                    │  .Process()  │
                                    └──────┬──────┘
                                           │ (filtered PCM16)
                                           │
                                           ├──→ ringBuffer.Write(ts, filtered)
                                           └──→ broadcast(subscribers)
```

The filter chain sits in the pump goroutine's hot path. It receives raw PCM16 frames and returns processed PCM16 frames. The same filtered output goes to both the ring buffer and all subscribers. This guarantees that what clients hear is exactly what gets captured.

---

## Audio Format Constraints

| Parameter | Value |
|-----------|-------|
| Sample rate | 12,000 Hz |
| Format | PCM16 little-endian (signed 16-bit) |
| Channels | 1 (mono) |
| Frame size | ~1,024 bytes (~512 samples) |
| Frame rate | ~23.4 frames/sec |
| Nyquist frequency | 6,000 Hz |

All filters operate on signed 16-bit PCM samples. The 12 kHz sample rate means the maximum representable frequency is 6 kHz (Nyquist). SDR audio content typically lives well below this — voice modes (SSB/AM) occupy 300–3,000 Hz, CW sits at a single tone around 400–800 Hz, digital modes (FT8, WSPR) span narrow bands below 3 kHz.

---

## Filter Types

### 1. Low-Pass Filter

Attenuates frequencies above a configurable cutoff. This is the primary tool for removing high-frequency hiss, static, and noise that sits above the signal of interest.

**Use case:** SSB voice intelligibility. A KiwiSDR in USB mode with a 4.9 kHz passband delivers everything up to 4.9 kHz, but most voice energy is below 3 kHz. A low-pass at 3.0 kHz removes the upper hiss without touching the voice.

**Implementation:** Second-order IIR biquad filter (Butterworth response). The biquad is the workhorse of real-time audio DSP — it provides a smooth 12 dB/octave rolloff with only 5 multiply-adds per sample, zero allocation, and predictable latency. Coefficients are computed once from the cutoff frequency and sample rate using the standard bilinear transform.

```go
type LowPassFilter struct {
    cutoffHz   float64
    sampleRate float64
    b0, b1, b2 float64  // feedforward coefficients
    a1, a2     float64  // feedback coefficients
    x1, x2     float64  // input delay line
    y1, y2     float64  // output delay line
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `cutoff_hz` | 300–5500 | 3000 | Cutoff frequency in Hz |

**Why biquad over FIR:** At 12 kHz sample rate with ~512-sample frames, an FIR filter sharp enough to be useful would need 50–100 taps, requiring a convolution buffer and significantly more computation. The biquad achieves a clean rolloff with constant O(1) state and is the standard choice for real-time audio.

### 2. High-Pass Filter

Attenuates frequencies below a configurable cutoff. Removes low-frequency rumble, 50/60 Hz mains hum, and DC offset that can come from the KiwiSDR's ADC or demodulation chain.

**Use case:** Cleaning up AM broadcast reception where mains hum couples into the antenna. A high-pass at 100 Hz removes the hum without affecting voice (which starts around 300 Hz).

**Implementation:** Second-order IIR biquad, same structure as the low-pass but with high-pass Butterworth coefficients.

```go
type HighPassFilter struct {
    cutoffHz   float64
    // Same biquad state as LowPassFilter
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `cutoff_hz` | 20–2000 | 100 | Cutoff frequency in Hz |

### 3. Noise Gate

Silences the output when the signal level drops below a threshold. Unlike a continuous filter, this is a binary gate: audio passes through unmodified when "open" and is replaced with silence when "closed." This eliminates background noise during pauses in transmission.

**Use case:** Monitoring a repeater frequency. Between transmissions, the receiver picks up band noise. The noise gate mutes the output during these gaps, producing clean silence instead of hiss.

**Implementation:** Measure the RMS level of each frame. Compare against the threshold. Use hysteresis (separate open/close thresholds) and a hold timer to prevent rapid chattering at the gate boundary.

```go
type NoiseGate struct {
    thresholdDB float64   // level below which gate closes
    holdMs      float64   // how long to hold gate open after signal drops
    attackMs    float64   // fade-in time when gate opens
    releaseMs   float64   // fade-out time when gate closes

    isOpen       bool
    holdRemaining int     // samples remaining in hold period
    envelope      float64 // smoothed gain envelope (0.0–1.0)
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `threshold_db` | -80 to 0 | -40 | Gate threshold in dB (relative to full scale) |
| `hold_ms` | 0–2000 | 200 | Hold time before gate closes |
| `attack_ms` | 0–100 | 5 | Fade-in when gate opens |
| `release_ms` | 0–500 | 50 | Fade-out when gate closes |

**Why not a simple amplitude check:** A per-sample threshold creates horrible clicky artifacts. The RMS + envelope approach produces smooth transitions. The hold timer prevents the gate from chattering during natural speech pauses (which are shorter than the hold time).

### 4. Soft Clipper

Applies a smooth saturation curve to loud signals, compressing peaks instead of hard-clipping them. This tames sudden loud signals (nearby stations, static crashes, ignition noise) without the harsh distortion of digital clipping.

**Use case:** Listening to a weak DX station when a nearby strong station occasionally splashes into the passband. The soft clipper tames the loud bursts, making the listening experience less jarring.

**Implementation:** Apply a tanh-based waveshaping curve. Signals below the drive threshold pass through linearly; signals above are smoothly compressed toward the ceiling. This is the same nonlinearity used in analog tube amplifiers and is mathematically trivial.

```go
type SoftClipper struct {
    driveDB    float64 // input gain before clipping (positive = more saturation)
    ceilingDB  float64 // output ceiling
}
```

The transfer function is:

```
output = ceiling * tanh(input * drive / ceiling)
```

For small inputs, `tanh(x) ≈ x`, so the signal passes through unchanged. For large inputs, `tanh(x) → 1`, so the output asymptotically approaches the ceiling. No discontinuities, no harsh harmonics.

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `drive_db` | 0–24 | 6 | How much gain to apply before the saturation curve |
| `ceiling_db` | -12 to 0 | -1 | Output ceiling in dB relative to full scale |

### 5. Noise Reduction (Spectral Subtraction)

Estimates and subtracts background noise from the signal, improving clarity by reducing stationary noise (receiver hiss, atmospheric static). This is a frequency-domain filter — the only one in the chain that requires an FFT.

**Use case:** Pulling a weak voice signal out of heavy atmospheric noise on HF. The noise profile is relatively constant (white/pink noise), and spectral subtraction can reduce it by 10–15 dB while preserving the voice formants.

**Implementation:** Classic spectral subtraction with noise floor estimation:

1. Buffer incoming samples until we have a full FFT window (256 or 512 samples).
2. Apply a Hann window and compute the FFT (using Go's `math/cmplx` or a lightweight real-FFT).
3. Estimate the noise floor per frequency bin using a running minimum with exponential smoothing. During "quiet" frames (low RMS), the noise estimate converges to the actual noise spectrum.
4. Subtract the estimated noise magnitude from each bin's magnitude, flooring at zero to prevent "musical noise" artifacts.
5. Apply a spectral floor (don't subtract more than N dB per bin) to prevent the hollow "underwater" sound that aggressive subtraction produces.
6. Inverse FFT back to time domain.
7. Overlap-add with the previous frame to avoid block-boundary artifacts.

```go
type NoiseReducer struct {
    fftSize      int
    hopSize      int
    strength     float64    // 0.0–1.0, how aggressively to subtract
    floorDB      float64    // minimum bin level after subtraction

    noiseEst     []float64  // per-bin noise floor estimate
    inputBuf     []float64  // accumulation buffer for overlap
    outputBuf    []float64  // overlap-add output buffer
    window       []float64  // Hann window coefficients
    noiseFrames  int        // frames used for noise estimation
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `strength` | 0.0–1.0 | 0.5 | How aggressively to subtract noise (1.0 = maximum) |
| `floor_db` | -40 to 0 | -20 | Minimum bin level after subtraction (prevents hollow sound) |

**Trade-offs:** Spectral subtraction is the simplest frequency-domain noise reduction that actually works. It introduces some "musical noise" (twinkling artifacts) at high strength settings, which the spectral floor parameter mitigates. More sophisticated algorithms (Wiener filtering, MMSE-STSA) produce cleaner results but are significantly more complex. Spectral subtraction is the right starting point — if the artifacts are unacceptable at typical settings, we can upgrade later.

**Performance:** A 512-point FFT at 23.4 frames/sec is ~12,000 FFT operations/sec. Go's standard library doesn't include an FFT, but a pure-Go real-FFT for 512 points completes in < 50 µs. Well within the frame budget.

---

## Architecture

### Filter Interface

```go
package filter

type Filter interface {
    // Process applies the filter to a PCM16 frame in-place.
    // The input slice contains little-endian signed 16-bit samples.
    // The filter modifies the slice contents and returns it.
    Process(pcm []byte) []byte

    // Reset clears all internal state (delay lines, buffers, envelopes).
    Reset()
}
```

Individual filters operate on `[]float64` (normalized samples in [-1.0, 1.0]). The `Chain` handles PCM16 ↔ float64 conversion at the boundary once, so filters avoid repeated conversion overhead.

### Filter Chain

```go
type Chain struct {
    mu      sync.RWMutex
    filters []Filter
}

func (c *Chain) Process(pcm []byte) []byte {
    c.mu.RLock()
    defer c.mu.RUnlock()
    for _, f := range c.filters {
        pcm = f.Process(pcm)
    }
    return pcm
}

func (c *Chain) Reconfigure(filters []Filter) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.filters = filters
}
```

The chain holds a read lock during processing (called from the pump goroutine ~24 times/sec) and a write lock only during reconfiguration (rare, user-initiated). The read lock is held for the duration of one frame's processing (~10–100 µs depending on active filters), so reconfiguration blocks for at most one frame period.

### Filter Configuration Model

Filter configuration is stored as a JSONB column on the `streams` table. Adding a new filter type means adding a field to the Go struct and the TypeScript type — no migrations, no new columns, no schema changes.

```go
type FilterConfig struct {
    LowPass      *LowPassConfig      `json:"low_pass,omitempty"`
    HighPass     *HighPassConfig     `json:"high_pass,omitempty"`
    NoiseGate    *NoiseGateConfig    `json:"noise_gate,omitempty"`
    SoftClipper  *SoftClipperConfig  `json:"soft_clipper,omitempty"`
    NoiseReducer *NoiseReducerConfig `json:"noise_reducer,omitempty"`
}

type LowPassConfig struct {
    Enabled  bool    `json:"enabled"`
    CutoffHz float64 `json:"cutoff_hz"`
}

type HighPassConfig struct {
    Enabled  bool    `json:"enabled"`
    CutoffHz float64 `json:"cutoff_hz"`
}

type NoiseGateConfig struct {
    Enabled     bool    `json:"enabled"`
    ThresholdDB float64 `json:"threshold_db"`
    HoldMs      float64 `json:"hold_ms"`
    AttackMs    float64 `json:"attack_ms"`
    ReleaseMs   float64 `json:"release_ms"`
}

type SoftClipperConfig struct {
    Enabled   bool    `json:"enabled"`
    DriveDB   float64 `json:"drive_db"`
    CeilingDB float64 `json:"ceiling_db"`
}

```

The JSONB column holds the entire config. Null sub-objects mean that filter is unconfigured (disabled). Adding a sixth filter later is just adding a new struct and a new field to `FilterConfig` — the existing JSONB rows silently omit the new key, which Go unmarshals as `nil`.

### Filter Ordering

Filters always execute in a fixed order, regardless of which are enabled. The order is chosen for signal quality:

```
1. High-Pass        ← remove DC/hum first (protects downstream filters from DC bias)
2. Notch            ← kill tonal interference before downstream filters see it
3. Noise Reducer    ← spectral subtraction before gating/shaping
4. Noise Gate       ← gate decision is based on the cleaned signal
5. Low-Pass         ← shape the frequency response after noise processing
6. Soft Clipper     ← tame peaks after all other processing
```

This ordering is not user-configurable. Reordering DSP filters without understanding the implications produces bad results. A fixed, well-chosen order is the right default.

### Integration with Stream Model

Add a `filters` JSONB column to the `streams` table and a corresponding field on the Go model:

```go
type Stream struct {
    // ... existing fields ...
    Filters FilterConfig `json:"filters"`
}
```

The `Filters` field serializes to/from the JSONB column automatically via `pgx`'s JSON support. In `GetStreamByID` and `ListStreamsByTenant`, the column is scanned with `&stream.Filters` — pgx handles the JSON unmarshaling.

The existing `PATCH /api/streams/:id` endpoint and the WebSocket `patch` message type both accept a `filters` field. When filters change, the backend:

1. Persists the new config to the `filters` JSONB column.
2. Builds a new filter chain from the config.
3. Calls `chain.Reconfigure()` on the active stream.
4. Broadcasts a `stream_updated` event so all connected clients see the new filter state.

No new API endpoints needed — filters ride the existing stream update mechanism.

### Integration with `streammgr`

Add a `filterChain *filter.Chain` field to `activeStream`:

```go
type activeStream struct {
    // ... existing fields ...
    filterChain *filter.Chain
}
```

Modify `startPump` to apply the filter chain:

```go
case frame, ok := <-client.Samples():
    if !ok {
        return
    }
    as.framesFromKiwi.Add(1)
    as.bytesFromKiwi.Add(int64(len(frame)))

    // Apply filter chain before broadcast and ring buffer
    filtered := as.filterChain.Process(frame)

    if as.ringBuf != nil {
        as.ringBuf.Write(time.Now(), filtered)
    }
    as.broadcast(filtered)
```

When a stream is started, the filter chain is built from the stream's `FilterConfig`:

```go
as := &activeStream{
    // ...
    filterChain: filter.BuildChain(stream.Filters, sampleRate),
}
```

When the stream is reconfigured (filters changed via PATCH), `Reconfigure` builds a new chain and swaps it in:

```go
func (m *Manager) ReconfigureFilters(streamID string, cfg FilterConfig, sampleRate int) {
    as := m.streams[streamID]
    newChain := filter.BuildChain(cfg, sampleRate)
    as.filterChain.Reconfigure(newChain.Filters())
}
```

### `BuildChain` Function

```go
func BuildChain(cfg FilterConfig, sampleRate int) *Chain {
    var filters []Filter

    if cfg.HighPass != nil && cfg.HighPass.Enabled {
        filters = append(filters, NewHighPass(cfg.HighPass.CutoffHz, float64(sampleRate)))
    }
    if cfg.NoiseReducer != nil && cfg.NoiseReducer.Enabled {
        filters = append(filters, NewNoiseReducer(cfg.NoiseReducer.Strength, cfg.NoiseReducer.FloorDB))
    }
    if cfg.NoiseGate != nil && cfg.NoiseGate.Enabled {
        filters = append(filters, NewNoiseGate(cfg.NoiseGate, sampleRate))
    }
    if cfg.LowPass != nil && cfg.LowPass.Enabled {
        filters = append(filters, NewLowPass(cfg.LowPass.CutoffHz, float64(sampleRate)))
    }
    if cfg.SoftClipper != nil && cfg.SoftClipper.Enabled {
        filters = append(filters, NewSoftClipper(cfg.SoftClipper.DriveDB, cfg.SoftClipper.CeilingDB))
    }

    return &Chain{filters: filters}
}
```

---

## Performance Budget

Filters run in the pump goroutine's hot path. At ~23.4 frames/sec with ~512 samples/frame, the total per-frame budget is ~42 ms. Processing must be a small fraction of this.

| Filter | Per-Frame Cost | Notes |
|--------|---------------|-------|
| High-Pass (biquad) | ~2 µs | 5 multiply-adds per sample × 512 samples |
| Low-Pass (biquad) | ~2 µs | Same as high-pass |
| Noise Gate | ~5 µs | RMS computation + envelope smoothing |
| Soft Clipper | ~3 µs | tanh per sample (or polynomial approximation) |
| Noise Reduction | ~50 µs | 512-point FFT + IFFT + bin processing |
| **Full chain** | **~62 µs** | **< 0.15% of frame budget** |

All filters are zero-allocation in steady state. The initial `BuildChain` allocates filter structs and their internal buffers once. `Process` calls modify samples in-place (or into pre-allocated buffers for the FFT path) with no per-frame allocation.

---

## Database Migration

```sql
-- migrations/NNN_stream_filters.up.sql
ALTER TABLE streams ADD COLUMN filters JSONB NOT NULL DEFAULT '{}';

-- migrations/NNN_stream_filters.down.sql
ALTER TABLE streams DROP COLUMN filters;
```

A single column addition. No data migration — all existing streams start with an empty filter config (`{}` unmarshals to a `FilterConfig` with all nil sub-objects, meaning no filters enabled).

---

## API Changes

No new endpoints. The existing stream PATCH mechanism handles filter configuration:

### Setting Filters via REST

```
PATCH /api/streams/{id}
Content-Type: application/json

{
  "filters": {
    "low_pass": {
      "enabled": true,
      "cutoff_hz": 3000
    },
    "noise_gate": {
      "enabled": true,
      "threshold_db": -35,
      "hold_ms": 300
    }
  }
}
```

### Setting Filters via WebSocket

```json
{
  "type": "patch",
  "version": 42,
  "patch": {
    "filters": {
      "low_pass": { "enabled": true, "cutoff_hz": 2800 },
      "high_pass": { "enabled": true, "cutoff_hz": 100 }
    }
  }
}
```

The response is the standard `stream_updated` event broadcast to all connected clients, which includes the full updated stream object with the current filter config.

### Reporting Active Filters

The `connected` message already includes the full stream object. Since `FilterConfig` is a field on the stream, clients automatically receive the current filter state on connect:

```json
{
  "type": "connected",
  "stream": {
    "id": "...",
    "filters": {
      "low_pass": { "enabled": true, "cutoff_hz": 3000 },
      "noise_gate": { "enabled": true, "threshold_db": -35 }
    }
  }
}
```

---

## Biquad Filter Mathematics

Both the low-pass and high-pass filters use the same biquad structure. Only the coefficient computation differs.

### Biquad Difference Equation

```
y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
```

Five multiply-adds per sample. The `x` values are the input delay line, the `y` values are the output delay line.

### Coefficient Computation (Butterworth)

```go
func lowPassCoeffs(cutoffHz, sampleRate float64) (b0, b1, b2, a1, a2 float64) {
    w0 := 2 * math.Pi * cutoffHz / sampleRate
    alpha := math.Sin(w0) / (2 * math.Sqrt2) // Q = 1/sqrt(2) for Butterworth

    b0 = (1 - math.Cos(w0)) / 2
    b1 = 1 - math.Cos(w0)
    b2 = (1 - math.Cos(w0)) / 2
    a0 := 1 + alpha
    a1 = -2 * math.Cos(w0) / a0
    a2 = (1 - alpha) / a0
    b0 /= a0
    b1 /= a0
    b2 /= a0
    return
}

func highPassCoeffs(cutoffHz, sampleRate float64) (b0, b1, b2, a1, a2 float64) {
    w0 := 2 * math.Pi * cutoffHz / sampleRate
    alpha := math.Sin(w0) / (2 * math.Sqrt2)

    b0 = (1 + math.Cos(w0)) / 2
    b1 = -(1 + math.Cos(w0))
    b2 = (1 + math.Cos(w0)) / 2
    a0 := 1 + alpha
    a1 = -2 * math.Cos(w0) / a0
    a2 = (1 - alpha) / a0
    b0 /= a0
    b1 /= a0
    b2 /= a0
    return
}
```

These are the standard Audio EQ Cookbook formulas (Robert Bristow-Johnson). Coefficients are computed once when the filter is created and never change unless the cutoff frequency is reconfigured.

---

## Reconfiguration Behavior

When filters are reconfigured while the stream is active:

1. A new set of `Filter` instances is created from the new config.
2. The chain's `Reconfigure()` method swaps the filter slice under a write lock.
3. The old filters are discarded (garbage collected).
4. The new filters start with fresh state (zero delay lines, empty buffers).

**Audible impact:** Replacing filter state mid-stream produces a brief transient (one frame, ~42 ms) as the new filters "prime" their delay lines. For biquad filters this is a barely perceptible click. For noise reduction, it means the noise estimate resets and takes a few frames to reconverge. This is acceptable for a user-initiated configuration change — the alternative (hot-swapping coefficients while preserving state) is fragile and not worth the complexity.

---

## Frontend: Post-Processing Panel

### Overview

A collapsible "Post-Processing" panel in the stream player page sidebar that exposes the four phase-1 filter controls. Each filter gets a section with an enable/disable toggle and parameter sliders. Changes are sent as patches over the WebSocket and take effect immediately for all listeners.

### Panel Location

The panel lives in the right sidebar, between the "Source" section and the "Logs" section. It's always visible when the sidebar is open — no extra button needed to reveal it. This keeps post-processing controls in the natural top-to-bottom workflow: source at the top, then signal processing, then logs at the bottom.

```
┌─────────────────────────────────────────────────────┐
│ [sidebar]                                           │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ SOURCE                                [Change]  │ │
│ │ KiwiSDR @ AB1CDE                                │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ POST-PROCESSING                                 │ │
│ │                                                 │ │
│ │ ┌─ Low-Pass ──────────────── [toggle] ────────┐ │ │
│ │ │ Cutoff    ───────────●────────────  3000 Hz  │ │ │
│ │ └─────────────────────────────────────────────┘ │ │
│ │                                                 │ │
│ │ ┌─ High-Pass ─────────────── [toggle] ────────┐ │ │
│ │ │ Cutoff    ──●────────────────────────  100 Hz│ │ │
│ │ └─────────────────────────────────────────────┘ │ │
│ │                                                 │ │
│ │ ┌─ Noise Gate ────────────── [toggle] ────────┐ │ │
│ │ │ Threshold ──────●────────────────── -40 dB   │ │ │
│ │ │ Hold      ──────────●──────────────  200 ms  │ │ │
│ │ └─────────────────────────────────────────────┘ │ │
│ │                                                 │ │
│ │ ┌─ Soft Clipper ──────────── [toggle] ────────┐ │ │
│ │ │ Drive     ─────●───────────────────   6 dB   │ │ │
│ │ │ Ceiling   ──────────────────────●──  -1 dB   │ │ │
│ │ └─────────────────────────────────────────────┘ │ │
│ │                                                 │ │
│ │ ┌─ Noise Reduction ──────── [toggle] ────────┐ │ │
│ │ │ Strength  ──────────●──────────────  50%     │ │ │
│ │ └─────────────────────────────────────────────┘ │ │
│ │                                                 │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ LOGS                                            │ │
│ │ [12:01:03] connected, subscribed to stream      │ │
│ │ ...                                             │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Component: `post-processing-panel.tsx`

New file: `frontend/src/components/post-processing-panel.tsx`

The panel receives the current `FilterConfig` from the stream object and calls back with updates. It does not manage its own WebSocket connection — the parent `stream-player-page.tsx` handles patching.

```typescript
type FilterConfig = {
  low_pass?: { enabled: boolean; cutoff_hz: number };
  high_pass?: { enabled: boolean; cutoff_hz: number };
  noise_gate?: {
    enabled: boolean;
    threshold_db: number;
    hold_ms: number;
    attack_ms: number;
    release_ms: number;
  };
  soft_clipper?: { enabled: boolean; drive_db: number; ceiling_db: number };
  noise_reducer?: { enabled: boolean; strength: number; floor_db: number };
};

type PostProcessingPanelProps = {
  filters: FilterConfig;
  onFiltersChange: (filters: FilterConfig) => void;
};
```

### UI Primitives Needed

The panel needs two new shadcn/ui primitives that don't exist yet:

| Component | Package | Purpose |
|-----------|---------|---------|
| `Slider` | `@radix-ui/react-slider` | Continuous parameter adjustment (cutoff, threshold, etc.) |
| `Switch` | `@radix-ui/react-switch` | Enable/disable toggle per filter |

Both are standard shadcn components. `@radix-ui/react-slider` and `@radix-ui/react-switch` are already available through the `radix-ui` package in `package.json`.

### Filter Section Pattern

Each filter section follows the same visual pattern:

```
┌─────────────────────────────────────────────┐
│ Filter Name                        [switch] │
│                                             │
│ (when enabled, parameter sliders appear:)   │
│                                             │
│ Param Label  ───────●─────────── value unit │
│ Param Label  ──────────────●──── value unit │
└─────────────────────────────────────────────┘
```

- **Header row:** Filter name (left) + Switch toggle (right). Muted text style when disabled.
- **Parameter sliders:** Only visible when the filter is enabled. Each slider has a label on the left, the track in the center, and the current numeric value + unit on the right.
- **Collapsed state:** When a filter is disabled, only the header row with the toggle is shown. This keeps the panel compact when few filters are active.
- **Dividers:** A subtle border between each filter section for visual separation.

### Slider Behavior

Sliders fire `onFiltersChange` on every value change (not just on release). This gives real-time audio feedback as the user drags — they hear the filter parameter change live. The WebSocket patch is debounced to avoid flooding the server: buffer changes for 150ms after the last slider move, then send one patch with the final value.

This debounce is important. A user dragging the low-pass cutoff from 3000 Hz to 1500 Hz might generate 30+ intermediate values in under a second. Without debouncing, each would trigger a full stream update cycle (DB write, filter chain rebuild, broadcast to all clients). With debouncing, only the final resting value is sent.

```typescript
const debouncedPatch = useRef<ReturnType<typeof setTimeout>>();

const handleFiltersChange = (next: FilterConfig) => {
  // Update local state immediately for responsive UI
  setLocalFilters(next);

  // Debounce the actual patch
  if (debouncedPatch.current) clearTimeout(debouncedPatch.current);
  debouncedPatch.current = setTimeout(() => {
    sendPatch({ filters: next });
  }, 150);
};
```

The panel maintains local state that updates instantly on every slider move, while the actual WebSocket patch is debounced. This means the slider thumb tracks the finger/mouse without lag, and the backend only processes the final value.

### Filter Controls Detail

#### Low-Pass Filter

| Control | Type | Range | Step | Default | Display |
|---------|------|-------|------|---------|---------|
| Enabled | Switch | — | — | off | — |
| Cutoff | Slider | 300–5500 Hz | 50 | 3000 | `{value} Hz` |

#### High-Pass Filter

| Control | Type | Range | Step | Default | Display |
|---------|------|-------|------|---------|---------|
| Enabled | Switch | — | — | off | — |
| Cutoff | Slider | 20–2000 Hz | 10 | 100 | `{value} Hz` |

#### Noise Gate

| Control | Type | Range | Step | Default | Display |
|---------|------|-------|------|---------|---------|
| Enabled | Switch | — | — | off | — |
| Threshold | Slider | -80 to 0 dB | 1 | -40 | `{value} dB` |
| Hold | Slider | 0–2000 ms | 10 | 200 | `{value} ms` |

Attack and release are not exposed in the UI — they use sensible defaults (5 ms attack, 50 ms release) that work well for SDR audio. Exposing them would add complexity without meaningful benefit for the target audience. They remain configurable via the API/WebSocket for advanced users.

#### Soft Clipper

| Control | Type | Range | Step | Default | Display |
|---------|------|-------|------|---------|---------|
| Enabled | Switch | — | — | off | — |
| Drive | Slider | 0–24 dB | 1 | 6 | `{value} dB` |
| Ceiling | Slider | -12 to 0 dB | 0.5 | -1 | `{value} dB` |

#### Noise Reduction

| Control | Type | Range | Step | Default | Display |
|---------|------|-------|------|---------|---------|
| Enabled | Switch | — | — | off | — |
| Strength | Slider | 0–100% | 5 | 50 | `{value}%` |
| Floor | Slider | -40 to 0 dB | 1 | -20 | `{value} dB` |

### Integration with `stream-player-page.tsx`

The panel is placed inside the sidebar's scroll container, between the Source section and the Logs section:

```tsx
{/* Source section (existing) */}
<section className="border-b">
  ...
</section>

{/* Post-processing section (new) */}
<section className="border-b">
  <PostProcessingPanel
    filters={stream?.filters ?? {}}
    onFiltersChange={(filters) => {
      sendPatch({ filters });
    }}
  />
</section>

{/* Logs section (existing) */}
<section className="flex min-h-0 flex-1 flex-col">
  ...
</section>
```

The `Stream` type in `api.ts` gets a `filters` field:

```typescript
export type Stream = {
  // ... existing fields ...
  filters?: FilterConfig;
};
```

The `sendPatch` function already sends arbitrary patch objects over the WebSocket and receives `stream_updated` events back. When a `stream_updated` arrives with new filter state, the stream object updates, the panel re-renders with the new values, and all clients see the same filter configuration. No additional WebSocket message types are needed.

### Multi-User Behavior

When one user changes a filter, the `stream_updated` event broadcasts to all connected clients with the new stream object (including the full `filters` field). Every client's panel updates to reflect the change. The `changed_fields` array in the event will include `"filters"`, which the log can display:

```
[12:03:15] peer changed: filters
```

If two users adjust the same slider simultaneously, the last write wins (via the existing optimistic version conflict resolution). The conflict toast ("Settings changed by another listener") appears if a user's patch races with another — same behavior as changing frequency or mode today.

### Responsive Considerations

The panel is inside a resizable sidebar (200–600 px range). The slider tracks use `flex-1` to fill available width, so they adapt naturally. At the minimum sidebar width (200 px), the sliders are still usable but compact. The value labels on the right are fixed-width (`w-16`) to prevent layout shifts as values change.

On narrow viewports where the sidebar is closed, the post-processing panel is not accessible. This is acceptable — the sidebar toggle already exists, and post-processing is not a frequent adjustment. A future mobile layout could move the panel to a bottom sheet.

---

## New Files

| File | Purpose |
|------|---------|
| `internal/filter/filter.go` | `Filter` interface, `Chain` struct, `BuildChain` function |
| `internal/filter/biquad.go` | Low-pass and high-pass biquad implementations |
| `internal/filter/gate.go` | Noise gate implementation |
| `internal/filter/clipper.go` | Soft clipper implementation |
| `internal/filter/nr.go` | Noise reduction (spectral subtraction) |
| `internal/filter/fft.go` | Pure-Go radix-2 Cooley-Tukey FFT/IFFT |
| `internal/filter/filter_test.go` | Tests for all filters |
| `frontend/src/components/post-processing-panel.tsx` | Post-processing panel UI |
| `frontend/src/components/ui/slider.tsx` | Slider primitive (shadcn) |
| `frontend/src/components/ui/switch.tsx` | Switch primitive (shadcn) |
| `migrations/NNN_stream_filters.up.sql` | Add `filters` JSONB column |
| `migrations/NNN_stream_filters.down.sql` | Drop `filters` column |

---

## Implementation Order

| Step | Task | Scope | Depends On |
|------|------|-------|------------|
| 1 | `Filter` interface + `Chain` + `BuildChain` scaffold | Backend | Nothing |
| 2 | `LowPassFilter` + `HighPassFilter` (biquad) | Backend | Step 1 |
| 3 | Wire `Chain` into `startPump` and `activeStream` | Backend | Steps 1–2 |
| 4 | DB migration: add `filters` JSONB column | Backend | Nothing |
| 5 | Add `Filters` field to `models.Stream`, update DB read/write | Backend | Step 4 |
| 6 | Extend `patchStreamRequest` to accept `filters`, trigger `ReconfigureFilters` | Backend | Steps 3, 5 |
| 7 | `NoiseGate` | Backend | Step 1 |
| 8 | `SoftClipper` | Backend | Step 1 |
| 9 | `NoiseReducer` (spectral subtraction) | Backend | Step 1 |
| 10 | Tests for all filters | Backend | Steps 2, 7–9 |
| 11 | Add `slider.tsx` + `switch.tsx` UI primitives | Frontend | Nothing |
| 12 | `post-processing-panel.tsx` — filter controls UI | Frontend | Step 11 |
| 13 | Integrate panel into `stream-player-page.tsx` — sidebar section | Frontend | Steps 6, 12 |

Steps 1, 4, 7–9, 11 are independent and can be developed in parallel. Step 3 is the critical backend integration point. Step 13 closes the loop end-to-end.

**Recommended sequencing:** Build steps 1–3 first with the biquad filters, plus steps 4–6 for the data layer. Verify end-to-end by patching a stream with `"filters": {"low_pass": {"enabled": true, "cutoff_hz": 2000}}` and confirming the audio sounds muffled for all connected clients. Then add the remaining filters (steps 7–9) one at a time, testing each in isolation before integrating. Build the frontend panel (steps 11–13) in parallel with the remaining backend filters.

---

## Testing Strategy

### Unit Tests

Each filter gets a unit test that feeds in a known PCM16 waveform and asserts on the output:

| Test | Method |
|------|--------|
| Low-pass attenuation | Generate a 5 kHz sine wave, run through a 2 kHz low-pass, verify amplitude drops > 12 dB |
| High-pass attenuation | Generate a 50 Hz sine wave, run through a 200 Hz high-pass, verify amplitude drops > 12 dB |
| Passband preservation | Generate a 1 kHz sine wave, run through a 3 kHz low-pass, verify amplitude is within 1 dB |
| Noise gate silence | Feed sub-threshold white noise, verify output is near-silent |
| Noise gate pass-through | Feed above-threshold signal, verify output matches input |
| Soft clipper ceiling | Feed a full-scale sine wave, verify output peaks don't exceed ceiling |
| Soft clipper transparency | Feed a -20 dB sine wave with +6 dB drive, verify minimal distortion |
| Chain ordering | Build a chain with high-pass + low-pass, verify both are applied and in the correct order |

### Integration Test

A test that creates an `activeStream` with a filter chain, feeds frames through `startPump` (via a mock kiwi client), subscribes, and verifies the subscriber receives filtered audio.

---

## Known Hard Parts

1. **Noise reduction FFT.** Go's standard library has no FFT. Options: (a) pure-Go FFT implementation for 512-point transforms — straightforward Cooley-Tukey, ~100 lines, (b) use a small third-party package like `mjibson/go-dsp`. Pure Go is preferred to avoid adding a dependency for a single function. The noise reduction filter is the only one that needs it.

2. **Noise estimation convergence.** Spectral subtraction needs several frames of "noise only" input to build an accurate noise floor estimate. On startup, the estimate is zero, so the first second or so of noise reduction will be ineffective. This is fine — the estimate converges within ~1 second (24 frames), and the user won't notice the brief ramp-up. An alternative is to seed the estimate from the first N frames regardless of signal content, accepting that some signal energy will be treated as noise initially.

3. **Filter reconfiguration transients.** Swapping the filter chain resets all state. For biquad filters, this causes a one-frame transient (barely audible). For noise reduction, this resets the noise estimate (1-second reconvergence). Documenting this behavior is sufficient — it only happens on user-initiated config changes, not during normal operation.

---

## Future Considerations

**Preset system.** Once filters are proven, add named presets ("Voice Clean", "CW Narrow", "DX Weak Signal") that set multiple filter parameters at once. This is a pure frontend/API concern — the backend just sees a `FilterConfig` regardless of whether it came from a preset or manual parameter adjustment.

**Per-client filters.** The current design applies filters server-side to all clients identically. A future extension could allow per-client filtering (e.g., one client wants noise reduction, another doesn't). This would require moving the filter chain from the pump (one per stream) to the subscriber goroutine (one per client). The same `Chain` abstraction works — it just runs in a different goroutine. The ring buffer would store unfiltered audio, and each subscriber would get its own filtered copy. This is a significant architectural change and is explicitly out of scope for this plan.

**Filter metering.** Expose per-filter metrics (input/output RMS, gain reduction amount for noise gate, noise floor estimate for noise reduction) via the WebSocket. This enables a frontend visualization of what each filter is doing — useful for tuning parameters. Not needed for the initial implementation.
