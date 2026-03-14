# Waterfall Chart Implementation Plan

## Overview

Add a real-time waterfall spectrum display to the stream player page (`/streams/$streamId`). The waterfall is a scrolling 2D spectrogram showing the full RF spectrum: frequency on the X axis, time on the Y axis (scrolling downward), color representing signal strength in dB. This lets users visually spot signals across the entire receiver bandwidth and click to tune.

This plan is based on a thorough analysis of OpenWebRX's waterfall implementation, the KiwiSDR W/F WebSocket protocol (from `jks-prv/kiwiclient` and `jks-prv/Beagle_SDR_GPS`), and our existing React/TypeScript/Vite stack.

---

## Current State

| Aspect | Status |
|--------|--------|
| Frontend framework | React 18, Vite, TypeScript, Tailwind, shadcn/ui |
| Stream page | `frontend/src/routes/stream-player-page.tsx` |
| WebSocket | `/api/streams/{streamId}/ws` — binary PCM16 audio (type `0x02`) + JSON control |
| Backend | Go + KiwiSDR client connecting to `/{ts}/SND` endpoint only |
| Spectrum/FFT data | **None** — backend does not connect to KiwiSDR's W/F endpoint |
| Visualization | **None** — no canvas, WebGL, or spectrum code exists |

---

## How OpenWebRX Does It (Reference)

OpenWebRX runs its own server-side FFT pipeline and streams the result:

```
SDR IQ data → Server-side FFT (csdr) → LogPower → FftSwap → optional ADPCM compress
  → WebSocket binary [0x01] + Float32/ADPCM bins
  → Client: decode → waterfall_mkcolor() per pixel → createImageData(w,1) → putImageData()
  → CSS transform: translate() to scroll multiple canvases down
```

### OpenWebRX Performance Weaknesses

| Issue | Detail |
|-------|--------|
| No `requestAnimationFrame` | Updates fire on every WebSocket message, causing jank |
| Per-pixel JS color loop | `waterfall_mkcolor()` called per FFT bin, interpolating RGB every time |
| `createImageData` per frame | Allocates a new `ImageData` object for every single scan line |
| No Web Workers | ADPCM decode + color mapping all run on the main thread |
| No `OffscreenCanvas` / WebGL | Uses 2D canvas `putImageData` only |
| Multi-canvas DOM churn | Creates/removes `<canvas>` elements as the waterfall scrolls |
| jQuery + globals | Tightly coupled mutable globals, hard to maintain |

---

## KiwiSDR W/F Protocol (Reverse-Engineered)

KiwiSDR exposes a dedicated waterfall endpoint that streams pre-computed FFT magnitude data for the full receiver bandwidth. This is separate from the SND (audio) endpoint and provides exactly what a waterfall display needs.

### Connection

```
ws(s)://host:port/{unix_timestamp}/W/F
```

Same pattern as SND (`/{ts}/SND`), but using `W/F` path.

### Initialization Sequence

```
SET auth t=kiwi p=
SET ident_user=sdr-radio
SET zoom=0 cf=15000.000          (zoom 0 = full bandwidth, cf = center freq kHz)
SET maxdb=-10 mindb=-110         (dB range — values don't matter for raw data)
SET wf_comp=0                    (0 = uncompressed, 1 = ADPCM)
SET wf_speed=4                   (1-4, update rate: 1=slow 4=fast)
SET interp=13                    (13 = drop sampling + CIC compensation, default)
SET send_dB=1                    (send dB values)
```

Then `SET keepalive` every ~3 seconds (same as SND).

### Binary Frame Format

Each W/F binary message from KiwiSDR:

```
Offset  Size     Field
─────────────────────────────────────────────
0       3 bytes  Tag: "W/F"
3       1 byte   (skipped — padding/subtype)
4       4 bytes  x_bin_server (uint32 LE) — starting bin index
8       4 bytes  zoom_and_flags (uint32 LE)
                   bits 0-15:  zoom level
                   bits 16-31: flags (bit 0 = compressed, bit 1 = no_sync)
12      4 bytes  (reserved / sequence)
16      N bytes  FFT magnitude bins (uint8[], typically 1024 bins)
```

### FFT Data Format

- Each bin is a `uint8` (0–255)
- Represents unsigned dB: actual dB = `value - 255`
- So: 0 → -255 dB, 255 → 0 dB
- Always 1024 bins (`WF_BINS = 1024`)
- If `flags & COMPRESSED`, data is IMA-ADPCM encoded (same codec as SND audio)

