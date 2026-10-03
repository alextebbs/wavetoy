# BROWSER.md — 30-Day Chunk Browser

## Problem

The minimap/timeline is currently a simple scrollbar thumb mapped to waterfall
rows. The manifest is fetched once for a 24-hour window and every chunk is
assigned a row index in memory. This doesn't scale to 30 days of chunks
(~43,200 one-minute chunks) for three reasons:

1. **Metadata bloat** — Fetching 43k `ChunkMeta` objects in a single manifest
   call is wasteful and slow on page load.
2. **Row coordinate overflow** — Each chunk is ~60 waterfall frames. 43k chunks
   × 60 frames = ~2.6M rows. The scrollbar thumb becomes a single pixel, and
   integer precision in scroll offsets starts to matter.
3. **No temporal context** — The scrollbar shows a thumb and chunk boundary
   ticks, but gives no indication of *when* things happened. You can't jump to
   "last Tuesday" or see where gaps/activity clusters are.

## Design

Replace the single scrollbar with a two-level navigation system:

```
┌─────────────────────────────────────────────────────┐
│  54 px sidebar (same width as today)                │
│                                                     │
│  ┌─ Status indicator ──────────────────────────┐    │
│  │  LIVE / SCROLLBACK / PLAYBACK               │    │
│  ├─ Snap-to-live button ───────────────────────┤    │
│  │  ↑ or pulsing dot                           │    │
│  ├─ Day strip (top-level nav) ─────────────────┤    │
│  │  Vertical stack of day cells, each ~28 px   │    │
│  │  tall. Scrollable if > ~20 days. Selected   │    │
│  │  day highlighted. Activity heatmap per day.  │    │
│  ├─ Hour rail (second-level nav) ──────────────┤    │
│  │  24 rows for the selected day (or a         │    │
│  │  contiguous 24h window). Each row ~14 px.   │    │
│  │  Activity density bar per hour. Click to     │    │
│  │  jump. Selected hour highlighted.            │    │
│  ├─ Local scrollbar ──────────────────────────┤    │
│  │  Same thumb+track as today, but only for    │    │
│  │  the *loaded window* of chunks (~2-4 hours  │    │
│  │  around the viewport). Chunk boundary ticks │    │
│  │  rendered as before.                         │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Interaction model

| Action | Result |
|--------|--------|
| Click a day cell | Load that day's hour-rail density. Jump waterfall to midnight of that day (or first chunk). |
| Click an hour cell | Fetch manifest window centered on that hour. Jump waterfall to the start of that hour. |
| Scroll the local scrollbar | Same as today — scroll through loaded chunk rows. |
| Scroll past the edge of the loaded window | Auto-extend: fetch the next/previous hour of chunks and splice them in. |
| Wheel on the day strip | Scroll through days (if > screen height). |

## Data model changes

### New lightweight endpoint: `GET /api/streams/{id}/chunk-summary`

Returns per-day and per-hour chunk counts without full `ChunkMeta` objects.
This is what populates the day strip and hour rail on initial load and day
selection.

```jsonc
// Response
{
  "stream_id": "abc",
  "days": [
    {
      "date": "2026-03-19",           // calendar date (UTC)
      "chunk_count": 1440,
      "wf_frames": 86400,
      "has_gaps": false,
      "hours": [                       // 0-23
        { "hour": 0, "chunk_count": 60, "wf_frames": 3600 },
        { "hour": 1, "chunk_count": 58, "wf_frames": 3480 },
        // ...
      ]
    },
    // ... up to 30 entries
  ]
}
```

Backend implementation: a single SQL query against `offloaded_chunks` grouped
by `date_trunc('day', started_at)` and `extract(hour from started_at)`, merged
with any in-ring chunks for the current day.

### Windowed manifest loading

Instead of fetching the full 24h manifest up front, the frontend fetches
a **window** of 2–4 hours of `ChunkMeta` at a time via the existing
`/manifest/{from}/{to}` endpoint. As the user scrolls near the edge of the
window, adjacent hours are fetched and spliced in.

```
          loaded window
       ┌──────────────────┐
───────┤  2h of chunks    ├───────  ← full timeline
       └──────────────────┘
        ↑ scroll past here triggers fetch of previous hour
                           ↑ scroll past here triggers fetch of next hour
