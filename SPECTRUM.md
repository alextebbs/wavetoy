# Spectrum Analyzer Implementation Plan

## Overview

Add a real-time spectrum analyzer (line graph) to the stream player page, displayed above the waterfall chart. The spectrum shows the current FFT data as a filled-area plot: frequency on the X axis, signal strength (dB) on the Y axis. This gives an instant visual readout of signal strength across the band — the waterfall shows history over time, the spectrum shows the current moment.

---

## Key Insight: Same Data as Waterfall

The spectrum display uses **the exact same W/F data** as the waterfall. No additional backend work is needed. In the KiwiSDR frontend (`tmp_kiwisdr/web/openwebrx/openwebrx.js`), both the spectrum and waterfall are rendered inside the same `waterfall_add()` function using the same `data` array (1024 uint8 magnitude bins):

```javascript
// line 5185-5188: spectrum uses same data as waterfall
if (spec.source == spec.RF && spec.update != spec.last_update) {
   spectrum_update(data);  // same data array
}

// line 5190+: waterfall rendering uses same data array
var oneline_image = canvas.oneline_image;
for (x=0; x<w; x++) {
   z = color_index(data[x], wf.sqrt);
   // ... write to waterfall canvas
}
```

This means the spectrum is a **frontend-only addition** that depends on the waterfall backend work being completed first (see `WATERFALL.md`). Once W/F data is flowing to the browser, adding the spectrum is purely a rendering task.

---

## How KiwiSDR Does It

### Architecture

KiwiSDR's spectrum display (`spectrum_update()`, lines 4551-4787 in `openwebrx.js`) uses:

- A **200px tall** canvas above the waterfall (`spec.height_spectrum_canvas: 200`)
- Three separate canvases layered on top of each other:
  - `spec.canvas` — the main spectrum trace (filled area graph)
  - `spec.pb_canvas` — passband marker overlay (semi-transparent rectangle showing demodulation bandwidth)
  - `spec.af_canvas` — audio frequency spectrum (alternative view using audio FFT data)
- A **dB scale** on the right side with labeled 10 dB bands
- **Two peak hold traces** (yellow and magenta) that track maximum signal levels
- **IIR/MMA/EMA filtering** for smoothing the spectrum display (same filters as the waterfall aperture system)
- **10 Hz update rate** via `setInterval` (independent of waterfall update rate)

### Rendering Method

For each of the 1024 bins:
1. Map the bin value through `color_index()` to get a 0-255 index (same as waterfall)
2. Apply optional averaging filter (IIR/MMA/EMA)
3. Convert to Y position: `y = Math.round((1 - z/255) * canvas_height)`
4. Draw a 1-pixel-wide filled rectangle from Y to the bottom of the canvas, colored by the dB band it falls in

The dB-band coloring means different signal strength ranges get different colors (e.g., strong signals in red, weak in blue), providing visual separation beyond just height.

### Modes

KiwiSDR's spectrum has three modes (toggled by clicking the spectrum area):
- **NONE** (0) — spectrum hidden
- **RF** (1) — shows the RF spectrum from W/F data (full receiver bandwidth)
- **AF** (2) — shows the audio spectrum from local audio FFT (demodulated audio bandwidth)

### Performance Weaknesses

| Issue | Detail |
|-------|--------|
| Per-pixel `fillRect` | Draws 1024 individual 1px-wide rectangles per frame |
| `setInterval` at 10 Hz | Not synced with display refresh |
| Multiple canvases | Three overlapping canvases for one display |
| Full redraw every frame | Clears and redraws the entire canvas including grid lines |

---

## Our Implementation

### Data Flow

```
W/F WebSocket data (type 0x01)
  │
  ├──→ WaterfallDisplay.pushBins(bins)     (existing, from WATERFALL.md)
  │
  └──→ SpectrumDisplay.pushBins(bins)      (new, same data)
```

The stream player page forwards the same bin array to both components. No data duplication — both get a reference to the same `Uint8Array`.

### New Files

| File | Purpose |
|------|---------|
| `frontend/src/components/spectrum/spectrum-display.tsx` | React component: canvas, resize, cleanup |
| `frontend/src/components/spectrum/spectrum-renderer.ts` | Imperative rendering class |

The spectrum renderer reuses the color map LUT and dB range mapping from the waterfall's `color-maps.ts` and `types.ts`.

### Component Architecture

```
┌──────────────────────────────────────────────────────┐
│ StreamPlayerPage                                     │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ SpectrumDisplay (above waterfall)              │  │
│  │  - Single <canvas>, 150-200px tall             │  │
│  │  - Filled area graph of current FFT bins       │  │
│  │  - dB grid lines with labels                   │  │
│  │  - Passband overlay rectangle                  │  │
│  │  - Optional peak hold trace                    │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │ WaterfallDisplay (existing, from WATERFALL.md) │  │
│  │  - Scrolling spectrogram                       │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  [frequency display, controls, etc.]                 │
└──────────────────────────────────────────────────────┘
```

