# ChunkManager Extraction Plan

## Problem

`WaterfallRendererBase` is a 1400-line monolith that conflates six concerns:
manifest management, coordinate system, marker computation, tile loading,
GL rendering, and live data ingestion. The minimap is a passive view with
no ability to drive manifest loading. Manifest wiring (edge detection,
window tracking, 6-hour eviction) lives in `stream-player-page.tsx` as 80
lines of glue that doesn't belong in a page component.

The coordinate system bug we just fixed (extendManifest shifting chunks but
not `totalRows`/live tiles) was a direct consequence of this entanglement —
too many concerns sharing mutable state with no clear invariants.

## Goal

Extract a **`ChunkManager`** class that owns the manifest, coordinate system,
scroll state, and edge detection. Both the renderer and the minimap consume
it. The renderer keeps tile management and GL concerns. The minimap gains
direct access to chunk metadata and the ability to trigger manifest extension.

## What moves to ChunkManager

### From `WaterfallRendererBase`

| Field / Method | Currently | Notes |
|---|---|---|
| `chunks: ChunkEntry[]` | renderer | Moves. ChunkManager owns the sorted chunk list. Entries lose the `tiles`, `loaded`, `loading` fields — those stay in the renderer as a parallel tile-tracking structure. |
| `gaps: GapEntry[]` | renderer | Moves. |
| `markers: Map<string, WaterfallMarker>` | renderer | Moves. |
| `totalRows` | renderer | Moves. The renderer calls `manager.advanceLive()` when a row is appended. |
| `scrollOffset` | renderer | Moves. Both the minimap and renderer read it. The minimap writes it (user scroll). The renderer writes it (auto-advance for live, drag scroll). |
| `lowestStartRow` | renderer | Moves. |
| `liveChunkStartRow` | renderer | Moves. |
| `liveChunkStartedAt` | renderer | Moves. |
| `liveFrameCount` | renderer | Moves. |
| `streamSampleRate` | renderer | Moves. |
| `streamChunkDurationS` | renderer | Moves. |
| `loadManifest()` | renderer | Moves. Returns the row assignments; no longer triggers tile loads directly. |
| `extendManifest()` | renderer | Moves. The coordinate shifting (including `totalRows`, live tiles, scroll) lives here with clear invariants. |
| `evictManifestWindow()` | renderer | Moves. |
| `onChunkComplete()` | renderer | Moves. Updates chunk metadata and row assignments. |
| `maxScrollOffset` (getter) | renderer | Moves. Computed from `totalRows`, `lowestStartRow`, and `history-end` marker. Needs `visibleRows` as a parameter (the manager doesn't know the canvas size). |
| `addMarker()` / `removeMarker()` | renderer (private) | Moves and becomes the manager's public API for markers. |
| `onNeedMoreChunks` callback | renderer | Moves. |
| `edgeRequestCooldown` | renderer | Moves (edge detection lives here). |

### From `stream-player-page.tsx`

| Field / Method | Currently | Notes |
|---|---|---|
| `loadedWindowRef` | player page | Moves into ChunkManager. The manager tracks the loaded time window. |
| `extendingRef` | player page | Moves. The manager guards concurrent extends internally. |
| `onNeedMoreChunks` wiring | player page (80 lines) | The manager owns this end-to-end. It holds the `ChunkSource`, computes the fetch window, calls `fetchManifest`, runs `extendManifest`, and manages the 6-hour eviction window. The player page just calls `manager.init(streamId)`. |

## What stays in the renderer

| Concern | Why it stays |
|---|---|
| `liveTiles: T[]`, `liveTile: T` | Tile creation/destruction is backend-specific (GL textures). |
| `createTile()`, `destroyTile()`, `writeRow()` | Abstract methods implemented by GL backend. |
| `drawFrame()` | Pure rendering. |
| `fetchChunk()` | Loads binary WF data and inserts into tiles. Uses the manager's chunk metadata for row positions but manages its own tile array. |
| `retireLiveTiles()`, `pruneLiveTiles()` | Tile lifecycle. |
| `checkViewport()` | Decides which chunks need tiles loaded. Reads chunk list and coordinates from the manager. Calls its own `fetchChunk()`. |
| `evictDistant()` | Tile-level eviction (destroys GL textures). Uses distance from manager's coordinates. |
| `appendToLiveTile()` | Writes incoming live bins into the current tile, then calls `manager.advanceLive()`. |
| Canvas, GL context, color mapping, auto-level, view range | Pure renderer concerns. |

## What the minimap gains

| Capability | How |
|---|---|
| Direct chunk/marker access | Reads `manager.chunks`, `manager.markers` instead of receiving them via `update()` relay. |
| Edge detection | Checks if the minimap's visible range approaches the manifest edge. Calls `manager.requestExtend("before" | "after")`. |
| Scroll ownership | The manager's `scrollOffset` is the source of truth. The minimap writes to it directly. The renderer reads from it each frame. |
| Independence from renderer frame rate | The minimap currently updates only when the renderer calls `update()` (once per rAF). With direct manager access, it can read state at any time. |

## ChunkManager Interface

```typescript
interface ChunkInfo {
  startedAt: number;
  sourceId: string;
  startRow: number;
  frameCount: number;
  complete: boolean;
  expectedWF: number;
  audioBytes: number;
}

interface GapInfo {
  startRow: number;
  rowCount: number;
}

class ChunkManager {
  // ── Lifecycle ──
  constructor(streamId: string);
  async init(source: ChunkSource, windowHours?: number): Promise<void>;
  destroy(): void;

  // ── Chunk list (read-only views) ──
  get chunks(): ReadonlyArray<ChunkInfo>;
  get gaps(): ReadonlyArray<GapInfo>;
  get markers(): ReadonlyMap<string, WaterfallMarker>;

  // ── Coordinate system ──
  get totalRows(): number;
  get lowestStartRow(): number;
  maxScrollOffset(visibleRows: number): number;

  // ── Scroll state ──
  get scrollOffset(): number;
  setScrollOffset(offset: number, visibleRows: number): void;
  get isLive(): boolean;

  // ── Live data ──
  advanceLive(): void;                // called by renderer per row appended
  get liveFrameCount(): number;
  resetLiveFrameCount(): void;
  get liveChunkStartRow(): number;
  get liveChunkStartedAt(): number | null;

  // ── Manifest mutations ──
  loadManifest(
    metas: ChunkMeta[],
    streamInfo?: { sampleRate: number; chunkDurationS: number },
  ): number;  // returns totalFrames added

  extendManifest(
    metas: ChunkMeta[],
    direction: "before" | "after",
  ): number;  // returns count added

  onChunkComplete(msg: ChunkCompleteMsg): void;

  // ── Manifest window ──
  requestExtend(direction: "before" | "after"): void;

  // ── Subscriptions ──
  onMarkerAdd: ((m: WaterfallMarker) => void) | null;
  onMarkerRemove: ((id: string) => void) | null;
  onChange: (() => void) | null;  // fires after any state mutation
}
```

## Renderer changes

The renderer no longer stores `chunks`, `gaps`, `markers`, `totalRows`,
`scrollOffset`, `lowestStartRow`, or any manifest-related state. Instead
it holds a reference to the `ChunkManager` and reads from it.

The renderer keeps a parallel **tile registry** keyed by `startedAt`:

```typescript
interface TileEntry<T extends BaseTile> {
  startedAt: number;
  tiles: T[];
  loaded: boolean;
  loading: boolean;
  failCount: number;
  nextRetryAt: number;
}
```

`checkViewport()` iterates `manager.chunks`, looks up the corresponding
`TileEntry`, and decides whether to fetch. `evictDistant()` destroys tile
entries that are far from the viewport. `drawFrame()` iterates `manager.chunks`
and draws tiles from the registry.

The renderer subscribes to `manager.onChange` to trigger repaints when the
manager's state changes (e.g., after `extendManifest` shifts coordinates).

`appendToLiveTile()` calls `manager.advanceLive()` after writing a row.

`flush()` reads `manager.scrollOffset` and `manager.totalRows` for its
overlay state emission.

## Minimap changes

The minimap receives `manager: ChunkManager` as a prop instead of
relying on `update(state, markers)` from the renderer.

```typescript
interface WaterfallMinimapProps {
  manager: ChunkManager;
  spectrumHeight: number;
  isPlayingHistory?: boolean;
  onSnapToLive: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}
```

The minimap subscribes to `manager.onChange` to re-render when state
changes. It reads `manager.scrollOffset`, `manager.totalRows`,
`manager.markers`, etc. directly.

Scroll interaction writes directly to `manager.setScrollOffset()`.
The renderer picks up the new offset on the next frame.

The minimap checks its own visible range against the manifest edges
and calls `manager.requestExtend("before")` when the user scrolls near
the oldest loaded chunk in the minimap view.

`onScrollOffset` prop is removed — the minimap writes directly to the
manager. The player page subscribes to `manager.onChange` for side effects
(spectrum updates, URL, scrub audio).

## Player page changes

The player page creates the `ChunkManager` and passes it to both the
`WaterfallDisplayGL` and `WaterfallMinimap`:

```tsx
const manager = useRef(new ChunkManager(streamId));

<WaterfallMinimap manager={manager.current} ... />
<WaterfallDisplayGL manager={manager.current} ... />
```

The 80 lines of manifest wiring (`onNeedMoreChunks`, `loadedWindowRef`,
`extendingRef`, fetch/extend/evict) move into `ChunkManager.init()` and
`ChunkManager.requestExtend()`.

The player page subscribes to `manager.onChange` for side effects that
need to happen on scroll changes (spectrum sync, URL update, scrub audio).

## OverlayState changes

`OverlayState` shrinks. Fields that now live in the manager are read
directly from the manager:

```typescript
// Before
interface OverlayState {
  totalRows: number;      // → manager.totalRows
  scrollOffset: number;   // → manager.scrollOffset
  maxScrollOffset: number; // → manager.maxScrollOffset(visibleRows)
  rowScale: number;        // stays (renderer-specific)
  height: number;          // stays (canvas-specific)
  dpr: number;             // stays
  isLive: boolean;         // → manager.isLive
  playbackRow: number | null; // stays (renderer/player concern)
}
```

`OverlayState` may become just `{ rowScale, height, dpr, playbackRow }`
with the rest read from the manager. Or we keep it as a computed snapshot
for the overlay layer, which doesn't need the manager reference.

## Migration strategy

### Phase 1: Extract ChunkManager class (no consumer changes)

1. Create `frontend/src/lib/chunk-manager.ts`.
2. Move manifest fields and methods from `WaterfallRendererBase`.
3. The renderer instantiates `ChunkManager` internally and delegates to it.
4. All existing tests and behavior are preserved — this is a pure refactor
   with no API changes to the renderer or minimap.

### Phase 2: Surface the manager

1. The renderer accepts `ChunkManager` as a constructor parameter instead
   of creating its own.
2. `stream-player-page.tsx` creates the manager and passes it to the renderer.
3. Move the manifest wiring from the player page into the manager.

### Phase 3: Connect the minimap

1. Pass the manager to the minimap.
2. The minimap reads directly from the manager instead of `update()`.
3. Add minimap edge detection: `manager.requestExtend()` when minimap
   scrolls near the manifest edge.
4. Remove the `onScrollOffset` prop chain — the minimap writes directly
   to `manager.setScrollOffset()`.

### Phase 4: Side effect consolidation

1. The player page subscribes to `manager.onChange` for spectrum, URL,
   and scrub audio side effects.
2. Remove `onOverlayState` from `WaterfallDisplayGL` (the overlay layer
   can also subscribe to the manager).
3. Clean up the now-unnecessary prop drilling.

## Files affected

| File | Change |
|---|---|
| `frontend/src/lib/chunk-manager.ts` | **New.** The extracted class. |
| `frontend/src/components/waterfall/waterfall-renderer-base.ts` | Remove ~400 lines of manifest/coordinate/marker logic. Add `ChunkManager` dependency. |
| `frontend/src/components/waterfall/waterfall-minimap.tsx` | Replace `update()` relay with direct manager reads. Add edge detection. |
| `frontend/src/components/waterfall/waterfall-display-gl.tsx` | Accept manager as prop. Remove manifest-forwarding imperative handle methods. |
| `frontend/src/routes/stream-player-page.tsx` | Create manager. Remove manifest wiring glue. Subscribe to `onChange`. |
| `frontend/src/components/waterfall/waterfall-overlay.tsx` | Minor: `WaterfallMarker` type may move to `chunk-manager.ts`. |
| `frontend/src/lib/chunk-loader.ts` | No changes (ChunkSource interface is already clean). |

## Risks

1. **Live tile coordination.** The renderer's `advanceLive()` → `totalRows++`
   path must be synchronous and happen in the same frame as the tile write.
   If the manager's `totalRows` drifts from the tile positions, we get the
   same class of bug we just fixed. Mitigation: `advanceLive()` is a simple
   `this.totalRows++` with no async work.

2. **Two-writer scroll.** Both the minimap (user scroll) and the renderer
   (auto-advance for live, drag scroll) can write `scrollOffset`. The manager
   must handle this without races. Mitigation: both writes go through
   `setScrollOffset()` which clamps and deduplicates.

3. **Render loop coupling.** The renderer currently reads and writes state
   in a tight `flush()` loop. With the manager external, we need to ensure
   the manager's state is consistent within a single frame. Mitigation: the
   manager has no async mutations during a frame — all async work (fetch,
   extend) resolves between frames and triggers `onChange`.
