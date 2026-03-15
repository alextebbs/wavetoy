# FAVORITES.md — Tenant-Scoped Source Favorites

## Overview

Let tenants mark KiwiSDR sources as favorites. Favorites are a simple
tenant-level binding — a row that says "this tenant likes this source." They
surface in two places:

1. **Source details panel** — a star/heart button to toggle the favorite state.
2. **Globe overlay** — favorite markers are visually distinct on the map, and a
   new left-side search panel lets the user browse and filter sources
   (favorites vs. all), with globe fly-to on click.

No user-level identity exists (AUTH.md), so favorites are scoped to the tenant.
All users sharing a passphrase share the same favorites list.

---

## Current State

| What | Status |
|------|--------|
| `favorite_sources` table | Does not exist |
| Favorite toggle in UI | None |
| Source search/filter panel | None |
| Map marker differentiation for favorites | None |
| API endpoint for favorites | None |

Sources are selected via the globe overlay (`SourceOverlay`). The overlay has a
full-screen globe on the left and a right sidebar (380px) that slides in when a
source is selected. There is no left panel. The `SourceDetailsPanel` shows
source metadata (host, port, SNR, grid, etc.) but has no favorite action.

---

## Database

### Migration: `014_favorite_sources.up.sql`

```sql
CREATE TABLE favorite_sources (
    tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, source_id)
);

CREATE INDEX idx_favorite_sources_tenant ON favorite_sources(tenant_id);
```

### Migration: `014_favorite_sources.down.sql`

```sql
DROP TABLE IF EXISTS favorite_sources;
```

The table is tiny — a tenant will have at most a few dozen favorites out of
~5,000 sources. The composite primary key prevents duplicates and makes
toggle-off a simple `DELETE ... WHERE tenant_id = $1 AND source_id = $2`.

No additional columns needed. If we want notes or labels on favorites later,
add them then. Keep it minimal now.

---

## Backend

### Model

No new struct needed — a favorite is just a `(tenant_id, source_id)` pair.
The API returns source IDs and the frontend already has the full source objects
loaded.

### DB Queries (`internal/db/favorites.go`)