### Zoom and Frequency Span

```
span_kHz = MAX_FREQ / 2^zoom
```

- `MAX_FREQ` = 30,000 kHz (30 MHz) for standard KiwiSDR
- Zoom 0 = full 30 MHz bandwidth across 1024 bins (~29.3 kHz/bin)
- Zoom 14 = narrowest (~1.83 Hz/bin)
- For v1.329+: `SET zoom=N cf=FREQ_KHZ` (center frequency)
- For older: `SET zoom=N start=COUNTER`

---

## KiwiSDR Connection Model: SND + W/F Share One Channel

This is the most important architectural detail. KiwiSDR has a limited number of receiver channels (typically 4-8). Each "user" consumes one channel. The KiwiSDR web UI opens **two separate WebSocket connections** — one for SND (audio) and one for W/F (waterfall) — but they **share the same timestamp** in the URL path so the server pairs them into a single channel slot.

From the KiwiSDR frontend source (`Beagle_SDR_GPS/web/kiwi/kiwi_util.js`):

```javascript
// Both use the same kiwi.conn_tstamp — this is what pairs them as one channel
ws_snd = open_websocket('SND', ...);  // → /ws/kiwi/{conn_tstamp}/SND
ws_wf  = open_websocket('W/F', ...);  // → /ws/kiwi/{conn_tstamp}/W/F
```

Our existing Go client generates a timestamp at connect time:

```go
Path: fmt.Sprintf("/%d/SND", time.Now().Unix())
```

**To add W/F without consuming a second channel slot, the W/F connection must use the same timestamp as the SND connection.** This means the timestamp needs to be generated once and shared between both clients.

Note: OpenWebRX is not relevant to this question. OpenWebRX does not connect to KiwiSDR at all — it runs its own SDR hardware and its own server-side FFT. It sends audio + FFT over a single WebSocket. Our architecture is fundamentally different because we're proxying data from KiwiSDR.

---

## Architecture

The waterfall requires changes at three layers: KiwiSDR W/F client (Go), WebSocket forwarding (Go), and frontend rendering (React/TypeScript).

```
KiwiSDR server (one channel slot, two WebSocket connections)
  ┌──────────────────────────────┐
  │  /{ts}/SND  (existing)       │──→ audio PCM
  │  /{ts}/W/F  (new, same ts)   │──→ FFT magnitude bins
  └──────────────────────────────┘
       │                │
       ▼                ▼
┌──────────────────────────────────┐
│  internal/kiwi/                  │
│  client.go     (SND, existing)   │
│  wf_client.go  (W/F, new)       │
│  Both share the same timestamp   │
└──────────┬───────────────────────┘
           │ audio chan + wf chan
           ▼
┌──────────────────────────────────┐
│  internal/streammgr/             │  Extend manager
│  Subscribe()          → audio    │
│  SubscribeWaterfall() → wf bins  │
└──────────┬───────────────────────┘
           │ binary over WebSocket
           ▼
┌──────────────────────────────────┐
│  internal/api/stream_ws.go       │  Extend existing WS handler
│  type 0x02 = audio (existing)    │
│  type 0x01 = waterfall (new)     │
└──────────┬───────────────────────┘
           │ WebSocket to browser
           ▼
┌──────────────────────────────────┐
│  Frontend: WaterfallDisplay      │  New React component
│  Parse bins → color LUT → canvas │
│  rAF batching, single canvas     │
└──────────────────────────────────┘
```

---

## Backend Implementation

### 1. Refactor: Shared Timestamp Between SND and W/F

The existing `client.go` generates the timestamp internally:

```go
Path: fmt.Sprintf("/%d/SND", time.Now().Unix())
```

This needs to change. The timestamp must be generated once by the caller (stream manager) and passed to both the SND and W/F clients:

```go
// In streammgr: generate timestamp once, pass to both
ts := time.Now().Unix()
sndClient, err := kiwi.Connect(ctx, sndCfg, ts)  // /{ts}/SND
wfClient, err := kiwi.ConnectWF(ctx, wfCfg, ts)   // /{ts}/W/F  (same ts!)
```

### 2. New File: `internal/kiwi/wf_client.go`

A W/F client that mirrors the structure of the existing `client.go` (SND client).