### Rendering Strategy (Modernizations vs KiwiSDR)

#### Single Canvas (vs Three Overlapping Canvases)

KiwiSDR layers three canvases: spectrum trace, passband overlay, and AF spectrum. This is unnecessary DOM complexity.

**Our approach:** Single canvas. Draw in order: background → grid lines → passband overlay → spectrum fill → peak hold trace. The passband overlay uses `globalAlpha` for transparency.

#### `Path2D` Filled Area (vs 1024 Individual `fillRect` Calls)

KiwiSDR draws one 1px-wide `fillRect` per bin. That's 1024 draw calls per frame.

**Our approach:** Build the spectrum shape as a single `Path2D` using `moveTo`/`lineTo`, then `fill()` once. This is a single GPU-accelerated draw call instead of 1024.

```typescript
const path = new Path2D();
path.moveTo(0, canvasHeight);
for (let x = 0; x < numBins; x++) {
  const dbm = bins[x] - 255;
  const norm = clamp((dbm - minLevel) / (maxLevel - minLevel), 0, 1);
  const y = (1 - norm) * canvasHeight;
  path.lineTo(x * xScale, y);
}
path.lineTo(canvasWidth, canvasHeight);
path.closePath();
ctx.fillStyle = spectrumGradient;
ctx.fill(path);
```

#### Gradient Fill (vs dB-Band Rectangles)

KiwiSDR colors each bin's column based on which 10 dB band it falls in, requiring per-pixel band lookups.

**Our approach:** Use a vertical `CanvasGradient` that maps the Y axis to a color gradient (e.g., blue at the bottom / noise floor → green in the middle → red at the top / strong signals). Applied once as `fillStyle` before the single `fill()` call. Zero per-pixel color logic.

#### `requestAnimationFrame` (vs `setInterval`)

KiwiSDR uses `setInterval` at 10 Hz regardless of display refresh or data arrival.

**Our approach:** The spectrum updates on each `requestAnimationFrame` tick, in the same rAF loop as the waterfall. When new bins arrive, both waterfall and spectrum are rendered in the same frame. No separate timer.

#### Shared rAF Loop with Waterfall

Since the spectrum and waterfall use the same data and update at the same time, they should share a render loop rather than each running their own. The stream player page can coordinate: when new bins arrive, queue them for both components, and a single rAF callback renders both.

### SpectrumRenderer Class

Core imperative class, ~100 lines. Key methods:

| Method | Purpose |
|--------|---------|
| `constructor(canvas, options)` | Set up context, gradient, grid geometry |
| `setLevels(min, max)` | Update dB range, rebuild gradient and grid |
| `pushBins(bins: Uint8Array)` | Store latest bins and mark dirty |
| `render()` | Called from rAF loop — draw grid, passband, spectrum, peak |
| `setPassband(lowHz, highHz, centerHz)` | Update passband overlay position |
| `setPeakHold(enabled)` | Toggle peak hold trace |
| `resize(width, height)` | Handle canvas resize |
| `destroy()` | Clean up |

### SpectrumDisplay React Component

```tsx
interface SpectrumDisplayProps {
  className?: string;
  minLevel?: number;        // default -130 dB
  maxLevel?: number;        // default -20 dB
  showGrid?: boolean;       // default true
  showPeakHold?: boolean;   // default false
  passbandLow?: number;     // Hz, for passband overlay
  passbandHigh?: number;    // Hz, for passband overlay
  centerFrequency?: number; // kHz, for passband positioning
}

interface SpectrumHandle {
  pushBins(bins: Uint8Array): void;
}
```

The component:
1. Creates a `<canvas>` element inside a container div
2. Uses `ResizeObserver` to track container size
3. Instantiates `SpectrumRenderer` on mount, destroys on unmount
4. Exposes `pushBins` via `useImperativeHandle`

### Features

#### dB Grid Lines

Horizontal lines every 10 dB with labels on the right edge. Drawn as 1px gray lines with white text. Grid is precomputed when levels change, not recalculated per frame.

```
-20 dB ─────────────────────────────── -20
-30 dB ─────────────────────────────── -30
-40 dB ─────────────────────────────── -40
  ...
-120 dB ─────────────────────────────── -120
-130 dB ─────────────────────────────── -130
```

#### Passband Overlay

A semi-transparent colored rectangle showing the current demodulation bandwidth. Position is calculated from `centerFrequency`, `passbandLow`, and `passbandHigh` relative to the spectrum's frequency range. Drawn before the spectrum trace so the trace appears on top.