```go
package db

import "context"

func (db *DB) ListFavoriteSourceIDs(ctx context.Context, tenantID string) ([]string, error) {
    rows, err := db.Pool.Query(ctx, `
        SELECT source_id FROM favorite_sources
        WHERE tenant_id = $1
        ORDER BY created_at
    `, tenantID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var ids []string
    for rows.Next() {
        var id string
        if err := rows.Scan(&id); err != nil {
            return nil, err
        }
        ids = append(ids, id)
    }
    return ids, rows.Err()
}

func (db *DB) IsFavoriteSource(ctx context.Context, tenantID, sourceID string) (bool, error) {
    var exists bool
    err := db.Pool.QueryRow(ctx, `
        SELECT EXISTS(
            SELECT 1 FROM favorite_sources
            WHERE tenant_id = $1 AND source_id = $2
        )
    `, tenantID, sourceID).Scan(&exists)
    return exists, err
}

func (db *DB) AddFavoriteSource(ctx context.Context, tenantID, sourceID string) error {
    _, err := db.Pool.Exec(ctx, `
        INSERT INTO favorite_sources (tenant_id, source_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
    `, tenantID, sourceID)
    return err
}

func (db *DB) RemoveFavoriteSource(ctx context.Context, tenantID, sourceID string) error {
    _, err := db.Pool.Exec(ctx, `
        DELETE FROM favorite_sources
        WHERE tenant_id = $1 AND source_id = $2
    `, tenantID, sourceID)
    return err
}
```

All queries are simple and indexed. `ON CONFLICT DO NOTHING` makes
`AddFavoriteSource` idempotent — double-clicking the star doesn't error.

### API Endpoints (`internal/api/favorites.go`)

Three new routes, all behind `requireAuth`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/favorites` | List the tenant's favorite source IDs |
| `PUT` | `/api/favorites/{sourceId}` | Add a source to favorites |
| `DELETE` | `/api/favorites/{sourceId}` | Remove a source from favorites |

```go
func (s *Server) listFavorites(w http.ResponseWriter, r *http.Request) {
    tenantID := TenantID(r.Context())
    ids, err := s.db.ListFavoriteSourceIDs(r.Context(), tenantID)
    if err != nil {
        writeError(w, http.StatusInternalServerError, "failed to list favorites", "INTERNAL")
        return
    }
    if ids == nil {
        ids = []string{}
    }
    writeJSON(w, http.StatusOK, ids)
}

func (s *Server) addFavorite(w http.ResponseWriter, r *http.Request) {
    tenantID := TenantID(r.Context())
    sourceID := chi.URLParam(r, "sourceId")
    if sourceID == "" {
        writeError(w, http.StatusBadRequest, "missing source id", "BAD_REQUEST")
        return
    }
    if err := s.db.AddFavoriteSource(r.Context(), tenantID, sourceID); err != nil {
        writeError(w, http.StatusInternalServerError, "failed to add favorite", "INTERNAL")
        return
    }
    w.WriteHeader(http.StatusNoContent)
}

func (s *Server) removeFavorite(w http.ResponseWriter, r *http.Request) {
    tenantID := TenantID(r.Context())
    sourceID := chi.URLParam(r, "sourceId")
    if sourceID == "" {
        writeError(w, http.StatusBadRequest, "missing source id", "BAD_REQUEST")
        return
    }
    if err := s.db.RemoveFavoriteSource(r.Context(), tenantID, sourceID); err != nil {
        writeError(w, http.StatusInternalServerError, "failed to remove favorite", "INTERNAL")
        return
    }
    w.WriteHeader(http.StatusNoContent)
}
```

#### Why not `POST /api/favorites` with a body?

`PUT /api/favorites/{sourceId}` is idempotent, self-documenting, and doesn't
need a request body. The source ID in the URL makes it easy to call from the
frontend with no serialization. Same for `DELETE`.

### Router Changes (`internal/api/api.go`)

Add inside the `protected` group:

```go
protected.Get("/favorites", s.listFavorites)
protected.Put("/favorites/{sourceId}", s.addFavorite)
protected.Delete("/favorites/{sourceId}", s.removeFavorite)
```

### Augmenting Existing Source Endpoints

The existing `GET /api/sources/map` response does **not** change. Favorites are
fetched separately via `GET /api/favorites`. The frontend joins them client-side.

Why: The map sources endpoint is shared across all tenants conceptually (sources
are global), while favorites are tenant-scoped. Mixing them would require either
passing tenant context into the source query (complicating caching) or returning
a heterogeneous response. Keeping them separate is cleaner and lets the frontend
cache each independently.

---

## Frontend

### API Functions (`lib/api.ts`)

```typescript
export async function listFavorites(): Promise<string[]> {
  return apiGet<string[]>("/favorites");
}

export async function addFavorite(sourceId: string): Promise<void> {
  const res = await fetch(`/api/favorites/${sourceId}`, {
    method: "PUT",
    headers: { ...authHeaders() },
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(await res.text());
}

export async function removeFavorite(sourceId: string): Promise<void> {
  const res = await fetch(`/api/favorites/${sourceId}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(await res.text());
}
```

### Favorites State

Favorites are loaded alongside map sources. Both `StreamsPage` and
`StreamPlayerPage` already call `getMapSources()` on mount — add a parallel
`listFavorites()` call.

```typescript
const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

useEffect(() => {
  listFavorites().then((ids) => setFavoriteIds(new Set(ids)));
}, []);
```

The `Set<string>` makes `isFavorite` checks O(1) for marker rendering.

### Toggle Function

```typescript
const toggleFavorite = async (sourceId: string) => {
  const isFav = favoriteIds.has(sourceId);
  // Optimistic update
  setFavoriteIds((prev) => {
    const next = new Set(prev);
    if (isFav) next.delete(sourceId);
    else next.add(sourceId);
    return next;
  });
  try {
    if (isFav) await removeFavorite(sourceId);
    else await addFavorite(sourceId);
  } catch {
    // Revert on failure
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (isFav) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  }
};
```

Optimistic update so the star toggles instantly. Revert on network failure.

---

### Favorite Button in Source Details Panel

Add a favorite toggle button to `SourceDetailsPanel`. The button sits in the
top-right corner of the panel, next to the hostname.

```
┌──────────────────────────────────────────────────┐
│ kiwisdr.example.com:8073                    [★]  │
│ KiwiSDR @ AB1CDE                                 │
│                                                   │
│ users          2/4                                 │
│ status         active                              │
│ snr dbm        32                                  │
│ ...                                                │
└──────────────────────────────────────────────────┘
```

#### Props Change

```typescript
type SourceDetailsPanelProps = {
  source: Source | null;
  selectedSourceId?: string;
  counts?: MapSourceCounts;
  showPickerSummary?: boolean;
  hideHostname?: boolean;
  hideSourceName?: boolean;
  className?: string;
  isFavorite?: boolean;                         // new
  onToggleFavorite?: (sourceId: string) => void; // new
};
```

The star button only renders when `onToggleFavorite` is provided (opt-in). This
keeps the panel reusable in contexts where favorites don't apply.

#### Button Appearance

- **Not favorited:** Outlined star icon (`Star` from lucide), muted foreground
  color, no fill.
- **Favorited:** Filled star icon (`StarIcon` with `fill="currentColor"`),
  primary color (or a warm accent like `#f59e0b` amber).
- The icon is small (16px) and subtle — it should not dominate the panel.
- Hover: slight scale or color shift.

The button is added to `SourceSection` (which wraps `SourceDetailsPanel` with
the mini-map and action slot) and also to the right sidebar of `SourceOverlay`
when a source is selected.

---

### Map Marker Differentiation

Favorite sources get a distinct visual treatment on the globe in
`SourceMapPicker`.

#### Marker Rendering

Favorites are drawn with a ring (outline) around their dot, or a different
marker shape. Specifically:

- **Non-favorite:** Solid circle, 5px, SNR-based color (existing behavior).
- **Favorite, unselected:** Solid circle, 7px, with a 1.5px ring/outline in
  `#f59e0b` (amber). Slightly larger to stand out.
- **Favorite, hovered:** 10px, amber ring.
- **Favorite, selected:** 12px, `#ff2d9b` (existing selection color), amber ring.

The ring is a CSS `box-shadow` or `outline` — no extra DOM elements needed:

```typescript
const isFav = favoriteIds.has(source.id);
const size = selected ? 12 : hovered ? (isFav ? 10 : 8) : (isFav ? 7 : 5);
const ringStyle = isFav && !selected
  ? { boxShadow: "0 0 0 1.5px #f59e0b" }
  : undefined;
```

#### Props Change

`SourceMapPicker` receives the favorites set:

```typescript
type SourceMapPickerProps = {
  // ... existing props ...
  favoriteIds?: Set<string>;  // new
};
```

---

### Source Search Panel (Left Side)

The globe overlay (`SourceOverlay`) gains a new left-side panel that mirrors the
right sidebar but slides in from the left edge. It contains a source search UI
with a favorites/all toggle.

#### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ┌─ left panel ─┐                              ┌─ right panel ┐ │
│  │              │                              │              │ │
│  │  [★ Favs]    │                              │  Source       │ │
│  │  [All  ]     │        GLOBE                 │  Details      │ │
│  │              │                              │              │ │
│  │  ┌─────────┐ │                              │  host:port   │ │
│  │  │ search  │ │                              │  name        │ │
│  │  └─────────┘ │                              │  snr, grid   │ │
│  │              │                              │  ...         │ │
│  │  source A  ▸ │                              │              │ │
│  │  source B  ▸ │                              │  [★] [Probe] │ │
│  │  source C  ▸ │                              │              │ │
│  │  source D  ▸ │                              │              │ │
│  │  ...         │                              │              │ │
│  │              │                              │              │ │
│  └──────────────┘                              └──────────────┘ │
│                                                                  │
│                          [✕ Cancel]                               │
└──────────────────────────────────────────────────────────────────┘
```

#### SourceOverlay Changes (`ui/bottom-drawer.tsx`)

The `SourceOverlay` component gains a new `leftPanel` prop:

```typescript
type SourceOverlayProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  globe: ReactNode;
  sidebar: ReactNode;
  showSidebar?: boolean;
  leftPanel?: ReactNode;      // new
  showLeftPanel?: boolean;     // new
};
```

The left panel slides in from the left edge, same animation pattern as the
right sidebar but mirrored:

```tsx
<aside
  className={cn(
    "absolute left-0 top-0 h-full w-[340px] p-4 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
    showLeftPanel ? "translate-x-0" : "-translate-x-full",
  )}
>
  <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/80 bg-background">
    {leftPanel}
  </div>
</aside>
```

The close button shifts its `left` to account for the left panel width, same
pattern as how it shifts `right` for the sidebar.

The left panel is always visible when the overlay is open (no conditional
show/hide). It's part of the source-picking experience.

#### SourceSearchPanel Component

New file: `frontend/src/components/source-search-panel.tsx`

```typescript
type SourceSearchPanelProps = {
  sources: Source[];
  favoriteIds: Set<string>;
  selectedSourceId?: string;
  onSelectSource: (source: Source) => void;
  onFlyTo?: (source: Source) => void;
};
```

##### Structure

1. **Tab bar** — Two tabs at the top: "Favorites" and "All". Simple toggle,
   not a router — just filters the list. Styled as two buttons with an active
   indicator.

2. **Search input** — Text input below the tab bar. Filters sources by `name`,
   `host`, `location`, `grid`, or `antenna`. Case-insensitive substring match.
   Debounced (150ms) to avoid lag on keystroke.

3. **Source list** — Scrollable list of matching sources. Each item shows:
   - Source name (primary text, truncated)
   - `host:port` (secondary text, muted)
   - Location or grid if available (tertiary, very muted)
   - Favorite indicator (small filled star if favorited)
   - Active/selected indicator (dot or highlight if this is the currently
     selected source)

4. **Click behavior** — Clicking a source in the list does two things:
   - Calls `onSelectSource(source)` — same as clicking a marker on the map.
     This triggers the probe flow and shows the source in the right sidebar.
   - Calls `onFlyTo(source)` — the globe smoothly flies to the source's
     coordinates and zooms in.

##### Filtering

When the "Favorites" tab is active, only sources whose ID is in `favoriteIds`
are shown. The search input further filters within that subset.

When "All" is active, all sources are shown (filtered by search).

If favorites is active and the list is empty, show a prompt:
"No favorites yet — star a source to add it here."

##### List Virtualization

With ~5,000 sources, the "All" tab with no search term could render a long list.
Two options:

- **Option A:** Use a virtual list (`@tanstack/react-virtual` or similar) to
  only render visible items. Adds a dependency but handles any list size.
- **Option B:** Limit the rendered list to the first 100 matches and show a
  "Showing 100 of N — refine your search" message. No new dependency.

**Decision: Option B.** The search input naturally reduces the list, and
favorites will be small. No need for a virtualization dependency for a panel
that's only open during source selection. If it feels sluggish later,
virtualize then.

##### Globe Fly-To

The `SourceMapPicker` needs to expose an imperative `flyTo(lat, lng, zoom)`
method. This is done via `useImperativeHandle` + `forwardRef` on the
`MapLibreMap` instance:

```typescript
export type SourceMapPickerHandle = {
  flyTo: (latitude: number, longitude: number, zoom?: number) => void;
};
```

The parent (`StreamsPage` / `StreamPlayerPage`) holds a ref to the picker
and passes `flyTo` to the search panel:

```typescript
const mapRef = useRef<SourceMapPickerHandle>(null);

// In SourceSearchPanel's onSelectSource:
onFlyTo={(source) => {
  if (source.latitude != null && source.longitude != null) {
    mapRef.current?.flyTo(source.latitude, source.longitude, 6);
  }
}}
```

The fly-to uses MapLibre's `map.flyTo({ center, zoom, duration })` with a
smooth animation (~1.5s duration). The zoom level is set to 6 (regional view)
so the source is centered and visible but surrounding sources are still in
context.

---

### Integration: StreamsPage

`StreamsPage` already has the `SourceOverlay` for stream creation. Changes:

1. Load favorites on mount alongside map sources.
2. Pass `favoriteIds` to `SourceMapPicker`.
3. Pass `isFavorite` and `onToggleFavorite` to `SourceSection` (via
   `SourceDetailsPanel`) inside the right sidebar.
4. Add `SourceSearchPanel` as the `leftPanel` prop of `SourceOverlay`.
5. Hold a ref to `SourceMapPicker` for `flyTo`.

### Integration: StreamPlayerPage

Same changes as `StreamsPage` — the stream player's source-change overlay
already uses `SourceOverlay` with the same pattern.

---

## SourceOverlay CSS Additions (`index.css`)

Add a `slide-in-left` / `slide-out-left` animation pair for the left panel,
mirroring the existing `slide-in-right` / `slide-out-right`:

```css
@keyframes slide-in-left {
  from { transform: translateX(-100%); }
  to   { transform: translateX(0); }
}
@keyframes slide-out-left {
  from { transform: translateX(0); }
  to   { transform: translateX(-100%); }
}
```

These are driven by the same `transition-transform` utility already on the
right sidebar — no new animation infrastructure needed.

---

## Route Protection

| Route | Auth Required |
|-------|--------------|
| `GET /api/favorites` | Yes |
| `PUT /api/favorites/{sourceId}` | Yes |
| `DELETE /api/favorites/{sourceId}` | Yes |

All new routes sit inside the existing `protected` group. No public access.

---

## Dependencies

### Go

None. Uses existing `pgx`, `chi`, and the `db`/`api` packages.

### Frontend

No new dependencies. The search panel uses native `<input>`, the list is a
simple `map()` with a 100-item cap, and fly-to uses MapLibre's built-in
`map.flyTo()`.

If list virtualization is needed later, `@tanstack/react-virtual` is the
natural choice (already using TanStack Router).

---

## Implementation Order

| Step | Task | Scope | Depends On |
|------|------|-------|------------|
| 1 | DB migration: `favorite_sources` table | Backend | Nothing |
| 2 | DB queries: `internal/db/favorites.go` | Backend | Step 1 |
| 3 | API endpoints: `GET`, `PUT`, `DELETE` `/api/favorites` | Backend | Step 2 |
| 4 | Router wiring: add favorites routes to protected group | Backend | Step 3 |
| 5 | Frontend API functions: `listFavorites`, `addFavorite`, `removeFavorite` | Frontend | Step 3 |
| 6 | Favorites state: load on mount, `Set<string>`, optimistic toggle | Frontend | Step 5 |
| 7 | Favorite button in `SourceDetailsPanel` | Frontend | Step 6 |
| 8 | Map marker differentiation: amber ring on favorite markers | Frontend | Step 6 |
| 9 | `SourceMapPicker` — expose `flyTo` via imperative handle | Frontend | Nothing |
| 10 | `SourceSearchPanel` component: tabs, search, filtered list | Frontend | Steps 6, 9 |
| 11 | `SourceOverlay` — add `leftPanel` / `showLeftPanel` props | Frontend | Nothing |
| 12 | Integrate left panel into `StreamsPage` overlay | Frontend | Steps 10, 11 |
| 13 | Integrate left panel into `StreamPlayerPage` overlay | Frontend | Steps 10, 11 |

**Recommended sequencing:**

**Phase 1 — Data layer (steps 1–6):** Migration, queries, API, frontend state.
Verify by calling `PUT /api/favorites/some-source-id` and seeing it in
`GET /api/favorites`.

**Phase 2 — Star button + markers (steps 7–8):** Visible feedback that
favorites work. Star in the panel, amber rings on the map.

**Phase 3 — Search panel (steps 9–13):** The left panel with search, tabs, and
fly-to. This is the biggest UI piece but builds on everything from phases 1–2.

---

## What This Doesn't Cover

- **Per-user favorites** — no user identity exists. If user accounts are added
  later, favorites can be migrated from tenant-scoped to user-scoped by adding a
  `user_id` column.
- **Favorite ordering / custom labels** — keep it simple. Favorites are ordered
  by `created_at`. If drag-to-reorder is wanted later, add an `ordinal` column.
- **Favorite source notifications** — "alert me when a favorite source comes
  online." Nice-to-have, separate feature.
- **Syncing favorites across tabs in real-time** — favorites change rarely and
  the set is loaded on overlay open. No WebSocket broadcast needed. A page
  refresh picks up changes.
- **Bulk import/export** — operator-level concern, not needed now.