**Responsibilities:**
- Connect to KiwiSDR `/{ts}/W/F` WebSocket endpoint using the shared timestamp
- Send initialization commands (auth, zoom, speed, compression settings)
- Parse incoming `W/F`-tagged binary frames
- Extract FFT magnitude bins (uint8 array, 1024 values)
- Forward raw bins on a `chan WFFrame`
- Send keepalive every 3 seconds
- Support reconfiguration (zoom level, center frequency) via `Reconfigure()`

**Key types:**

```go
type WFConfig struct {
    Host      string
    Port      int
    UseTLS    bool
    Name      string
    Zoom      int       // 0-14, 0 = full bandwidth
    CenterKHz float64   // center frequency in kHz
    Speed     int       // 1-4, waterfall update rate
    Compress  bool      // ADPCM compression
}

type WFClient struct {
    conn       *websocket.Conn
    done       chan struct{}
    frames     chan WFFrame      // buffered channel
    // ...
}

type WFFrame struct {
    Bins      []byte   // 1024 uint8 magnitude values
    XBin      uint32   // starting bin index
    Zoom      uint16   // zoom level
    Flags     uint16   // compression, sync flags
}
```

**Frame parsing logic:**

```go
func (c *WFClient) processWF(body []byte) (WFFrame, bool) {
    if len(body) < 14 { // 1 skip + 4 xbin + 4 zoom_flags + 4 reserved + data
        return WFFrame{}, false
    }
    body = body[1:] // skip first byte (same as kiwiclient)
    xBin := binary.LittleEndian.Uint32(body[0:4])
    zoomFlags := binary.LittleEndian.Uint32(body[4:8])
    zoom := uint16(zoomFlags & 0xFFFF)
    flags := uint16((zoomFlags >> 16) & 0xFFFF)
    bins := body[12:] // skip reserved uint32
    
    if flags&WF_FLAG_COMPRESSED != 0 {
        bins = c.decodeIMAADPCM(bins) // reuse same ADPCM decoder
    }
    
    return WFFrame{Bins: bins, XBin: xBin, Zoom: zoom, Flags: flags}, true
}
```

**Initialization commands:**

```go
func buildWFInitCommands(cfg WFConfig) []string {
    return []string{
        "SET auth t=kiwi p=",
        fmt.Sprintf("SET ident_user=%s", sanitizeName(cfg.Name)),
        fmt.Sprintf("SET zoom=%d cf=%.3f", cfg.Zoom, cfg.CenterKHz),
        "SET maxdb=-10 mindb=-110",
        fmt.Sprintf("SET wf_comp=%d", boolToInt(cfg.Compress)),
        fmt.Sprintf("SET wf_speed=%d", cfg.Speed),
        "SET interp=13",
        "SET send_dB=1",
    }
}
```

### 3. Extend `internal/streammgr/`

Add waterfall subscription alongside existing audio subscription.

- When a stream starts, generate one timestamp and open both SND + W/F connections with it
- `SubscribeWaterfall(streamID) (chan WFFrame, unsubscribe func, error)` — fan-out channel
- Lifecycle tied to the stream: when SND client connects/disconnects, W/F follows
- Both connections share the same KiwiSDR host/port and timestamp (one channel slot)

### 4. Extend `internal/api/stream_ws.go`

Add a new binary message type `0x01` for waterfall data. When a browser client connects:

1. Subscribe to audio (existing, type `0x02`)
2. Subscribe to waterfall (new, type `0x01`)
3. Forward both on the same WebSocket connection

**New binary message format (server → browser):**

```
Byte 0:     0x01 (waterfall type)
Bytes 1-4:  x_bin (uint32 LE)
Bytes 5-6:  zoom (uint16 LE)
Bytes 7-8:  flags (uint16 LE)
Bytes 9+:   FFT magnitude bins (uint8[], 1024 values)
```

**New JSON control message (browser → server):**

```json
{
    "type": "wf_config",
    "zoom": 0,
    "center_khz": 15000.0,
    "speed": 4
}
```

This lets the frontend control zoom/pan on the waterfall independently of the audio tuning.

---

## Frontend Implementation

### New Files

| File | Purpose |
|------|---------|
| `frontend/src/components/waterfall/waterfall-display.tsx` | React component: canvas, resize, cleanup |
| `frontend/src/components/waterfall/waterfall-renderer.ts` | Imperative rendering class (decoupled from React) |
| `frontend/src/components/waterfall/color-maps.ts` | Pre-computed 256-entry RGBA lookup tables |
| `frontend/src/components/waterfall/types.ts` | Shared TypeScript types |