```typescript
const x1 = freqToCanvasX(centerFreq + passbandLow / 1000);
const x2 = freqToCanvasX(centerFreq + passbandHigh / 1000);
ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
ctx.fillRect(x1, 0, x2 - x1, canvasHeight);
```

#### Peak Hold

An optional trace that tracks the maximum signal level at each bin over time. Drawn as a thin line (1px, yellow) above the spectrum fill. Updated each frame: `peak[x] = max(peak[x], currentBin[x])`. Can be cleared/reset by the user.

#### Averaging / Smoothing

Optional IIR smoothing to reduce visual noise in the spectrum trace. On each frame:

```typescript
smoothed[x] = smoothed[x] + alpha * (current[x] - smoothed[x]);
```

Where `alpha` controls the smoothing factor (0.3 = heavy smoothing, 1.0 = no smoothing). The smoothed values are used for rendering; the raw values are used for peak hold.

#### Tooltip

On mouse hover, show the frequency and dB level at the cursor position. Map canvas X to frequency (same math as click-to-tune), map canvas Y to dB level.

### Integration with Stream Player Page

Changes to `stream-player-page.tsx`:

1. Add a `useRef<SpectrumHandle>` for the spectrum component
2. In the existing WebSocket handler for type `0x01`, forward bins to both waterfall and spectrum:
   ```typescript
   if (packet[0] === 0x01 && packet.length > 9) {
     const bins = new Uint8Array(ev.data, 9);
     waterfallRef.current?.pushBins(bins);
     spectrumRef.current?.pushBins(bins);
   }
   ```
3. Add the `<SpectrumDisplay>` component above the waterfall in the JSX:
   ```tsx
   <section className="border-b pb-2">
     <SpectrumDisplay
       ref={spectrumRef}
       className="h-40 w-full"
       minLevel={-130}
       maxLevel={-20}
       passbandLow={lo}
       passbandHigh={hi}
       centerFrequency={frequency}
     />
     <WaterfallDisplay
       ref={waterfallRef}
       className="h-64 w-full"
     />
   </section>
   ```

### Styling

- Canvas fills container width, fixed height (default `10rem`, adjustable)
- Black background, matching the waterfall
- Spectrum fill uses a vertical gradient: dark blue (bottom) → cyan → green → yellow → red (top)
- Grid lines in `rgba(255, 255, 255, 0.2)`, labels in white 10px font
- Passband overlay in `rgba(255, 255, 255, 0.15)`
- Peak hold trace in yellow, 1px
- Shares the same container/card as the waterfall for a unified look

---

## Implementation Order

This plan depends on the waterfall backend work from `WATERFALL.md` being completed first (steps 1-4 in that plan). The spectrum is frontend-only.

| Step | Task | Effort |
|------|------|--------|
| 1 | `spectrum-renderer.ts` — rendering class with gradient fill, grid, passband, peak hold | Medium |
| 2 | `spectrum-display.tsx` — React wrapper component | Medium |
| 3 | Integrate into `stream-player-page.tsx` — wire bins to both spectrum and waterfall | Small |
| 4 | Add smoothing (IIR alpha slider) and peak hold toggle to controls | Small |
| 5 | Add hover tooltip (frequency + dB at cursor) | Small |

---

## Performance Budget

Target: **< 2ms per frame on the main thread.**

The spectrum is much cheaper than the waterfall because it draws one shape per frame instead of 1024 pixels.

| Operation | Target | Technique |
|-----------|--------|-----------|
| Clear canvas | < 0.2ms | `clearRect` |
| Grid lines | < 0.3ms | Pre-computed positions, simple `fillRect` calls |
| Passband overlay | < 0.1ms | Single `fillRect` |
| Spectrum path build | < 0.3ms | Single `Path2D` with 1024 `lineTo` calls |
| Spectrum fill | < 0.3ms | Single `fill()` with gradient |
| Peak hold stroke | < 0.2ms | Single `stroke()` |
| Total | < 1.5ms | Well within budget, shares rAF with waterfall |

---

## Relationship to WATERFALL.md

| Aspect | Waterfall | Spectrum |
|--------|-----------|----------|
| Data source | W/F bins from KiwiSDR (type `0x01`) | Same — exact same bins |
| Backend changes | Yes — new W/F client, WebSocket forwarding | None — frontend only |
| Canvas strategy | Single canvas, `drawImage` scroll, `putImageData` | Single canvas, `Path2D` fill |
| Update rate | Every W/F frame | Every W/F frame (shared rAF) |
| Purpose | Signal history over time | Current signal strength |
| Dependencies | Backend steps 1-4 from WATERFALL.md | Waterfall data pipeline working |

The spectrum and waterfall are complementary views of the same data. They should be implemented together as a unified display, sharing the same rAF loop, the same dB level settings, and the same frequency scale.
