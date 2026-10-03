# Waterfall Minimap

A 54px-wide component that provides a spatially accurate, scrollable overview of the waterfall content. The minimap establishes a direct vertical correspondence with the waterfall view to its right: the playback head indicator in the minimap aligns with the actual playback head, chunk boundaries within the viewport appear at proportionally correct positions, and scrolling either surface keeps the two in sync.

## Spatial Model

### Coordinate System

The minimap track and the waterfall canvas occupy the same vertical extent — both are `flex-1` children in the same flex row, separated only by width. This creates a 1:1 Y-coordinate mapping between any point in the track and the same point in the waterfall.

The playback head in the waterfall is fixed at `top: 10%` (see `playback-head.tsx`). The minimap's head indicator line must sit at exactly the same screen Y, which is `0.10 * trackHeight` from the top of the minimap track.

### Layout Constants

```
PLAYBACK_HEAD_FRACTION = 0.10      # matches playback-head.tsx top: "10%"
BAR_WIDTH              = 54        # component width in px
MIN_VIEWPORT_PX        = 20        # minimum viewport height
```

### Derived Values

Given `OverlayState` (from the waterfall renderer) and `trackHeight` (the minimap track's CSS height):

```
visibleRows   = ceil(state.height / state.rowScale)
totalRange    = state.maxScrollOffset + visibleRows
viewportPx    = clamp((visibleRows / totalRange) * trackHeight, MIN_VIEWPORT_PX, trackHeight)
scale         = viewportPx / visibleRows
viewportTop   = PLAYBACK_HEAD_FRACTION * (trackHeight - viewportPx)
contentHeight = viewportTop + totalRange * scale
```

- `viewportPx` — the viewport box height. Represents the visible waterfall area, scaled down. Shrinks as more content loads.
- `scale` — pixels per row in minimap space.
- `viewportTop` — Y offset of the viewport box from the top of the track. A small padding region above it ensures the head line aligns.
- `contentHeight` — total scrollable content height including the top padding.

### Head Line Alignment (Proof)

The head line sits at `PLAYBACK_HEAD_FRACTION * viewportPx` within the viewport box.

```
headScreenY = viewportTop + PLAYBACK_HEAD_FRACTION * viewportPx
            = 0.10 * (trackHeight - viewportPx) + 0.10 * viewportPx
            = 0.10 * trackHeight
```

This matches the playback head's position in the waterfall (`top: 10%`), regardless of viewport size.

### Tick Positioning

Each `WaterfallMarker` has a `row` field. Its distance from the live edge:

```
rowsFromLive = totalRows - marker.row
```

Its position in the scrollable content:

```
tickY = viewportTop + rowsFromLive * scale
```

After native scroll (`scrollTop = scrollOffset * scale`), a tick's screen position is:

```
tickScreenY = viewportTop + (rowsFromLive - scrollOffset) * scale
```

For a tick in the visible waterfall range (`scrollOffset <= rowsFromLive <= scrollOffset + visibleRows`):

```
tickScreenY ∈ [viewportTop, viewportTop + viewportPx]
```

This means visible-range ticks always land inside the viewport box — matching the waterfall.

## Visual Elements

### Viewport Box

A semi-transparent rectangle with 1px accent-colored top and bottom borders. Fixed in position (does not scroll with content). Represents the currently visible waterfall area.

### Head Indicator

A 1px horizontal line inside the viewport box at `PLAYBACK_HEAD_FRACTION * viewportPx` from the viewport's top edge. Uses the scrollback accent color. Aligns with the actual playback head.

### Chunk Boundary Ticks

1px horizontal lines at each `WaterfallMarker` position. These are inside the scrollable content and move with scroll. Ticks use `hsl(var(--foreground) / 0.3)` for normal chunk boundaries.

### Gap Indicators

When chunk timestamps are non-contiguous, the renderer produces markers with `metadata.type === "gap"`. These should be rendered differently from normal chunk boundaries:

- Draw the gap region as a hatched or dimmed band spanning the gap's row range (`metadata.gapStartRow` to `gapStartRow + gapRowCount`), scaled to minimap coordinates.
- Use a distinct color (e.g., `hsl(var(--destructive) / 0.15)` background with `hsl(var(--destructive) / 0.4)` border lines at the top and bottom of the gap).

### Data Boundary Markers

The start and end of available data (when the manifest has no more chunks in either direction) should be marked with special borders:

- **Oldest data boundary (bottom):** When the manifest returns no earlier chunks (no more "before" data), draw a distinctive bottom border — e.g., a 2px dashed line in the muted foreground color, or a small "end of history" indicator.
- **Newest data boundary (top):** When at the live edge (`scrollOffset === 0`), the top of the content is the live edge — no special marker needed. When viewing historical data and the manifest has no newer chunks, draw a matching top border.
- Track whether each boundary has been reached via flags set when `fetchManifest` returns fewer chunks than expected or an empty result.

## Scroll Interaction

### Minimap → Waterfall

The scrollable div uses native `overflow-y: auto`. On scroll:

```
scrollOffset = clamp(round(scrollTop / scale), 0, maxScrollOffset)
→ onScrollOffset(scrollOffset)
→ waterfall.setScrollOffset(scrollOffset)
```

### Waterfall → Minimap

When the waterfall renderer calls `update(state, markers)`:

```
if not user-scrolling:
    scrollTop = scrollOffset * scale
```

### Click-to-Jump

Clicking anywhere in the track jumps the waterfall to that position:

```
clickRowsFromLive = (clickY - viewportTop + scrollTop) / scale
scrollOffset = clamp(round(clickRowsFromLive - visibleRows / 2), 0, maxScrollOffset)
```

### Drag Start / End

Fire `onDragStart` when scroll begins. Fire `onDragEnd` 150ms after scroll stops (debounced). The player page uses these to pause/resume audio scrubbing.

## Infinite Loading

### Mechanism

The minimap does not independently fetch chunk data. It receives markers from the waterfall renderer via the `update(state, markers)` callback. The waterfall renderer already implements edge detection and calls `onNeedMoreChunks("before" | "after")` when the user scrolls near the boundary of loaded content (see `waterfall-renderer-base.ts` flush logic).

The stream player page handles `onNeedMoreChunks` by calling `fetchManifest(from, to)` and feeding the result back via `extendManifest(chunks, direction)`. This produces new markers, which flow to the minimap on the next `update()`.

### What the Minimap Needs to Do

1. **Respond to growing content.** As new markers arrive, the minimap recalculates `totalRange`, `scale`, `viewportPx`, and repositions ticks. The viewport may shrink as more content loads.

2. **Maintain scroll position.** When new content is prepended (direction "before"), the inner content grows at the bottom. Native scroll position may need adjustment to keep the current view stable.

3. **Track data boundaries.** The minimap should accept two boolean flags (or derive them from markers):
   - `hasOlderData` — false when the manifest returned empty for "before". Triggers the bottom data-end border.
   - `hasNewerData` — false when at the live edge or manifest returned empty for "after". Triggers the top data-end border.

   These can be passed as props or inferred from the presence of a `history-end` marker.

## Component Interface

### Props

```typescript
interface WaterfallMinimapProps {
  spectrumHeight: number;
  isPlayingHistory?: boolean;
  onScrollOffset: (offset: number) => void;
  onSnapToLive: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}
```

### Imperative Handle

```typescript
interface WaterfallMinimapHandle {
  update(state: OverlayState, markers: WaterfallMarker[]): void;
}
```

Same signature as the current `WaterfallTimelineHandle` — drop-in replacement.

### DOM Structure

```
<div flex-col, width=54px, border-r, bg-background>

  <!-- Status label: LIVE / SCROLLBACK / PLAYBACK -->
  <div height={spectrumHeight}, vertical text, colored background />

  <!-- Live dot or snap-to-live button -->
  <div height={FREQ_SCALE_HEIGHT} />

  <!-- Minimap track -->
  <div relative, flex-1, border-t, bg-muted/50>

    <!-- Viewport box (fixed position, pointer-events-none) -->
    <div absolute, top={viewportTop}, height={viewportPx}>
      <div 1px head-line at top={HEAD_FRACTION * viewportPx} />
    </div>

    <!-- Scrollable content (on top, captures events) -->
    <div absolute, inset-0, overflow-y-auto, z-10>
      <div relative, height={contentHeight}>
        <!-- 1px tick divs for chunk boundaries -->
        <!-- gap bands for non-contiguous regions -->
        <!-- data-end borders at top/bottom when applicable -->
      </div>
    </div>

  </div>
</div>
```

## File Changes

1. **Create** `frontend/src/components/waterfall/waterfall-minimap.tsx` — the new component.
2. **Update** `frontend/src/components/waterfall/waterfall-display-gl.tsx` — change import and ref type from `WaterfallTimelineHandle` to `WaterfallMinimapHandle`.
3. **Update** `frontend/src/routes/stream-player-page.tsx` — change import and JSX from `WaterfallTimeline` to `WaterfallMinimap`.
4. **Delete** `frontend/src/components/waterfall/waterfall-timeline.tsx` — replaced by the minimap.