### Component Architecture

```
┌─────────────────────────────────────────────────┐
│ StreamPlayerPage                                │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │ WaterfallDisplay (React component)      │    │
│  │                                         │    │
│  │  - Owns a single <canvas> element       │    │
│  │  - Instantiates WaterfallRenderer       │    │
│  │  - Exposes pushBins() via ref           │    │
│  │  - Handles resize (ResizeObserver)      │    │
│  │  - Handles cleanup on unmount           │    │
│  │                                         │    │
│  │  ┌───────────────────────────────────┐  │    │
│  │  │ WaterfallRenderer (class)         │  │    │
│  │  │                                   │  │    │
│  │  │  - Receives uint8 magnitude bins  │  │    │
│  │  │  - Maps bins → color via LUT      │  │    │
│  │  │  - Writes to canvas via drawImage │  │    │
│  │  │    self-blit + putImageData       │  │    │
│  │  │  - Batches lines per rAF          │  │    │
│  │  │  - Owns pre-computed color LUT    │  │    │
│  │  └───────────────────────────────────┘  │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  [frequency display, controls, etc.]            │
└─────────────────────────────────────────────────┘
```

### Data Flow

```
WebSocket binary message
  │
  ├── type 0x02 → AudioWorklet (existing audio pipeline, unchanged)
  │
  └── type 0x01 → Parse header (xBin, zoom, flags)
                    │
                    └── Extract uint8[] magnitude bins
                          │
                          └── waterfallRef.current.pushBins(bins)
                                │
                                └── Queue bins in WaterfallRenderer
                                      │
                                      └── On rAF tick: for each queued line:
                                            │
                                            ├── Map each bin → color via LUT (Uint8Array[256*4])
                                            ├── Write pixels into reusable ImageData row
                                            ├── Scroll: drawImage(canvas, 0,0, w,h-1, 0,1, w,h-1)
                                            └── putImageData(newRow, 0, 0)  ← top of canvas
```

### Rendering Strategy (Key Modernizations vs OpenWebRX)

#### Single Canvas + `drawImage` Scroll (vs Multi-Canvas CSS Transforms)

OpenWebRX creates multiple `<canvas>` elements and shifts them with CSS transforms. This causes DOM churn and layout recalculations.

**Our approach:** Use a single canvas. To scroll, use `drawImage(canvas, 0, 0, w, h-1, 0, 1, w, h-1)` to copy the canvas contents down by 1 pixel, then `putImageData` the new line at row 0. This is a single GPU-accelerated blit with zero DOM manipulation.

#### Pre-Computed Color LUT (vs Per-Pixel Function Calls)

OpenWebRX calls `waterfall_mkcolor()` for every FFT bin on every frame, involving floating-point math and array lookups.

**Our approach:** Pre-compute a `Uint8Array(256 * 4)` lookup table (256 entries x RGBA) on initialization and when color map changes. During rendering, the uint8 bin value *is* the LUT index — no math needed. Just copy 4 bytes per pixel.

```typescript
// Pre-compute once (or when color map changes):
const lut = new Uint8Array(256 * 4);
for (let i = 0; i < 256; i++) {
  const [r, g, b] = colorMap(i / 255);
  lut[i * 4] = r;
  lut[i * 4 + 1] = g;
  lut[i * 4 + 2] = b;
  lut[i * 4 + 3] = 255;
}

// Per frame — the bin value IS the index. Zero math:
for (let x = 0; x < numBins; x++) {
  const base = bins[x] << 2;
  pixels[x * 4]     = lut[base];
  pixels[x * 4 + 1] = lut[base + 1];
  pixels[x * 4 + 2] = lut[base + 2];
  pixels[x * 4 + 3] = 255;
}
```

#### `requestAnimationFrame` Batching (vs Immediate Render on Message)

OpenWebRX renders the instant each WebSocket message arrives. If W/F data arrives at 20 FPS but the display refreshes at 60 Hz, frames are wasted or jank occurs.

**Our approach:** Accumulate completed bin arrays in a queue. On each `requestAnimationFrame`, paint all queued lines in a single batch. This synchronizes with the display refresh rate and consolidates paint operations.

#### Reusable `ImageData` (vs Allocate Per Frame)