```

## Implementation plan

### Phase 1 — Backend: chunk summary endpoint

1. **Add `ChunkSummaryByHour` query** to `internal/db/monitor.go`.
   - SQL: `SELECT date_trunc('day', started_at) AS day, extract(hour ...) AS hour, count(*), sum(wf_frames) FROM offloaded_chunks WHERE stream_id = $1 AND started_at >= $2 GROUP BY 1, 2 ORDER BY 1, 2`.
   - Merge with ring-buffer chunk counts for the current partial day.

2. **Add `GET /api/streams/{id}/chunk-summary`** handler in `internal/api/stream_rewind.go`.
   - Accepts optional `?days=30` query param (default 30, max 30).
   - Returns the JSON shape above.

3. **Wire route** in `internal/api/api.go`.

### Phase 2 — Frontend: summary store and day/hour strip

4. **Create `chunk-summary-store.ts`** (Zustand or simple ref-based store).
   - Fetches `/chunk-summary` on stream connect.
   - Exposes `days[]`, selected day, selected hour.
   - Provides `selectDay(date)` and `selectHour(date, hour)` actions.

5. **Create `DayStrip` component** (within the 54 px sidebar).
   - Renders a vertical list of day cells.
   - Each cell shows abbreviated date (e.g. "Mar 19") and a tiny activity bar
     (width proportional to `chunk_count / 1440`).
   - Today is at the top; scroll down for older days.
   - Click selects day → loads hour rail → jumps waterfall.

6. **Create `HourRail` component** (within the 54 px sidebar, below the day strip).
   - 24 rows, compact (~14 px each).
   - Each row shows hour label and a density bar.
   - Click selects hour → triggers windowed manifest load → jumps waterfall.

7. **Integrate into `WaterfallTimeline`**.
   - Replace the single full-height track with three zones: day strip, hour
     rail, local scrollbar.
   - Proportions configurable but default: day strip 40%, hour rail 30%,
     scrollbar 30% of the available height.

### Phase 3 — Windowed manifest loading

8. **Refactor `WaterfallRendererBase.loadManifest`** to support incremental
   manifest loading.
   - New method: `extendManifest(chunks, direction: 'before' | 'after')` that
     splices new `ChunkEntry` items and adjusts row indices.
   - Existing `loadManifest` becomes a full reset (used on initial load and
     day/hour jumps).

9. **Add edge-detection in `checkViewport`**.
   - When the viewport is within N rows of the oldest/newest loaded chunk,
     emit an event or call a callback: `onNeedMoreChunks(direction)`.
   - The stream player page handles this by fetching the next hour's manifest
     and calling `extendManifest`.

10. **Add eviction of distant manifest windows**.
    - When the loaded window exceeds ~6 hours of chunks, evict the farthest
      hour's `ChunkEntry` objects (tiles are already evicted by the existing
      `EVICT_DISTANCE_ROWS` logic; this also drops the metadata).
    - Update `lowestStartRow` / row indices accordingly.

### Phase 4 — Jump-to-time and polish

11. **Jump-to-time function**.
    - When clicking a day or hour cell, compute `from`/`to` for the manifest
      window, fetch it, call `loadManifest` (full reset), and set
      `scrollOffset` to place the target time at the top of the viewport.
    - Update the scrub controller and historical audio player to handle the
      new chunk set.

12. **Scroll continuity**.
    - When `extendManifest` splices chunks before the current window, adjust
      `scrollOffset` by the number of added rows so the viewport doesn't jump.
    - Same adjustment in `computeThumbLayout` for the local scrollbar.

13. **Loading states**.
    - Show a subtle spinner or shimmer in the hour rail while the manifest
      window is being fetched.
    - If the user scrolls past the loaded window before the next window is
      ready, show a "Loading..." row in the waterfall gap area.

14. **Timestamp labels on the local scrollbar**.
    - Render small time labels (e.g. "14:30") at interval positions in the
      scrollbar track, derived from chunk `started_at` timestamps.
    - Use the same tick DOM pool approach as the current chunk boundary ticks.

### Phase 5 — Stretch goals

15. **Keyboard shortcuts**: arrow keys to move between hours/days.
16. **URL-addressable time**: `?t=1711036800` query param to deep-link to a
    specific timestamp.
17. **Activity heatmap colors**: use event count or interpreter hit count to
    color day/hour cells (green = quiet, yellow = moderate, red = busy).
18. **Minimap preview**: render a tiny 1px-per-chunk waterfall thumbnail in the
    hour rail cells using pre-computed min/max bin values stored in the chunk
    summary.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Row index arithmetic breaks when splicing chunks | Unit-test `extendManifest` with various splice scenarios before wiring UI. |
| Scroll offset jumps when prepending chunks | Compensate offset atomically inside `extendManifest` before the next `drawFrame`. |
| Large summary response for dense streams | Cap at 30 days server-side. Summary payload is ~30 × 24 × ~50 bytes ≈ 36 KB — fine. |
| S3 latency when jumping far back | The manifest fetch is metadata-only (from Postgres); actual chunk data is lazy-loaded on viewport entry. S3 proxy latency only matters when tiles enter the viewport. |
| 54 px sidebar is very tight | Day labels use 3-letter month + day number. Hour labels use 2-digit hour. Density bars are 2 px tall lines. Tested at 54 px and it fits. |

## File change map

| File | Change |
|------|--------|
| `internal/db/monitor.go` | Add `ChunkSummaryByHour` query |
| `internal/api/stream_rewind.go` | Add `streamChunkSummary` handler |
| `internal/api/api.go` | Wire new route |
| `frontend/src/lib/api.ts` | Add `fetchChunkSummary` |
| `frontend/src/lib/chunk-loader.ts` | Add `ChunkSummary` types |
| `frontend/src/lib/chunk-summary-store.ts` | **New** — summary store |
| `frontend/src/components/waterfall/waterfall-timeline.tsx` | Refactor into day strip + hour rail + local scrollbar |
| `frontend/src/components/waterfall/waterfall-renderer-base.ts` | Add `extendManifest`, edge-detection in `checkViewport` |
| `frontend/src/routes/stream-player-page.tsx` | Wire summary fetch, handle `onNeedMoreChunks` |
