# WebGL Waterfall Renderer

Drop-in replacement for `waterfall-renderer.ts` that moves color mapping and
tile compositing to the GPU. The consumer switches renderers by importing
`WaterfallDisplayGL` instead of `WaterfallDisplay` (same `WaterfallHandle`
ref interface, same props).

The shared chunk/scroll/marker/auto-level logic (~850 lines) is extracted into
an abstract base class so that each renderer subclass only implements the
rendering layer (~150 lines for Canvas 2D, ~250 lines for WebGL).

---

## Why WebGL

| Hot path | Canvas 2D (today) | WebGL (proposed) |
|---|---|---|
| **Color mapping** | `colorMapLine`: per-pixel CPU loop (1024 iterations/row), writes RGBA into `ImageData` | Fragment shader: sample R8 texture, normalize with uniforms, lookup 1D LUT texture |
| **Level changes** | `reRenderTile`: re-runs the CPU loop for every row of every tile | Update two uniforms (`u_minLevel`, `u_maxLevel`). No data reprocessing. |
| **Color map changes** | Rebuild SVG `feComponentTransfer` filter tables, browser re-composites | Re-upload a 256×1 RGBA LUT texture (~1 KB) |
| **Tile compositing** | `drawImage` with source/dest rect math per tile | Textured quad draw call per tile (purpose-built GPU operation) |
| **Row upload** | `putImageData` (RGBA, 4 bytes/pixel) | `texSubImage2D` (R8, 1 byte/pixel — 4× smaller) |
| **Memory per tile** | ~1 MB (1024×256×4 RGBA canvas) + rawBins | ~256 KB (1024×256×1 R8 texture) + rawBins |

The SVG filter hack on the `<canvas>` element is eliminated entirely.

---

## Architecture: abstract base class + renderer subclasses

### The problem with duplication

The current `WaterfallRenderer` is ~1016 lines. Of those, only ~150 are
Canvas 2D–specific (tile creation, color mapping, compositing, re-rendering
on level changes). The remaining ~850 lines are renderer-agnostic:

- Queue management (`pushFrame`, `pushBins`, drain in `flush`)
- RAF render loop (`startRenderLoop`, `stopRenderLoop`)
- Auto-level EMA (`updateAutoLevel`)
- Scroll state (`setScrollOffset`, `getScrollOffset`, `scrollToLive`,
  `maxScrollOffset`, `isLive`, `headShift`, `renderOffset`)
- Viewport/coverage (`setView`, `setDataCoverage`, `setMaxBandwidth`)
- Chunk lifecycle (`loadManifest`, `onChunkComplete`, `fetchChunk`,
  `loadInitialChunks`, `insertFramesAsChunkTiles`, `retireLiveTiles`,
  `checkViewport`, `isNearViewport`, `evictDistant`, `pruneLiveTiles`)
- Marker management (`addMarker`, `removeMarker`, `updateChunkMarker`)
- Overlay state emission (`onOverlayUpdate`, `onMarkerAdd`, `onMarkerRemove`)
- `chunkManifest` getter, `coverageFromFrame` helper
- `PerfBucket` instrumentation

Duplicating all of this in the GL renderer would be unmaintainable.

### Solution: extract a generic base class

```
waterfall-renderer-base.ts     NEW — abstract base class, all shared logic
waterfall-renderer.ts          MODIFIED — extends base, Canvas 2D rendering layer
waterfall-renderer-gl.ts       NEW — extends base, WebGL2 rendering layer
waterfall-display.tsx           UNCHANGED
waterfall-display-gl.tsx       NEW — React component wiring the GL renderer
types.ts                       UNCHANGED
```

The modification to `waterfall-renderer.ts` is **purely structural** — the
logic moves to the base class and the Canvas 2D specifics become method
overrides. No behavior changes, no API changes. All existing imports continue
to work because `WaterfallRenderer` re-exports the shared types.

---