OpenWebRX calls `createImageData(w, 1)` on every frame.

**Our approach:** Allocate a single `ImageData(numBins, 1)` on init (and on resize). Reuse it for every line by overwriting its `.data` buffer.

#### No FFT Needed on Frontend

Since KiwiSDR does the FFT server-side and sends magnitude bins directly, the frontend does zero signal processing. No `fft.js` dependency, no Web Worker for FFT. The frontend is purely a rendering engine.

### Color Maps

Provide 3 built-in color schemes, selectable from the UI:

| Name | Description |
|------|-------------|
| **Turbo** | Google's Turbo colormap — perceptually uniform, high contrast (default) |
| **Viridis** | Blue-green-yellow — good for colorblind users |
| **Grayscale** | Black-to-white — classic SDR look |

Each is a function `(t: number) => [r, g, b]` where `t ∈ [0, 1]`. The LUT is built from this at 256 steps.

### WaterfallRenderer Class

Core imperative class, ~150 lines. Key methods:

| Method | Purpose |
|--------|---------|
| `constructor(canvas, options)` | Set up context, LUT, reusable ImageData |
| `setColorMap(map)` | Rebuild LUT from a new color map function |
| `pushBins(bins: Uint8Array)` | Queue a line for rendering |
| `startRenderLoop()` | Begin rAF loop |
| `stopRenderLoop()` | Cancel rAF |
| `resize(width, height)` | Handle canvas resize, reallocate ImageData |
| `destroy()` | Cancel rAF, clean up |

### WaterfallDisplay React Component

```tsx
interface WaterfallDisplayProps {
  className?: string;
  colorMap?: "turbo" | "viridis" | "grayscale";
}

interface WaterfallHandle {
  pushBins(bins: Uint8Array): void;
}
```

The component:
1. Creates a `<canvas>` element inside a container div
2. Uses `ResizeObserver` to track container size and resize the canvas
3. Instantiates `WaterfallRenderer` on mount, destroys on unmount
4. Exposes `pushBins` via `useImperativeHandle` so the parent feeds data without re-renders

### Integration with Stream Player Page

Changes to `stream-player-page.tsx`:

1. Add a `useRef<WaterfallHandle>` for the waterfall component
2. In the WebSocket `onmessage` handler, add a new branch for type `0x01`:
   ```typescript
   if (packet[0] === 0x01 && packet.length > 9) {
     const bins = new Uint8Array(ev.data, 9);
     waterfallRef.current?.pushBins(bins);
   }
   ```
3. Add the `<WaterfallDisplay>` component to the JSX, between the frequency display and controls:
   ```tsx
   <section className="border-b pb-2">
     <WaterfallDisplay
       ref={waterfallRef}
       className="h-64 w-full"
     />
   </section>
   ```

### Styling

- Canvas fills container width, fixed height (default `16rem`, adjustable)
- Dark background (`bg-black`) so waterfall colors pop
- Rounded corners via container div, matching shadcn card aesthetic
- Frequency axis labels overlaid at the top (requires knowing center freq + zoom span)
- Responsive: `ResizeObserver` handles width changes

---

## Performance Budget

Target: **60 FPS rendering with < 3ms per frame on the main thread.**

The frontend does zero signal processing — KiwiSDR sends pre-computed FFT bins. All the frontend does is map uint8 values to colors and blit pixels.

| Operation | Target | Technique |
|-----------|--------|-----------|
| Color mapping (1024 bins) | < 0.5ms | Pre-computed LUT, bin value = index, zero math |
| Canvas scroll (`drawImage` self-blit) | < 1ms | Single GPU-accelerated copy |
| `putImageData` (1 row) | < 0.5ms | Reused ImageData, single row |
| Total main thread per frame | < 2ms | Well within 16ms budget |

### Future: WebGL Upgrade Path

If performance is ever insufficient (e.g., very high DPI displays, 4K monitors):
- Upload bins as a 1D texture
- Color mapping via fragment shader (LUT as a 1D texture)
- Scrolling via texture coordinate offset (no pixel copying)
- The React component API stays identical — only the renderer internals change

---

## Features from KiwiSDR to Incorporate

After studying the KiwiSDR web frontend (`tmp_kiwisdr/web/`), there are several features beyond basic waterfall rendering that we should plan for. These are organized into the core implementation and future enhancements.

### Must-Have for Initial Release

#### Frequency Scale

