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

## Fun / Creative Filters

These filters don't clean up the signal — they transform it for entertainment, experimentation, and aesthetic purposes. They're useful for making radio audio more interesting to listen to, creating sound art from shortwave, or just messing around. All sit at the end of the filter chain, after the cleanup filters have done their work, so effects are applied to the cleanest possible signal.

### 9. Pitch Shifter

Shifts the pitch of the audio up or down by a configurable number of semitones, without changing the playback speed. Makes voices sound higher (chipmunk) or lower (deep/ominous), and shifts tonal content like CW tones or digital mode frequencies.

**Use case:** Shift a CW tone to a more comfortable listening pitch. Shift voice down for a cinematic "numbers station" feel. Shift utility signals into a different register for easier identification. Or just make everything sound ridiculous.

**Implementation:** Granular pitch shifting using overlapping windowed segments. The input audio is sliced into small grains (64–128 samples). Each grain is read at a different rate determined by the pitch ratio (2^(semitones/12)) and crossfaded with its neighbors using a Hann window to prevent discontinuities at grain boundaries. This is the classic SOLA (Synchronous Overlap-Add) approach — it preserves the time duration while changing the pitch.

```go
type PitchShifter struct {
    semitones    float64
    pitchRatio   float64   // 2^(semitones/12)
    grainSize    int       // grain length in samples (e.g. 128)
    overlapSize  int       // overlap between grains
    inputBuf     []float64 // accumulation ring buffer
    outputBuf    []float64 // overlap-add output
    readPos      float64   // fractional read position into input
    writePos     int       // write position into input
    window       []float64 // Hann window for grain crossfade
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `semitones` | -12 to +12 | 0 | Pitch shift in semitones. +12 = one octave up, -12 = one octave down |

**Trade-offs:** Granular pitch shifting introduces a slight "watery" or "phaser" quality at extreme settings (> 7 semitones in either direction), caused by the grain splicing. At moderate shifts (±3–5 semitones), the quality is good for voice. A more sophisticated algorithm (phase vocoder with phase locking) would reduce artifacts but requires an FFT per frame — not worth the complexity for a fun filter.

**Performance:** The grain-based approach uses a fixed-size circular buffer (~2x frame size) and a Hann window table computed once. Per-frame cost is ~10–15 µs: read at offset rate + window multiplication + overlap-add. No FFT, no allocation.

**Visualization: `pitch-shifter-wave.tsx`**

A dual-waveform display showing the original signal waveform (ghosted/dim) overlaid with the pitch-shifted output waveform (primary color). The shifted waveform is visually compressed or stretched horizontally relative to the original, giving an intuitive sense of the pitch change direction and magnitude. A center line marks zero shift, with a small semitone indicator in the corner.

- **Canvas-based**, animated via `requestAnimationFrame`
- **Props:** `samplesRef: RefObject<Float32Array>`, `semitones: number`, `height?: number`
- **Height:** 72px (same as spectrum visualizers)
- The original waveform draws at `hexToRgba(c, 0.08)` fill + `0.15` stroke
- The shifted waveform draws at `hexToRgba(c, 0.15)` fill + `0.5` stroke
- Semitone value displayed top-right at `rgba(255,255,255,0.25)`, 9px

**Panel integration:**
```
┌─ Pitch Shifter ─────────────── [toggle] ────────┐
│ [~~ waveform overlay visualization ~~]           │
│ Shift    ──────────────●──────────  +3 st        │
└──────────────────────────────────────────────────┘
```

**FilterTip:**
- **what:** "Shifts the pitch of the audio up or down without changing the speed."
- **when:** "Use to move a CW tone to a comfortable pitch, give voices a dramatic shift, or just make things sound strange. Moderate shifts (±3–5) sound natural; extremes get weird."
- **how:** "Granular overlap-add (SOLA) pitch shifting. Input is split into small overlapping grains, each read at a rate determined by 2^(semitones/12), then crossfaded with Hann windows. No FFT required."

---

### 10. Echo

Adds one or more delayed copies of the audio, creating an echo or slapback effect. Each repeat is attenuated by a feedback factor, producing a natural decay.

**Use case:** Add atmosphere to shortwave broadcasts. Create a spacey, cavernous quality for number stations. Add a subtle slapback to make voice transmissions sound like they're in a room. Or crank feedback up and create infinite-reverb washes from ambient radio noise.

**Implementation:** A simple feedback delay line. The output is `input + feedbackGain * delayBuffer[readPos]`, and the mixed result is written back into the delay buffer. The delay buffer is a circular buffer sized for the maximum delay time. Multiple taps at different delays could be supported, but a single tap with feedback produces convincing echoes with minimal complexity.

```go
type Echo struct {
    delayMs      float64
    feedback     float64    // 0.0–0.9, gain applied to each repeat
    mix          float64    // 0.0–1.0, dry/wet balance
    sampleRate   int
    delaySamples int        // delayMs * sampleRate / 1000
    buf          []float64  // circular delay buffer
    writePos     int        // current write position in the buffer
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `delay_ms` | 50–1000 | 250 | Delay time in milliseconds |
| `feedback` | 0.0–0.9 | 0.3 | How much of the delayed signal feeds back. Higher = more repeats |
| `mix` | 0.0–1.0 | 0.4 | Dry/wet balance. 0.0 = dry only, 1.0 = wet only |

**Why cap feedback at 0.9:** At feedback >= 1.0 the echo never decays — the signal builds up and eventually clips. 0.9 gives a long, gradually fading tail (~20 repeats before inaudibility) without the risk of runaway buildup. The UI should make it clear that high feedback produces a long, ambient wash.

**Performance:** The delay buffer is allocated once at `maxDelay * sampleRate / 1000` samples (~12,000 samples for 1s at 12 kHz = 96 KB). Per-sample cost is one read, one multiply-add, one write. Per-frame cost is ~3 µs. Zero allocation in steady state.

**Visualization: `echo-trail.tsx`**

A time-domain visualization showing the echo taps as a series of decaying vertical bars. The leftmost bar (tallest) represents the dry signal, followed by progressively shorter bars at intervals corresponding to the delay time, each attenuated by the feedback amount. The number and height of bars updates in real-time as delay and feedback parameters change, giving an immediate visual sense of the echo density and decay.

- **Canvas-based**, redraws on parameter change (not animated per-frame — echo params are static, no `samplesRef` needed)
- **Props:** `delayMs: number`, `feedback: number`, `mix: number`, `height?: number`
- **Height:** 72px
- Each bar is drawn at `hexToRgba(c, alpha)` where alpha decays with each tap
- The dry bar height = `plotH * mix_dry`, wet bars start at `plotH * mix_wet * feedback^n`
- A horizontal time axis with thin tick marks at each delay interval, drawn at `rgba(255,255,255,0.06)`
- Mix ratio shown top-right at `rgba(255,255,255,0.25)`, 9px

**Panel integration:**
```
┌─ Echo ──────────────────────── [toggle] ────────┐
│ [| |  |  :  :   .   .   .  ] echo trail viz     │
│ Delay    ──────────●──────────────  250 ms       │
│ Feedback ──────●──────────────────  0.3          │
│ Mix      ──────────●──────────────  40%          │
└──────────────────────────────────────────────────┘
```

**FilterTip:**
- **what:** "Adds repeating delayed copies of the audio, creating an echo effect with adjustable decay."
- **when:** "Use to add atmosphere or space to any signal. Subtle settings (short delay, low feedback) add room-like ambience. High feedback creates long, ambient reverb tails from radio noise."
- **how:** "Circular delay buffer with feedback. Each sample is mixed with a delayed copy of itself, and the result is written back into the buffer for subsequent repeats. Feedback controls decay rate; mix controls dry/wet balance."

---

### 11. Bitcrusher

Intentionally reduces the audio resolution by lowering the effective bit depth and/or sample rate. Produces the lo-fi, crunchy, digital-artifact sound of early digital audio equipment — like listening to shortwave through a 1985 Speak & Spell.

**Use case:** Give any signal a harsh, retro digital aesthetic. Make utility stations sound like they're being decoded by ancient hardware. Create glitch-art audio from ambient noise. The bitcrusher is purely destructive and makes everything sound worse in the best way.

**Implementation:** Two independent degradation stages applied per sample:

1. **Bit reduction:** Quantize the sample to fewer bits. For a target of N bits, multiply by 2^(N-1), round to the nearest integer, then divide back. This creates staircase-shaped waveforms with audible quantization noise.
2. **Sample rate reduction:** Hold each sample for `sampleRate / crushRate` samples, producing the aliased, bandwidth-limited sound of a lower sample rate without actually resampling.

```go
type Bitcrusher struct {
    bits       int       // effective bit depth (1–16)
    crushRate  float64   // effective sample rate in Hz
    sampleRate int
    holdValue  float64   // current held sample
    holdCount  int       // samples remaining in current hold
    holdPeriod int       // samples per hold period
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `bits` | 1–16 | 8 | Effective bit depth. Lower = crunchier. 16 = no bit reduction |
| `crush_rate` | 100–12000 | 4000 | Effective sample rate. Lower = more aliased. 12000 = no rate reduction |

**Performance:** Two operations per sample (quantize + hold check). Per-frame cost is ~2 µs. Zero allocation. The simplest filter in the entire chain.

**Visualization: `bitcrusher-wave.tsx`**

A waveform display showing the "crushed" staircase output. The original smooth waveform is ghosted behind, and the quantized/sample-held version is drawn over it as a blocky staircase. At high bit depths the two nearly overlap; as bits decrease, the staircase steps become dramatically visible. Sample rate reduction shows as horizontal plateaus between steps.

- **Canvas-based**, animated via `requestAnimationFrame`
- **Props:** `samplesRef: RefObject<Float32Array>`, `bits: number`, `crushRate: number`, `height?: number`
- **Height:** 72px
- The original waveform is drawn as a thin line at `hexToRgba(c, 0.12)`
- The crushed waveform is drawn as a stepped line at `hexToRgba(c, 0.5)` with `lineWidth: 1.5`
- Fill below the crushed waveform at `hexToRgba(c, 0.08)`
- Bits value displayed top-right at `rgba(255,255,255,0.25)`, 9px (e.g. "8 bit")

**Panel integration:**
```
┌─ Bitcrusher ────────────────── [toggle] ────────┐
│ [~~staircase vs smooth waveform overlay~~]       │
│ Bits       ────────────●──────────────  8 bit    │
│ Crush Rate ────────●──────────────────  4000 Hz  │
└──────────────────────────────────────────────────┘
```

**FilterTip:**
- **what:** "Intentionally degrades audio quality by reducing bit depth and sample rate, producing a crunchy, lo-fi digital sound."
- **when:** "Use for aesthetic effect — makes any signal sound like vintage digital hardware. Low bit depths create harsh quantization noise; low crush rates add aliasing. Purely destructive, entirely fun."
- **how:** "Two stages per sample: quantization to N bits (multiply, round, divide) and sample-and-hold at a reduced rate (hold each output value for sampleRate/crushRate samples). No buffering, no FFT."

---

### 12. Ring Modulator

Multiplies the audio signal by a sine wave at a configurable carrier frequency. This produces sum and difference frequencies that transform voice into metallic, robotic, or alien-sounding output — the classic "Dalek" effect.

**Use case:** Make any voice transmission sound like a robot or alien. Turn shortwave number stations into even more unsettling listening. Create strange, metallic textures from ordinary signals. The ring modulator is the quintessential "weird audio" effect.

**Implementation:** Per-sample multiplication by a sine oscillator. The output is `input * sin(2π * carrierHz * t)`, where `t` increments by `1/sampleRate` per sample. The phase accumulator wraps at 2π to prevent floating-point precision loss over long runs. This is a textbook DSB-SC (double-sideband suppressed-carrier) modulation — the same principle used in analog synthesizers and radio transmitters.

```go
type RingModulator struct {
    carrierHz  float64
    mix        float64    // 0.0–1.0, dry/wet balance
    sampleRate float64
    phase      float64    // current phase of the carrier oscillator
    phaseInc   float64    // phase increment per sample: 2π * carrierHz / sampleRate
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `carrier_hz` | 10–2000 | 300 | Carrier frequency in Hz. Low = tremolo-like, high = metallic/robotic |
| `mix` | 0.0–1.0 | 0.7 | Dry/wet balance. 0.0 = unaffected, 1.0 = fully modulated |

**Note on carrier frequency:** Below ~30 Hz, ring modulation produces a tremolo-like amplitude variation (the carrier is subsonic, so the ear perceives volume changes rather than tonal shifts). From 30–300 Hz, voice becomes recognizably "robotic." Above 300 Hz, the result is increasingly metallic and alien. The full range is exposed so users can explore the entire continuum.

**Performance:** One `sin()` call and one multiply per sample. Per-frame cost is ~4 µs (the `sin` call dominates). A lookup table or polynomial approximation could reduce this to ~2 µs, but it's already well within budget.

**Visualization: `ring-mod-scope.tsx`**

A dual-trace oscilloscope view. The top half shows the carrier sine wave (at the configured frequency), drawn as a clean repeating wave. The bottom half shows the modulated output waveform — the input signal multiplied by the carrier. This gives an intuitive visual of how the carrier "imprints" on the audio.

- **Canvas-based**, animated via `requestAnimationFrame`
- **Props:** `samplesRef: RefObject<Float32Array>`, `carrierHz: number`, `mix: number`, `height?: number`
- **Height:** 72px
- A horizontal center divider at `rgba(255,255,255,0.06)`
- Top half: carrier sine rendered at `hexToRgba(c, 0.25)` stroke, 1px
- Bottom half: modulated waveform at `hexToRgba(c, 0.15)` fill + `hexToRgba(c, 0.5)` stroke
- Carrier frequency shown top-right at `rgba(255,255,255,0.25)`, 9px

**Panel integration:**
```
┌─ Ring Modulator ────────────── [toggle] ────────┐
│ [carrier wave / modulated output scope]          │
│ Carrier  ──────●──────────────────  300 Hz       │
│ Mix      ──────────────●──────────  70%          │
└──────────────────────────────────────────────────┘
```

**FilterTip:**
- **what:** "Multiplies the audio by a sine wave carrier, producing metallic, robotic, or alien-sounding output."
- **when:** "Use for the classic 'Dalek' or 'robot voice' effect. Low carrier frequencies create a tremolo feel; mid frequencies produce the iconic robotic voice; high frequencies get alien and metallic."
- **how:** "Per-sample multiplication of the input by sin(2π·f·t). This is DSB-SC (double-sideband suppressed-carrier) modulation — it shifts every frequency in the input by ±carrierHz, destroying the harmonic relationships that make voice sound human."

---

### 13. Reverb

Adds artificial room/hall ambience to the signal using a feedback delay network. Simulates the sound of the transmission being received in a physical space — from a small room to a large cathedral.

**Use case:** Make shortwave broadcasts sound like they're echoing through a bunker or cathedral. Add spatial depth to flat, close-mic'd SDR audio. Create ambient soundscapes from band noise. The reverb transforms the "headphone in a box" feel of SDR listening into something with physical presence.

**Implementation:** Schroeder reverb architecture: four parallel comb filters feeding into two cascaded allpass filters. The comb filters create the dense early reflections; the allpass filters diffuse the reflections into a smooth tail. The delay lengths are chosen to be mutually prime (preventing metallic resonances) and scaled by the room size parameter.

```go
type Reverb struct {
    roomSize    float64    // 0.0–1.0, scales delay lengths
    damping     float64    // 0.0–1.0, high-frequency absorption per reflection
    mix         float64    // 0.0–1.0, dry/wet balance
    sampleRate  int

    combBufs    [4][]float64  // four parallel comb filter delay lines
    combPos     [4]int        // write positions
    combFilt    [4]float64    // one-pole low-pass state per comb (damping)

    apBufs      [2][]float64  // two series allpass filter delay lines
    apPos       [2]int        // write positions
}
```

The base comb delay lengths (in samples at 12 kHz) are 1116, 1188, 1277, 1356, and the allpass delays are 225 and 556. These are the classic Schroeder/Freeverb prime-ish values, scaled by `roomSize`. Damping is implemented as a one-pole low-pass filter inside each comb's feedback path — higher damping absorbs more high frequencies per reflection, simulating soft/absorptive room surfaces.

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `room_size` | 0.1–1.0 | 0.5 | Room size. Small = tight, short decay. Large = hall, long decay |
| `damping` | 0.0–1.0 | 0.5 | High-frequency absorption. Higher = warmer, darker reverb tail |
| `mix` | 0.0–1.0 | 0.3 | Dry/wet balance. 0.0 = dry only, 1.0 = fully wet |

**Performance:** Four comb filters + two allpass filters = six delay-line reads + writes per sample, plus one low-pass per comb (one multiply-add). Total buffer memory is ~5,000 samples (~40 KB). Per-frame cost is ~8–10 µs. Zero allocation in steady state.

**Visualization: `reverb-decay.tsx`**

An impulse response visualization showing the reverb's decay shape. A vertical spike on the left represents the dry impulse, followed by a dense cluster of reflections that fade out to the right. The decay envelope's length and density change in real-time as room size and damping are adjusted. This is a static visualization (not driven by live audio) that recomputes when parameters change — it shows what the reverb "sounds like" structurally.

- **Canvas-based**, redraws on parameter change
- **Props:** `roomSize: number`, `damping: number`, `mix: number`, `height?: number`
- **Height:** 72px
- The impulse response is computed by feeding a single-sample impulse through the reverb model and capturing ~500ms of output
- Drawn as vertical bars from center line at `hexToRgba(c, alpha)` where alpha is proportional to bar amplitude
- The dry spike is drawn at `hexToRgba(c, 0.7)`, reflections decay toward `hexToRgba(c, 0.08)`
- An exponential decay envelope overlay at `rgba(255,255,255,0.06)` shows the theoretical RT60
- Room size label top-right at `rgba(255,255,255,0.25)`, 9px

**Panel integration:**
```
┌─ Reverb ────────────────────── [toggle] ────────┐
│ [|░░▒▒▓▓▒▒░░░·····] impulse response decay      │
│ Room Size ──────────●──────────────  0.5         │
│ Damping   ──────────●──────────────  0.5         │
│ Mix       ──────●──────────────────  30%         │
└──────────────────────────────────────────────────┘
```

**FilterTip:**
- **what:** "Adds artificial room ambience, simulating the sound of the signal echoing in a physical space."
- **when:** "Use to add spatial depth and atmosphere. Small room sizes create a tight, boxy sound. Large sizes create cavernous, cathedral-like reverb. Great for ambient shortwave listening."
- **how:** "Schroeder/Freeverb architecture: four parallel comb filters with one-pole damping feed into two cascaded allpass diffusors. Delay lengths are mutually prime to prevent metallic coloring. Damping simulates high-frequency absorption in room surfaces."

---

### 14. Frequency Inverter (Voice Descrambler)

Mirrors the audio spectrum around a configurable center frequency — swaps high and low frequencies. This is not a novelty effect: frequency inversion is one of the oldest and most widely-used analog voice scrambling techniques in real radio systems. Inverting a scrambled signal with the correct center frequency recovers the original voice.

**Use case:** Decode voice-inversion scrambled transmissions. Many utility, marine, taxi dispatch, and amateur radio operators use simple frequency-inversion scramblers (sometimes called "speech inverters" or "privacy tones"). The scrambling is symmetric — applying the same inversion with the same center frequency both scrambles and descrambles. If you tune into a signal that sounds like garbled, backward-pitched speech, try enabling this filter and sweeping the center frequency until the voice becomes intelligible.

Also fun for making normal transmissions sound alien. Inverted speech has a distinctive "underwater backward" quality that's immediately recognizable.

**Implementation:** Per-sample multiplication by a cosine carrier at the center frequency, followed by a low-pass filter to remove the upper sideband. This is mathematically equivalent to mirroring the spectrum around `centerHz`. The process is:

1. Multiply each sample by `cos(2π * centerHz * t)` — this creates a sum and difference frequency for every spectral component.
2. Apply a low-pass filter at `centerHz` to keep only the difference frequencies (the mirrored spectrum).

The low-pass is a simple second-order Butterworth biquad, reusing the existing biquad infrastructure.

```go
type FrequencyInverter struct {
    centerHz    float64
    sampleRate  float64
    phase       float64   // cosine oscillator phase
    phaseInc    float64   // 2π * centerHz / sampleRate
    // Embedded biquad low-pass for sideband rejection
    lpf         biquadState
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `center_hz` | 500–5000 | 1700 | Inversion center frequency. Standard voice inversion scramblers use ~1700–3000 Hz |

**Why 1700 Hz default:** The most common analog voice inversion scramblers center around 1700 Hz (the ITU standard) or 3023 Hz (common in European utility radios). 1700 Hz is the best starting point for blind descrambling attempts.

**Performance:** One cosine call + one biquad pass per sample. Per-frame cost is ~5 µs. Zero allocation, no FFT required.

**Visualization: `freq-inverter-spectrum.tsx`**

A split-spectrum display. The left half shows the input spectrum normally. The right half shows the same spectrum mirrored around the center frequency, with a vertical dashed line marking the inversion point. As the center frequency changes, the mirror line moves and the reflected spectrum shifts accordingly. Tonal peaks visually "flip" across the center line.

- **Canvas-based**, animated via `requestAnimationFrame`
- **Props:** `samplesRef: RefObject<Float32Array>`, `centerHz: number`, `height?: number`
- **Height:** 72px
- Input spectrum drawn at `hexToRgba(c, 0.08)` fill + `hexToRgba(c, 0.2)` stroke (ghosted)
- Inverted output spectrum drawn at `hexToRgba(c, 0.15)` fill + `hexToRgba(c, 0.5)` stroke
- Center frequency marker: vertical dashed line at `rgba(251, 146, 60, 0.6)`, 1.5px, `[3,3]` dash
- Frequency value top-right at `rgba(255,255,255,0.25)`, 9px
- Uses the same FFT helper as `autonotch-meter.tsx`

**Panel integration:**
```
┌─ Frequency Inverter ────────── [toggle] ────────┐
│ [spectrum ─ ─ ─|─ ─ ─ mirrored spectrum]         │
│ Center   ──────────●──────────────  1700 Hz      │
└──────────────────────────────────────────────────┘
```

**FilterTip:**
- **what:** "Mirrors the audio spectrum around a center frequency — swaps high and low frequencies. Also known as a voice descrambler."
- **when:** "Use to decode voice-inversion scrambled transmissions (garbled, backward-sounding speech). Common on utility, marine, and taxi radio. Also fun for making normal speech sound alien. Try sweeping the center frequency until scrambled speech becomes intelligible."
- **how:** "Per-sample multiplication by cos(2π·f·t) followed by a low-pass biquad at the center frequency. This mirrors the spectrum: a component at centerHz+Δ becomes centerHz-Δ. The same operation both scrambles and descrambles — it's symmetric."

---

### 15. Chorus

Thickens the audio by mixing the original signal with one or more slightly delayed, pitch-modulated copies. Creates a shimmering, ensemble-like quality — as if multiple receivers are tuned to the same frequency with slight detuning.

**Use case:** Make a single voice transmission sound richer and fuller. Add a dreamy, ethereal quality to shortwave music broadcasts. Give CW tones a warm, detuned "analog synth" character. Subtle chorus settings add life without being obviously effected; heavy settings create a lush, watery wash.

**Implementation:** Two delayed copies of the input, each with an independent LFO (low-frequency oscillator) modulating the delay time. The modulating delay creates a continuously-varying pitch shift that, when mixed with the dry signal, produces the characteristic chorus shimmer. The LFOs use different rates to avoid periodicity.

```go
type Chorus struct {
    rate       float64    // LFO speed in Hz
    depth      float64    // LFO depth in ms (how far the delay swings)
    mix        float64    // 0.0–1.0, dry/wet
    sampleRate int

    buf        []float64  // delay line (sized for max depth + margin)
    writePos   int
    lfoPhase   [2]float64 // two LFOs at slightly different rates
    lfoInc     [2]float64 // phase increment per sample
    depthSamp  float64    // depth converted to samples
    baseSamp   float64    // base delay in samples (center of LFO swing)
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `rate` | 0.1–5.0 | 0.8 | LFO speed in Hz. Slower = gentle shimmer, faster = vibrato |
| `depth` | 0.5–20.0 | 5.0 | Modulation depth in ms. Higher = more detuning, more obvious effect |
| `mix` | 0.0–1.0 | 0.5 | Dry/wet balance |

**Performance:** Two interpolated reads from the delay buffer per sample (one per voice), two LFO phase increments. Per-frame cost is ~5 µs. Delay buffer is ~480 samples (~4 KB) for a 20 ms maximum depth with margin. Zero allocation in steady state.

**Visualization: `chorus-wave.tsx`**

A triple-waveform display. The center (dry) waveform is drawn dimly. Two modulated copies are drawn slightly offset vertically and horizontally, with the horizontal offset oscillating gently at the LFO rate, creating a visual sense of the detuning motion. The three traces overlap and interweave, directly conveying the "ensemble" effect.

- **Canvas-based**, animated via `requestAnimationFrame`
- **Props:** `samplesRef: RefObject<Float32Array>`, `rate: number`, `depth: number`, `mix: number`, `height?: number`
- **Height:** 72px
- Dry waveform at center: `hexToRgba(c, 0.1)` stroke, 1px
- Voice 1: drawn with a slow horizontal phase offset, `hexToRgba(c, 0.3)` stroke, 1px
- Voice 2: drawn with a different phase offset, `hexToRgba(c, 0.3)` stroke, 1px
- All three fill below at `hexToRgba(c, 0.04)` each
- Rate value top-right at `rgba(255,255,255,0.25)`, 9px

**Panel integration:**
```
┌─ Chorus ────────────────────── [toggle] ────────┐
│ [~~~ three interweaving waveforms ~~~]            │
│ Rate     ──────●──────────────────  0.8 Hz       │
│ Depth    ──────────●──────────────  5.0 ms       │
│ Mix      ──────────●──────────────  50%          │
└──────────────────────────────────────────────────┘
```

**FilterTip:**
- **what:** "Adds slightly detuned, delayed copies of the signal, creating a shimmering, ensemble-like thickening effect."
- **when:** "Use to add richness and warmth. Subtle settings add a gentle shimmer to voice or music. Heavy settings create a lush, watery, 80s-soundtrack quality. Makes single tones sound like a detuned synth."
- **how:** "Two delay lines with LFO-modulated read positions. The continuously varying delay creates micro pitch shifts that, when mixed with the dry signal, produce constructive/destructive interference patterns perceived as chorus. LFOs run at slightly different rates to avoid periodicity."

---

### 16. Phaser

Sweeps a series of allpass filters through the frequency spectrum, creating moving notches that produce the classic "jet flyby" or "swooshing" effect. Similar in spirit to the autonotch, but here the notches move continuously by design rather than locking onto interference.

**Use case:** Add a rhythmic, sweeping quality to any signal. Particularly effective on broadband noise or music — the moving notches create a psychedelic, spacey texture. On voice, a slow phaser adds a subtle, otherworldly quality. Fast phaser on shortwave noise creates a surprisingly hypnotic ambient texture.

**Implementation:** A cascade of second-order allpass filters whose center frequencies are modulated by a shared LFO. Each allpass stage adds a frequency-dependent phase shift. When the allpass output is mixed with the dry signal, frequencies where the phase shift is 180° cancel out, creating notches. As the LFO sweeps the allpass frequencies, the notches move through the spectrum.

```go
type Phaser struct {
    rate       float64    // LFO speed in Hz
    depth      float64    // 0.0–1.0, how far the allpass frequencies sweep
    stages     int        // number of allpass stages (2, 4, 6, or 8)
    mix        float64    // dry/wet
    sampleRate float64

    lfoPhase   float64
    lfoInc     float64
    // Per-stage allpass state
    ap         []allpassState
    minFreq    float64    // LFO sweep range lower bound (Hz)
    maxFreq    float64    // LFO sweep range upper bound (Hz)
}

type allpassState struct {
    a1     float64 // allpass coefficient (recomputed each sample from LFO)
    x1, y1 float64 // first-order allpass delay
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `rate` | 0.05–5.0 | 0.3 | LFO sweep speed in Hz. Slow = gentle sweep, fast = helicopter effect |
| `depth` | 0.0–1.0 | 0.7 | Sweep depth. How far the notch frequencies travel |
| `stages` | 2, 4, 6, 8 | 4 | Number of allpass stages. More stages = more notches, deeper effect |
| `mix` | 0.0–1.0 | 0.5 | Dry/wet balance |

**Note on stages:** 2 stages create one notch, 4 create two, 6 create three, 8 create four. More notches produce a thicker, more obvious effect. The classic analog phaser sound is 4–6 stages. 8 stages starts to sound like a flanger.

**Performance:** Per-stage: one allpass coefficient computation (from LFO position) + one first-order allpass per sample. For 8 stages: ~8 multiply-adds per sample. Per-frame cost is ~6 µs for 8 stages. The LFO triggers a coefficient recalculation, but it's a single `cos()` call shared across all stages. Zero allocation.

**Visualization: `phaser-sweep.tsx`**

A frequency-domain view showing the moving notch pattern. The spectrum is drawn normally, with dark vertical bands indicating where the current allpass phase cancellation is producing notches. The bands sweep left-right in sync with the LFO, creating an animated "barber pole" or "comb sweeping" effect. The number of notch bands matches the number of stages / 2.

- **Canvas-based**, animated via `requestAnimationFrame`
- **Props:** `samplesRef: RefObject<Float32Array>`, `rate: number`, `depth: number`, `stages: number`, `height?: number`
- **Height:** 72px
- Background spectrum drawn at `hexToRgba(c, 0.08)` fill + `hexToRgba(c, 0.2)` stroke (same FFT as autonotch)
- Notch bands: vertical semi-transparent overlay at `rgba(0,0,0,0.3)`, width proportional to Q, position animated by LFO
- Number of bands = `stages / 2`
- A thin horizontal line at the LFO position mapped to a visual indicator, `rgba(255,255,255,0.1)`
- Stage count top-right at `rgba(255,255,255,0.25)`, 9px (e.g. "4 stg")

**Panel integration:**
```
┌─ Phaser ────────────────────── [toggle] ────────┐
│ [spectrum with sweeping dark notch bands]         │
│ Rate     ──────●──────────────────  0.3 Hz       │
│ Depth    ──────────────●──────────  0.7          │
│ Stages   ────────●────────────────  4            │
│ Mix      ──────────●──────────────  50%          │
└──────────────────────────────────────────────────┘
```

**FilterTip:**
- **what:** "Sweeps a series of frequency notches through the spectrum, creating a classic 'jet flyby' or 'swooshing' effect."
- **when:** "Use for a psychedelic, sweeping texture. Slow settings add subtle movement to voice or noise. Fast settings create a dramatic helicopter/jet sound. Particularly hypnotic on broadband shortwave noise."
- **how:** "Cascade of first-order allpass filters with LFO-modulated coefficients. Mixing the allpass output with the dry signal creates frequency-dependent cancellation (notches). As the LFO sweeps, the notches move through the spectrum. More stages = more simultaneous notches."

---

### 17. Wobble

A low-frequency oscillator (LFO) modulates the cutoff frequency of a resonant low-pass filter, producing the characteristic "wub-wub-wub" sound popularized by dubstep and EDM. Turns any radio signal into something that sounds like it's being played through a subwoofer in a nightclub.

**Use case:** Make absolutely anything sound like dubstep. Shortwave number stations become dystopian bass drops. Weather broadcasts become rave anthems. Aviation comms become underground electronic music. This filter has zero practical utility and maximum entertainment value.

**Implementation:** A state-variable filter (SVF) configured as a resonant low-pass, with its cutoff frequency modulated by a sine LFO. The SVF is preferred over a biquad here because it allows smooth, per-sample cutoff changes without the coefficient instability that biquads exhibit when modulated rapidly. The LFO sweeps the cutoff between a base frequency and `base + range` Hz.

```go
type Wobble struct {
    rate       float64   // LFO speed in Hz
    range_     float64   // LFO sweep range in Hz (how far cutoff swings)
    resonance  float64   // 0.0–1.0, filter resonance (Q)
    baseHz     float64   // lowest cutoff frequency
    sampleRate float64

    lfoPhase   float64
    lfoInc     float64
    // SVF state
    low        float64   // low-pass output
    band       float64   // band-pass output
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `rate` | 0.1–10.0 | 2.0 | Wobble speed in Hz. The "wub" frequency |
| `range` | 100–4000 | 2000 | How far the cutoff sweeps in Hz |
| `resonance` | 0.0–0.95 | 0.5 | Filter resonance. Higher = sharper, more aggressive wobble peak |
| `base_hz` | 100–2000 | 200 | Lowest cutoff frequency (bottom of the sweep) |

**Why cap resonance at 0.95:** At resonance >= 1.0, the SVF self-oscillates — the filter starts producing its own tone independent of the input, which can overwhelm the signal and potentially clip. 0.95 gives a dramatic, aggressive peak without self-oscillation.

**Performance:** One SVF computation per sample (two multiply-adds + one LFO phase increment). Per-frame cost is ~4 µs. Zero allocation, zero buffers beyond two state variables.

**Visualization: `wobble-sweep.tsx`**

An animated filter response curve. The low-pass cutoff visually sweeps back and forth across the frequency axis at the LFO rate. The resonance peak (a bump at the cutoff) grows and shrinks with the resonance parameter. Behind the sweeping curve, a faint spectrum of the input signal provides context for what's being filtered.

- **Canvas-based**, animated via `requestAnimationFrame`
- **Props:** `samplesRef: RefObject<Float32Array>`, `rate: number`, `rangeHz: number`, `resonance: number`, `baseHz: number`, `height?: number`
- **Height:** 72px
- Background input spectrum at `hexToRgba(c, 0.06)` fill (same FFT as autonotch)
- Animated filter response curve: `hexToRgba(c, 0.12)` fill + `hexToRgba(c, 0.5)` stroke, 1.5px
- The curve is a SVF low-pass magnitude response, recomputed each frame with the current LFO-modulated cutoff
- Resonance peak visually exaggerated for clarity
- Rate value top-right at `rgba(255,255,255,0.25)`, 9px (e.g. "2.0 Hz")

**Panel integration:**
```
┌─ Wobble ────────────────────── [toggle] ────────┐
│ [~~sweeping filter curve over faint spectrum~~]   │
│ Rate      ──────────●──────────────  2.0 Hz      │
│ Range     ──────────────●──────────  2000 Hz     │
│ Resonance ──────────●──────────────  0.5         │
│ Base      ────●────────────────────  200 Hz      │
└──────────────────────────────────────────────────┘
```

**FilterTip:**
- **what:** "Modulates a resonant low-pass filter at a configurable rate, producing a rhythmic 'wub-wub-wub' wobble effect."
- **when:** "Use to make literally anything sound like dubstep. Zero practical utility, maximum entertainment value. Works best on signals with broadband content (noise, music, SSB voice)."
- **how:** "State-variable filter (SVF) with LFO-modulated cutoff. The SVF is preferred over a biquad because it handles rapid per-sample cutoff changes without coefficient instability. Resonance adds a sharp peak at the cutoff that emphasizes the sweep."

---

### 18. Tape Saturator

Simulates the sonic characteristics of analog magnetic tape recording: gentle harmonic saturation, subtle pitch instability (wow and flutter), and soft high-frequency rolloff. Adds a warm, vintage quality that makes digital SDR audio feel more organic and "analog."

**Use case:** Warm up the clinical sound of digital SDR reception. Add vintage character to shortwave music broadcasts. Make utility transmissions sound like they're being recorded on a 1970s reel-to-reel. The wow/flutter component adds a gentle, nostalgic pitch drift that makes everything sound like it's playing from old tape.

**Implementation:** Three stages applied in series:

1. **Saturation:** Asymmetric soft clipping using a polynomial curve that mimics tape's characteristic even-harmonic distortion. Unlike the soft clipper (which uses symmetric tanh), tape saturation boosts even harmonics (warm-sounding 2nd, 4th) more than odd harmonics (harsh 3rd, 5th).
2. **Wow & Flutter:** A compound LFO (slow "wow" at 0.5–2 Hz + fast "flutter" at 5–10 Hz) modulates a very short delay line, creating subtle pitch variation. The delay modulation is tiny (< 1 ms) — enough to be felt as warmth/instability but not enough to sound like a broken player.
3. **High-frequency rolloff:** A gentle one-pole low-pass filter that simulates tape's natural high-frequency loss. The rolloff frequency decreases at higher drive settings, mimicking how hotter tape signals suffer more HF loss.

```go
type TapeSaturator struct {
    drive       float64   // 0.0–1.0, saturation amount
    wowFlutter  float64   // 0.0–1.0, pitch instability amount
    sampleRate  int

    // Wow LFO (slow)
    wowPhase    float64
    wowInc      float64   // ~0.5–2 Hz
    // Flutter LFO (fast)
    flutterPhase float64
    flutterInc   float64  // ~5–10 Hz
    // Short delay line for wow/flutter
    delayBuf    []float64
    writePos    int
    // HF rolloff one-pole state
    lpState     float64
    lpCoeff     float64
}
```

**Parameters:**
| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| `drive` | 0.0–1.0 | 0.4 | Saturation amount. Low = subtle warmth, high = obvious tape compression |
| `wow_flutter` | 0.0–1.0 | 0.3 | Pitch instability. Low = barely perceptible drift, high = wobbly old tape |

**Performance:** Saturation is a polynomial evaluation (3 multiply-adds). Wow/flutter is two LFO increments + one interpolated delay read/write. HF rolloff is one multiply-add. Per-frame cost is ~6 µs. Delay buffer is ~24 samples (~192 bytes) for max 2 ms flutter depth. Zero steady-state allocation.

**Visualization: `tape-saturator-curve.tsx`**

A transfer curve display (like the soft clipper) showing the asymmetric saturation shape, combined with a small animated waveform inset in the corner that wobbles at the wow/flutter rate. The transfer curve shows the asymmetric polynomial — positive peaks are compressed differently than negative peaks, visually distinct from the symmetric tanh of the soft clipper.

- **Canvas-based**, redraws on parameter change (transfer curve) with animated flutter inset
- **Props:** `drive: number`, `wowFlutter: number`, `height?: number`
- **Height:** 72px
- Unity diagonal at `rgba(255,255,255,0.08)`, 1px
- Asymmetric saturation curve at `hexToRgba(c, 0.12)` fill + `hexToRgba(c, 0.5)` stroke, 1.5px
- The positive half of the curve saturates earlier/harder than the negative half (asymmetry)
- Small inset (bottom-right, ~20x20px): a sine wave that visually wobbles in period, animated at wow rate
- Drive value top-right at `rgba(255,255,255,0.25)`, 9px

**Panel integration:**
```
┌─ Tape Saturator ────────────── [toggle] ────────┐
│ [asymmetric curve ~~~~~~~~~ + wobble inset]       │
│ Drive       ────────●──────────────  0.4         │
│ Wow/Flutter ──────●────────────────  0.3         │
└──────────────────────────────────────────────────┘
```

**FilterTip:**
- **what:** "Simulates analog magnetic tape: warm saturation, gentle pitch drift, and soft high-frequency rolloff."
- **when:** "Use to add vintage warmth and organic character. Low drive adds subtle harmonic richness. High drive compresses and colors like hot tape. Wow/flutter adds nostalgic pitch instability — like a well-loved cassette player."
- **how:** "Three stages: asymmetric polynomial saturation (even-harmonic distortion), compound LFO-modulated micro-delay (wow at ~1 Hz + flutter at ~7 Hz), and adaptive one-pole HF rolloff. The asymmetric curve produces warm even harmonics unlike the symmetric tanh of the soft clipper."

---

### Fun Filter Chain Ordering

Fun filters execute after all cleanup filters, in a fixed order chosen to produce the most natural-sounding (or most interestingly-weird-sounding) results:

```
 1. Noise Blanker       ← impulse cleanup
 2. High-Pass           ← remove DC/hum
 3. Notch               ← kill known tones
 4. Autonotch           ← kill unknown tones
 5. Noise Reducer       ← spectral cleanup
 6. Noise Gate          ← silence gaps
 7. Low-Pass            ← shape bandwidth
 8. Soft Clipper        ← tame peaks
 ── cleanup complete, fun begins ──
 9. Frequency Inverter  ← spectral flip first (works on the full clean spectrum)
10. Pitch Shifter       ← shift pitch before spatial effects
11. Ring Modulator      ← modulate the pitch-shifted signal
12. Wobble              ← LFO filter sweep (after ring mod so it sweeps the sidebands)
13. Chorus              ← thicken the processed signal with detuned copies
14. Bitcrusher          ← quantize after all tonal processing
15. Tape Saturator      ← warm saturation + wow/flutter (color the final signal)
16. Phaser              ← sweep notches through the saturated signal
17. Echo                ← delay-based, echo the fully colored result
18. Reverb              ← spatial, applied last so it envelops everything
```

**Rationale for ordering:**
- Frequency inverter first among fun filters: it operates on the spectral structure of the signal and should see the full clean spectrum before any creative distortion.
- Pitch shifting before ring modulation: shifting first, then ring-modulating, produces a coherent "robot voice at different pitch." Reversing this pitch-shifts the sidebands awkwardly.
- Wobble after ring mod: the LFO filter sweep applied to ring-modulated content creates richer harmonic movement than wobbling first.
- Chorus before bitcrusher: chorus creates smooth detuned copies; crushing them produces interesting textured crunch. Crushing first and then chorusing would chorus the quantization artifacts.
- Tape saturator before phaser: the saturation adds harmonics that the phaser's sweeping notches can then act on, creating a richer phasing effect.
- Bitcrusher after tonal processing: crushing the ring-modulated, wobbled, chorused signal adds crunch to the full harmonic content.
- Echo before reverb: echoes are distinct, separated repeats; reverb is diffuse. Reverb wrapping each echo sounds natural. Echo of reverb tails sounds washy and unnatural.
- Phaser between saturator and echo: the sweeping notches act on the harmonically-enriched signal, and the echoed/reverbed result preserves the sweep motion naturally.

### Fun Filter Configuration Model

Add to the existing `FilterConfig` struct:

```go
type FilterConfig struct {
    // ... existing cleanup filters ...
    FreqInverter   *FreqInverterConfig   `json:"freq_inverter,omitempty"`
    PitchShifter   *PitchShifterConfig   `json:"pitch_shifter,omitempty"`
    Echo           *EchoConfig           `json:"echo,omitempty"`
    Bitcrusher     *BitcrusherConfig     `json:"bitcrusher,omitempty"`
    RingModulator  *RingModulatorConfig  `json:"ring_modulator,omitempty"`
    Reverb         *ReverbConfig         `json:"reverb,omitempty"`
    Chorus         *ChorusConfig         `json:"chorus,omitempty"`
    Phaser         *PhaserConfig         `json:"phaser,omitempty"`
    Wobble         *WobbleConfig         `json:"wobble,omitempty"`
    TapeSaturator  *TapeSaturatorConfig  `json:"tape_saturator,omitempty"`
}

type FreqInverterConfig struct {
    Enabled  bool    `json:"enabled"`
    CenterHz float64 `json:"center_hz"`
}

type PitchShifterConfig struct {
    Enabled   bool    `json:"enabled"`
    Semitones float64 `json:"semitones"`
}

type EchoConfig struct {
    Enabled  bool    `json:"enabled"`
    DelayMs  float64 `json:"delay_ms"`
    Feedback float64 `json:"feedback"`
    Mix      float64 `json:"mix"`
}

type BitcrusherConfig struct {
    Enabled   bool    `json:"enabled"`
    Bits      int     `json:"bits"`
    CrushRate float64 `json:"crush_rate"`
}

type RingModulatorConfig struct {
    Enabled   bool    `json:"enabled"`
    CarrierHz float64 `json:"carrier_hz"`
    Mix       float64 `json:"mix"`
}

type ReverbConfig struct {
    Enabled  bool    `json:"enabled"`
    RoomSize float64 `json:"room_size"`
    Damping  float64 `json:"damping"`
    Mix      float64 `json:"mix"`
}

type ChorusConfig struct {
    Enabled bool    `json:"enabled"`
    Rate    float64 `json:"rate"`
    Depth   float64 `json:"depth"`
    Mix     float64 `json:"mix"`
}

type PhaserConfig struct {
    Enabled bool    `json:"enabled"`
    Rate    float64 `json:"rate"`
    Depth   float64 `json:"depth"`
    Stages  int     `json:"stages"`
    Mix     float64 `json:"mix"`
}

type WobbleConfig struct {
    Enabled   bool    `json:"enabled"`
    Rate      float64 `json:"rate"`
    Range     float64 `json:"range"`
    Resonance float64 `json:"resonance"`
    BaseHz    float64 `json:"base_hz"`
}

type TapeSaturatorConfig struct {
    Enabled    bool    `json:"enabled"`
    Drive      float64 `json:"drive"`
    WowFlutter float64 `json:"wow_flutter"`
}
```

No database migration needed — the existing `filters` JSONB column absorbs new keys automatically. Old rows simply don't have the new fields, which unmarshal as `nil` (disabled).

### Fun Filter Performance Budget

| Filter | Per-Frame Cost | Memory | Notes |
|--------|---------------|--------|-------|
| Frequency Inverter | ~5 µs | 0 | cos() + biquad per sample |
| Pitch Shifter | ~12 µs | ~8 KB | Grain buffer + Hann window table |
| Ring Modulator | ~4 µs | 0 | sin() per sample + phase accumulator |
| Wobble | ~4 µs | 0 | SVF + LFO per sample |
| Chorus | ~5 µs | ~4 KB | Delay line + 2 LFOs |
| Bitcrusher | ~2 µs | 0 | Stateless quantize + hold |
| Tape Saturator | ~6 µs | ~192 B | Polynomial + micro-delay + one-pole |
| Phaser | ~6 µs | 0 | 8 allpass stages + LFO |
| Echo | ~3 µs | ~96 KB | Delay buffer (1s at 12 kHz × 8 bytes) |
| Reverb | ~10 µs | ~40 KB | 4 comb + 2 allpass delay lines |
| **All fun filters** | **~57 µs** | **~148 KB** | |
| **Full chain (cleanup + fun)** | **~119 µs** | | **< 0.29% of 42 ms frame budget** |

All fun filters are zero-allocation in steady state. Total memory for all delay buffers is ~148 KB per stream — negligible even with dozens of concurrent streams.

### Fun Filter Frontend Files

| File | Purpose |
|------|---------|
| `internal/filter/freqinvert.go` | Frequency inverter / voice descrambler |
| `internal/filter/pitch.go` | Granular pitch shifter |
| `internal/filter/echo.go` | Feedback delay line |
| `internal/filter/bitcrusher.go` | Bit depth + sample rate reduction |
| `internal/filter/ringmod.go` | Ring modulator (sine carrier) |
| `internal/filter/reverb.go` | Schroeder reverb (4 comb + 2 allpass) |
| `internal/filter/chorus.go` | LFO-modulated delay chorus |
| `internal/filter/phaser.go` | Allpass cascade with LFO sweep |
| `internal/filter/wobble.go` | LFO-modulated resonant SVF |
| `internal/filter/tape.go` | Tape saturator (saturation + wow/flutter + rolloff) |
| `frontend/src/components/freq-inverter-spectrum.tsx` | Split mirrored spectrum visualization |
| `frontend/src/components/pitch-shifter-wave.tsx` | Waveform overlay visualization |
| `frontend/src/components/echo-trail.tsx` | Decaying echo tap visualization |
| `frontend/src/components/bitcrusher-wave.tsx` | Staircase vs. smooth waveform |
| `frontend/src/components/ring-mod-scope.tsx` | Dual-trace carrier + modulated output |
| `frontend/src/components/reverb-decay.tsx` | Impulse response decay visualization |
| `frontend/src/components/chorus-wave.tsx` | Triple interweaving waveform |
| `frontend/src/components/phaser-sweep.tsx` | Spectrum with sweeping notch bands |
| `frontend/src/components/wobble-sweep.tsx` | Animated sweeping filter curve |
| `frontend/src/components/tape-saturator-curve.tsx` | Asymmetric transfer curve + wobble inset |

### Fun Filter Implementation Order

| Step | Task | Scope | Depends On |
|------|------|-------|------------|
| 1 | Bitcrusher (simplest, good smoke test) | Backend | Nothing |
| 2 | Ring Modulator | Backend | Nothing |
| 3 | Frequency Inverter (reuses biquad infra) | Backend | Nothing |
| 4 | Echo | Backend | Nothing |
| 5 | Wobble (SVF + LFO) | Backend | Nothing |
| 6 | Chorus | Backend | Nothing |
| 7 | Phaser | Backend | Nothing |
| 8 | Tape Saturator | Backend | Nothing |
| 9 | Pitch Shifter | Backend | Nothing |
| 10 | Reverb (most complex) | Backend | Nothing |
| 11 | Add all fun filter configs to `FilterConfig` model + `BuildFilters` | Backend | Steps 1–10 |
| 12 | Tests for all fun filters | Backend | Steps 1–10 |
| 13 | Frontend visualization components + panel sections | Frontend | Steps 1–10 |

Steps 1–10 are fully independent — all ten backend filters can be developed in parallel. Frequency Inverter (step 3) is prioritized because it has real utility for SDR users.

**Recommended sequencing:** Build Bitcrusher first (simplest, integration smoke test). Then Frequency Inverter (actual SDR utility — will get real use). Then Ring Modulator and Echo (both simple). Wobble, Chorus, Phaser, and Tape Saturator are medium complexity. Pitch Shifter and Reverb are the most complex and should come last.

---

## Future Considerations

**Preset system.** Once filters are proven, add named presets ("Voice Clean", "CW Narrow", "DX Weak Signal") that set multiple filter parameters at once. Fun filter presets could include "Robot Voice" (ring mod 300 Hz + pitch -3), "Numbers Station" (pitch -5 + reverb 0.8 + echo 500ms), "Glitch Radio" (bitcrusher 4-bit + crush 2000 Hz). This is a pure frontend/API concern — the backend just sees a `FilterConfig` regardless of whether it came from a preset or manual parameter adjustment.

**Per-client filters.** The current design applies filters server-side to all clients identically. A future extension could allow per-client filtering (e.g., one client wants noise reduction, another doesn't). This would require moving the filter chain from the pump (one per stream) to the subscriber goroutine (one per client). The same `Chain` abstraction works — it just runs in a different goroutine. The ring buffer would store unfiltered audio, and each subscriber would get its own filtered copy. This is a significant architectural change and is explicitly out of scope for this plan.

**Filter metering.** Expose per-filter metrics (input/output RMS, gain reduction amount for noise gate, noise floor estimate for noise reduction) via the WebSocket. This enables a frontend visualization of what each filter is doing — useful for tuning parameters. Not needed for the initial implementation.