## Base class design

### BaseTile — the common tile interface

Both renderers store raw dB bins and track tile position. The rendering-specific
fields (Canvas 2D: `canvas`/`ctx`, WebGL: `texture`) live in the subclass.

```ts
interface BaseTile {
  rawBins: (Uint8Array | null)[];
  rowCount: number;
  dataStartKHz: number;
  dataEndKHz: number;
  startRow: number;
}
```

The base class is generic: `WaterfallRendererBase<T extends BaseTile>`.
`ChunkEntry` becomes `ChunkEntry<T extends BaseTile>` with `tiles: T[]`.

### Abstract methods (8 total)

These are the only methods each renderer subclass must implement:

```ts
abstract class WaterfallRendererBase<T extends BaseTile> {

  /** Acquire the rendering context from the canvas. */
  protected abstract initContext(): void;

  /** Allocate a new tile (off-screen canvas or GL texture). */
  protected abstract createTile(
    startRow: number,
    dataStartKHz: number,
    dataEndKHz: number,
  ): T;

  /** Write one row of bin data into a tile at the given row index.
   *  Canvas 2D: colorMapLine + putImageData.
   *  WebGL: texSubImage2D (raw bytes, no color mapping). */
  protected abstract writeRow(
    tile: T,
    bins: Uint8Array,
    rowIndex: number,
  ): void;

  /** Composite all visible tiles to the output canvas.
   *  Canvas 2D: drawImage per tile.
   *  WebGL: textured quad draw call per tile. */
  protected abstract drawFrame(): void;

  /** Called when min/max levels change.
   *  Canvas 2D: re-render every tile through the CPU LUT.
   *  WebGL: no-op (levels are shader uniforms). */
  protected abstract onLevelsChanged(): void;

  /** Called after canvas dimensions change.
   *  Canvas 2D: no-op.
   *  WebGL: gl.viewport(). */
  protected abstract onResize(width: number, height: number): void;

  /** Release resources for a single tile.
   *  Canvas 2D: no-op (GC handles canvases).
   *  WebGL: gl.deleteTexture(). */
  protected abstract destroyTile(tile: T): void;

  /** Release all renderer-specific resources.
   *  Canvas 2D: no-op.
   *  WebGL: delete program, buffers, LUT texture. */
  protected abstract onDestroy(): void;
}
```

### What lives in the base class (everything else)

All protected/private, accessible by subclasses:

```
// State
canvas, tileHeight, rowScale, numBins
liveTiles: T[], liveTile: T, totalRows, scrollOffset, lowestStartRow
queue: Uint8Array[], rafId, needsRepaint
minLevel, maxLevel, autoLevel, smoothMin, smoothMax, samplesCount
dataStartKHz, dataEndKHz, maxBandwidthKHz, viewStartKHz, viewEndKHz
chunks: ChunkEntry<T>[], chunkSource, liveFrameCount, liveChunkStartRow
liveChunkStartedAt, streamSampleRate, streamChunkDurationS
markers: Map<string, WaterfallMarker>
onOverlayUpdate, onMarkerAdd, onMarkerRemove
perfFlush, perfFetch

// Public API (final — not overridden)
setLevels(min, max)        → stores values, calls this.onLevelsChanged(), needsRepaint
setAutoLevel(enabled)
setView(startKHz, endKHz)
setDataCoverage(startKHz, endKHz)  → calls this.createTile() (abstract)
setMaxBandwidth(maxKHz)
pushFrame(bins, xBin, zoom)
pushBins(bins)
startRenderLoop() / stopRenderLoop()
resize(width, height)      → sets canvas dims, calls this.onResize(), this.drawFrame()
destroy()                  → stops loop, destroys all tiles, calls this.onDestroy()
setChunkSource(source)
loadManifest(chunkMetas, streamInfo?)
onChunkComplete(msg)
resetLiveFrameCount()
setScrollOffset(offset) / getScrollOffset() / scrollToLive()

// Getters
currentLevels, rowCount, visibleRows, cssToRows, chunkManifest
maxScrollOffset, isLive, playbackRow, headShift, renderOffset

// Private logic (calls abstract methods at the seams)
flush()                    → drains queue, calls appendToLiveTile, drawFrame
appendToLiveTile(bins)     → tile lifecycle + calls this.writeRow() (abstract)
insertFramesAsChunkTiles() → grouping + calls this.createTile(), this.writeRow()
pruneLiveTiles()
evictDistant()             → calls this.destroyTile() (abstract)
retireLiveTiles()
updateAutoLevel()
checkViewport() / isNearViewport() / loadInitialChunks() / fetchChunk()
addMarker() / removeMarker() / updateChunkMarker()
coverageFromFrame()  (static helper)
```