KiwiSDR draws a separate scale canvas above the waterfall with frequency markers and labels. It uses `mkscale()` and `mk_freq_scale()` to calculate marker positions from the zoom level and bin range, then draws tick marks and kHz/MHz labels.

**Our approach:** Add a thin `<canvas>` element above the waterfall canvas. Draw frequency tick marks and labels based on the current zoom span (`span_kHz = MAX_FREQ / 2^zoom`) and center frequency. Update when zoom changes. This is essential — a waterfall without frequency labels is unusable.

#### Click-to-Tune

KiwiSDR implements this in `canvas_mouseup()` → `canvas_get_carfreq()`. On click, it maps the canvas X position to a frequency: `norm = relativeX / waterfall_width`, `bin = x_bin + norm * bins_at_cur_zoom()`, `freq = bin_to_freq(bin)`. Then it tunes to that frequency.

**Our approach:** On click, map canvas X → frequency using the known zoom span and center frequency. Send a `patch` message through the existing WebSocket to change the stream's `frequency_khz`. This is the killer UX feature that makes the waterfall interactive rather than just decorative.

#### dB-to-Color Index Mapping

KiwiSDR's `color_index()` function does more than a simple linear map. It converts the wire value (0–255) to dBm (`value - 255`), clamps to `[mindb, maxdb]`, computes a percentage, and optionally applies sqrt or log transforms for better visual contrast. Our plan currently assumes the uint8 bin value maps directly to the LUT index, which is too naive — we need the dB range mapping.

**Our approach:** Add configurable `minLevel` and `maxLevel` dB parameters. Map each bin: `dBm = bin_value - 255`, then `index = clamp(((dBm - minLevel) / (maxLevel - minLevel)) * 255, 0, 255)`. This lets users adjust the contrast range.

### Should-Have (Phase 2 Enhancements)

#### Zoom and Pan

KiwiSDR has full zoom/pan support. Mouse wheel zooms in/out, click-drag pans. Zoom sends `SET zoom=N start=X` to the server, which adjusts which part of the spectrum the 1024 bins cover. The frequency span per zoom level is `MAX_FREQ / 2^zoom`.

**Our approach:** Add mouse wheel zoom handler on the waterfall canvas. On zoom change, send a new `wf_config` message through the WebSocket, which the backend forwards as `SET zoom=N cf=FREQ` to the KiwiSDR W/F connection. Pan via click-drag sends the same command with an adjusted center frequency.

**Bin/pixel math helpers needed:**
- `zoomToSpan(zoom) = MAX_FREQ / 2^zoom` — kHz span at a zoom level
- `binToFreq(bin) = bin * MAX_FREQ / WF_BINS / 2^MAX_ZOOM` — bin index to kHz
- `freqToBin(freq) = freq / MAX_FREQ * WF_BINS * 2^MAX_ZOOM` — kHz to bin index
- `canvasXToFreq(x, canvasWidth, zoom, startBin)` — pixel position to frequency

#### Spectrum Analyzer (Line Graph)

KiwiSDR renders a spectrum line graph above the waterfall showing the current FFT line as a filled area plot. It uses the same data from the W/F stream but draws it as a graph instead of a colored row. It also overlays a passband marker showing the current demodulation bandwidth as a colored rectangle.

**Our approach:** Add an optional `SpectrumDisplay` component above the waterfall. It receives the same bin data, draws it as a line/filled-area graph using canvas 2D `lineTo()` / `fill()`. Overlay the current demodulation passband as a semi-transparent rectangle. This provides instant visual feedback about signal strength and where the tuning is.

#### Auto-Level Detection (Aperture)

KiwiSDR has a sophisticated auto-level system with three averaging algorithms: IIR (exponential decay), MMA (modified moving average), and EMA (exponential moving average). It also has an auto-scale mode that uses percentile analysis: 50th percentile = noise floor, 95th = signal level, then sets `maxdb = signal + 30`, `mindb = noise - 10`.

**Our approach:** Start with a simple auto-scale: on each frame, track a running min/max of dB values using exponential smoothing. Set levels to `[smoothed_min - 5, smoothed_max + 5]`. This avoids the manual min/max slider dance that makes SDR waterfalls annoying for beginners. Add IIR aperture averaging later if needed.

#### Additional Color Maps