### How existing methods map to the base class

#### `flush()` — base class, calls abstract `drawFrame()`

```ts
// In base class (simplified)
private flush(): void {
  const lines = this.queue.splice(0, this.queue.length);
  if (lines.length === 0 && !this.needsRepaint) return;

  const t0 = performance.now();
  for (const bins of lines) {
    if (this.autoLevel) this.updateAutoLevel(bins);
    this.appendToLiveTile(bins);
  }
  this.pruneLiveTiles();
  this.checkViewport();
  this.drawFrame();            // ← abstract, subclass draws
  this.needsRepaint = false;
  this.emitOverlayState();
  this.perfFlush.record(performance.now() - t0);
}
```

#### `appendToLiveTile()` — base class, calls abstract `writeRow()`

```ts
private appendToLiveTile(bins: Uint8Array): void {
  if (this.liveTile.rowCount >= this.tileHeight) {
    this.liveTile = this.createTile(/*...*/);  // ← abstract
    this.liveTiles.push(this.liveTile);
  }
  const tile = this.liveTile;
  tile.rawBins.push(new Uint8Array(bins));
  this.writeRow(tile, bins, tile.rowCount);    // ← abstract
  tile.rowCount++;
  this.totalRows++;
  if (this.scrollOffset > 0) this.scrollOffset++;
}
```

#### `setLevels()` — base class, calls abstract `onLevelsChanged()`

```ts
setLevels(min: number, max: number): void {
  this.autoLevel = false;
  this.minLevel = min;
  this.maxLevel = max;
  this.onLevelsChanged();   // ← Canvas 2D re-renders all tiles; GL is no-op
  this.needsRepaint = true;
}
```

#### `evictDistant()` — base class, calls abstract `destroyTile()`

```ts
private evictDistant(topFromLive: number, bottomFromLive: number): void {
  for (const entry of this.chunks) {
    if (!entry.loaded) continue;
    // ... distance calculation (unchanged) ...
    if (dist > EVICT_DISTANCE_ROWS) {
      for (const tile of entry.tiles) this.destroyTile(tile);  // ← abstract
      entry.tiles = [];
      entry.loaded = false;
    }
  }
}
```

#### `resize()` — base class, calls abstract `onResize()` + `drawFrame()`

```ts
resize(width: number, height: number): void {
  if (width < 1 || height < 1) return;
  this.canvas.width = width;
  this.canvas.height = height;
  this.onResize(width, height);  // ← GL: gl.viewport(); Canvas 2D: no-op
  this.drawFrame();              // ← abstract
}
```

---

## Canvas 2D subclass (~150 lines)

`WaterfallRenderer` extends `WaterfallRendererBase<WFTile>`:

```ts
interface WFTile extends BaseTile {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export class WaterfallRenderer extends WaterfallRendererBase<WFTile> {
  private ctx!: CanvasRenderingContext2D;
  private lut: Uint8Array;
  private rowImageData!: ImageData;

  protected initContext(): void {
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Failed to get 2D context");
    this.ctx = ctx;
    this.lut = buildLUT(WATERFALL_COLOR_MAPS.muted);
    // create scratch ImageData for colorMapLine
  }

  protected createTile(startRow, dataStartKHz, dataEndKHz): WFTile {
    // create off-screen canvas, get 2d context, fillRect black
  }

  protected writeRow(tile: WFTile, bins: Uint8Array, rowIndex: number): void {
    this.colorMapLine(bins);
    tile.ctx.putImageData(this.rowImageData, 0, this.tileHeight - 1 - rowIndex);
  }

  protected drawFrame(): void {
    // existing blitToVisible + blitTile logic
  }

  protected onLevelsChanged(): void {
    // re-render all live tiles and chunk tiles (existing reRenderTile logic)
  }

  protected onResize(): void { /* no-op */ }
  protected destroyTile(): void { /* no-op, GC handles canvases */ }
  protected onDestroy(): void { /* no-op */ }

  // Private helpers (Canvas 2D–specific)
  private colorMapLine(bins: Uint8Array): void { /* existing logic */ }
  private reRenderTile(tile: WFTile): void { /* existing logic */ }
  private blitTile(tile: WFTile, ...): void { /* existing logic */ }
}
```

This is the existing code reorganized — same algorithms, same behavior.
Re-exports `OverlayState` and `RendererOptions` from the base class so
that all existing imports (`waterfall-overlay.tsx` importing `OverlayState`
from `./waterfall-renderer`) continue to work without changes.

---

## WebGL subclass (~250 lines)

`WaterfallRendererGL` extends `WaterfallRendererBase<GLTile>`:

```ts
interface GLTile extends BaseTile {
  texture: WebGLTexture | null;
}

export class WaterfallRendererGL extends WaterfallRendererBase<GLTile> {
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private lutTexture!: WebGLTexture;
  private uniforms!: Record<string, WebGLUniformLocation>;
  private contextLost = false;

  protected initContext(): void {
    const gl = this.canvas.getContext("webgl2", { alpha: false });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.compileShaders();
    this.createQuadVAO();
    this.createLUTTexture();
    this.setupContextLossHandlers();
  }

  protected createTile(startRow, dataStartKHz, dataEndKHz): GLTile {
    // gl.createTexture, gl.texImage2D(R8, empty)
  }

  protected writeRow(tile: GLTile, bins: Uint8Array, rowIndex: number): void {
    // gl.texSubImage2D — upload raw bytes, no color mapping
  }

  protected drawFrame(): void {
    // gl.clear, bind LUT, set level uniforms
    // for each visible tile: bind texture, set rect uniforms, drawArrays
  }

  protected onLevelsChanged(): void { /* no-op — uniforms updated in drawFrame */ }

  protected onResize(w: number, h: number): void {
    this.gl.viewport(0, 0, w, h);
  }

  protected destroyTile(tile: GLTile): void {
    if (tile.texture) this.gl.deleteTexture(tile.texture);
    tile.texture = null;
  }

  protected onDestroy(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteTexture(this.lutTexture);
  }

  // GL-only public method
  setColorMap(name: ColorMapName): void {
    // rebuild 256×1 LUT texture from WATERFALL_COLOR_MAPS[name]
  }
}
```

### Shader program

Single program, same as before:

**Vertex shader** — unit quad positioned by `u_srcRect`/`u_dstRect` uniforms:

```glsl
#version 300 es
in vec2 a_pos;
uniform vec4 u_srcRect;   // (x, y, w, h) in UV space [0,1]
uniform vec4 u_dstRect;   // (x, y, w, h) in pixels
uniform vec2 u_resolution;
out vec2 v_uv;

void main() {
  v_uv = u_srcRect.xy + a_pos * u_srcRect.zw;
  vec2 px = u_dstRect.xy + a_pos * u_dstRect.zw;
  vec2 ndc = (px / u_resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
```

**Fragment shader** — dB → normalize → LUT lookup:

```glsl
#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_data;
uniform sampler2D u_lut;
uniform float u_minLevel;
uniform float u_maxLevel;

void main() {
  float raw = texture(u_data, v_uv).r;
  float dBm = raw * 255.0 - 255.0;
  float t = clamp((dBm - u_minLevel) / (u_maxLevel - u_minLevel), 0.0, 1.0);
  fragColor = texture(u_lut, vec2(t, 0.5));
}
```

### Tile texture format

R8 (1 byte/texel), 1024 × 256 = 256 KB per tile (vs 1 MB RGBA canvas).

### Context loss handling

```ts
this.canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  this.contextLost = true;
  this.stopRenderLoop();
});
this.canvas.addEventListener("webglcontextrestored", () => {
  this.contextLost = false;
  this.initContext();
  this.restoreTileTextures();  // re-upload rawBins for all tiles
  this.startRenderLoop();
});
```

`rawBins` is the recovery source, same as how Canvas 2D uses it for
`reRenderTile`.

---

## Display component (waterfall-display-gl.tsx)

Simpler than the Canvas 2D display — no SVG filter needed:

```tsx
export const WaterfallDisplayGL = forwardRef<WaterfallHandle, Props>(
  function WaterfallDisplayGL({ className, timelineRef }, ref) {
    // Same structure as WaterfallDisplay:
    //   containerRef, canvasRef, rendererRef, overlayRef
    //   useBandViewStore subscription
    //   useImperativeHandle (identical)
    //   ResizeObserver effect
    //   cleanup on unmount

    // Different:
    //   - Instantiates WaterfallRendererGL (not WaterfallRenderer)
    //   - Subscribes to colorMapName, calls renderer.setColorMap()
    //   - No SVG filter element in JSX
    //   - No filter CSS on canvas

    // JSX:
    //   <div container>
    //     <canvas />
    //     <WaterfallOverlayLayer ref={overlayRef} />
    //   </div>
  }
);
```

The overlay layer (`WaterfallOverlayLayer`) is reused as-is — it's
renderer-agnostic (DOM elements positioned via the `OverlayState` the
base class emits).

---

## Implementation order

### Phase 1: Extract base class

1. Create `waterfall-renderer-base.ts` with `BaseTile`, `ChunkEntry<T>`,
   `OverlayState`, `RendererOptions`, and `WaterfallRendererBase<T>`
2. Move all shared logic from `waterfall-renderer.ts` into the base class
3. Refactor `waterfall-renderer.ts` to extend the base class, implementing
   the 8 abstract methods with the existing Canvas 2D code
4. `waterfall-renderer.ts` re-exports `OverlayState` and `RendererOptions`
   so existing imports don't break
5. Verify: existing waterfall works identically after the refactor

### Phase 2: WebGL renderer + display component

6. Create `waterfall-renderer-gl.ts` extending the base class — implement
   `initContext`, `createTile`, `writeRow`, `drawFrame`, `destroyTile`,
   `onResize`, `onDestroy`, `onLevelsChanged`, `setColorMap`
7. Create `waterfall-display-gl.tsx`
8. Verify: live waterfall streaming works with the GL renderer
9. Verify: chunk loading, scrolling, markers all work

### Phase 3: Robustness

10. Add context loss/restore handlers
11. Test context loss recovery

---

## Risk / tradeoffs

| Risk | Mitigation |
|---|---|
| Refactoring existing renderer introduces bugs | Purely structural change — extract to base class, no algorithm changes. Existing tests still pass. |
| WebGL2 not available | Throw on construction; consumer falls back to Canvas 2D display |
| Context loss during streaming | `rawBins` retained on all tiles; full state restore on `webglcontextrestored` |
| Texture memory limits | Same eviction logic as current renderer; R8 textures are 4× smaller than RGBA canvases |
| Debugging harder | Keep PerfBucket instrumentation; `streamLog` at same points |