KiwiSDR offers 6 built-in colormaps plus 4 custom slots: Kiwi (the classic blue→cyan→green→yellow→red), CuteSDR, greyscale, linear, turbo, and SdrDx. Our plan only has 3 (Turbo, Viridis, Grayscale).

**Our approach:** Add at least the "Kiwi" colormap (it's the most recognizable SDR waterfall look) and "SdrDx" (black→blue→yellow→red→white, high contrast). Keep Turbo as default since it's perceptually superior.

#### Waterfall Timestamps

KiwiSDR can overlay timestamps on the waterfall at configurable intervals (2s, 5s, 10s, 30s, 1m, etc.) using `waterfall_timestamp()`. These are drawn directly onto the canvas as text.

**Our approach:** Add an option to stamp UTC time on the waterfall every N seconds using `ctx.fillText()` before the line is scrolled. Useful for logging and screenshots.

#### Waterfall Export

KiwiSDR has `export_waterfall` which composites all waterfall canvases into a single image and exports as JPG.

**Our approach:** Since we use a single canvas, export is trivial: `canvas.toBlob()` → download. Add a "Save Waterfall" button.

### Deferred (Not in Initial Scope)

- **DX labels** — Database-driven frequency labels above the scale. Complex, niche.
- **Filter envelope drawing** — Drawing the demodulator passband shape on the scale canvas. Nice but not essential.
- **Custom colormaps** — User-defined color gradients. Low priority.
- **ADPCM compression** — Our plan uses `wf_comp=0` (uncompressed). KiwiSDR supports ADPCM-compressed W/F data to save bandwidth. Could add later for low-bandwidth connections.

---

## Implementation Order

| Step | Task | Layer | Effort |
|------|------|-------|--------|
| 1 | Refactor `client.go` to accept a shared timestamp parameter | Backend | Small |
| 2 | `internal/kiwi/wf_client.go` — KiwiSDR W/F WebSocket client | Backend | Medium |
| 3 | Extend stream manager: generate shared timestamp, start W/F alongside SND, `SubscribeWaterfall()` | Backend | Medium |
| 4 | Extend `stream_ws.go`: subscribe to waterfall, forward as type `0x01` | Backend | Small |
| 5 | `color-maps.ts` — Turbo/Kiwi/SdrDx/Viridis/Grayscale LUT generators | Frontend | Small |
| 6 | `types.ts` — shared interfaces and bin/pixel math helpers | Frontend | Small |
| 7 | `waterfall-renderer.ts` — canvas rendering class with rAF loop and dB range mapping | Frontend | Medium |
| 8 | `waterfall-display.tsx` — React wrapper with frequency scale canvas | Frontend | Medium |
| 9 | Integrate into `stream-player-page.tsx` — parse `0x01`, wire to component | Frontend | Small |
| 10 | Click-to-tune: map canvas X → frequency → send patch | Frontend | Small |
| 11 | Auto-level: simple exponential smoothing of min/max dB | Frontend | Small |
| 12 | Test and tune end-to-end | Both | Medium |

### Phase 2 Enhancements

| Step | Task | Layer | Effort |
|------|------|-------|--------|
| 13 | Zoom/pan: mouse wheel zoom, drag pan, forward `SET zoom` to backend | Both | Medium |
| 14 | Spectrum analyzer component above waterfall | Frontend | Medium |
| 15 | Passband overlay on spectrum and waterfall | Frontend | Small |
| 16 | Waterfall timestamps | Frontend | Small |
| 17 | Waterfall JPG export | Frontend | Small |

---

## Open Questions

1. **W/F lifecycle** — Should the W/F connection always be active when a stream is running, or only when the waterfall UI is visible? Starting it lazily (on component mount) saves KiwiSDR resources but adds latency on first display.

2. **W/F speed** — KiwiSDR supports speeds 1-4. Speed 4 gives the fastest updates (~4 lines/sec at zoom 0). May want to expose this as a UI control.

3. **Shared connection slot** — Confirmed: KiwiSDR pairs SND + W/F connections into one channel slot when they share the same timestamp in the URL path. Our implementation must ensure both connections use the same timestamp. This is modeled after how the KiwiSDR web UI itself works (`Beagle_SDR_GPS/web/kiwi/kiwi_util.js`).

4. **MAX_FREQ variability** — KiwiSDR defaults to 30 MHz but some receivers report a different `bandwidth` value via the `MSG` handler. The W/F client should read this from the KiwiSDR's config messages and pass it to the frontend so frequency math is correct.
