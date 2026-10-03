# Recent Sources

Each stream keeps a history of the last ~20 sources it tuned to. Each listening session is its own entry — just the source ID and when listening started. Duration is implicit: the time between one entry's timestamp and the next entry's timestamp (or "now" for the most recent).

## Rules

- A source is only added to history after the stream has received **both** SOUND (`0x02`) and WF (`0x01`) binary data from it. This avoids logging sources that never actually worked (failed connections, quick skips).
- Each stream maintains its own independent history.
- Cap at 20 entries per stream. When inserting the 21st, delete the oldest.
- The same source can appear multiple times — each session is a separate row.

---

## Database

Migration `015_recent_sources`:

```sql
CREATE TABLE recent_sources (
    id          SERIAL PRIMARY KEY,
    stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recent_sources_stream ON recent_sources(stream_id);
```

- `id` — auto-increment so each session is a unique row (same source can appear many times).
- `started_at` — when the user began listening to this source.

### DB functions (`internal/db/recent_sources.go`)

| Function | Description |
|---|---|
| `ListRecentSources(streamID) ([]RecentSource, error)` | Returns up to 20 rows ordered by `started_at DESC`, joined with `sources` to return full source info. |
| `InsertRecentSource(streamID, sourceID, startedAt)` | Insert a new row. After insert, delete any rows beyond the 20 most recent for that stream. |

---

## Backend

### Tracking when to record (`internal/streammgr/manager.go`)

The stream manager already knows when a stream connects to a KiwiSDR source and starts receiving audio/waterfall frames. Add per-stream state:

```go
type listenSession struct {
    SourceID      string
    StartedAt     time.Time
    ReceivedSound bool
    ReceivedWF    bool
}
```

- When a stream connects to a new source, create a `listenSession` with the current time.
- As binary frames flow through the manager, set `ReceivedSound` / `ReceivedWF` flags.
- Once **both** flags are true, call `db.InsertRecentSource(streamID, sourceID, startedAt)` immediately. The session is now recorded. No further action needed on disconnect.
- If the stream disconnects before both flags are set, discard the session — nothing is recorded.

### API (`internal/api/recent_sources.go`)

| Method | Path | Handler | Description |
|---|---|---|---|
| `GET` | `/api/streams/{id}/recent-sources` | `listRecentSources` | Return the stream's recent source history (up to 20), each including full source data + `started_at`. |

No write endpoints — recording happens automatically in the stream manager.

### Response shape

```json
[
  {
    "source": { "id": "...", "name": "...", "host": "...", ... },
    "started_at": "2026-03-15T12:00:00Z"
  }
]
```

Duration for display is computed client-side: `entries[n-1].started_at - entries[n].started_at` (or `now - entries[0].started_at` for the current/most recent entry).

---

## Frontend

### API client (`frontend/src/lib/api.ts`)

```ts
interface RecentSource {
  source: Source
  started_at: string
}

async function listRecentSources(streamId: string): Promise<RecentSource[]>
```

### UI (`frontend/src/routes/stream-player-page.tsx`)

- Fetch recent sources when the stream player page loads.
- Re-fetch when receiving a `stream_updated` WebSocket event (source may have changed).

### UI — sources panel

Show a "Recent" section at the **bottom** of the sources panel (below search results / favorites). Each entry renders a `SourceSection` with a subtitle showing:
- When listening started (relative time, e.g. "2h ago")
- How long the session lasted (computed from the gap to the next entry, e.g. "45m")

Clicking a recent source tunes the stream to it (same behavior as picking any source).

---

## Summary of new files

| File | Type |
|---|---|
| `migrations/015_recent_sources.up.sql` | Migration |
| `migrations/015_recent_sources.down.sql` | Migration |
| `internal/db/recent_sources.go` | DB layer |
| `internal/api/recent_sources.go` | API handler |

Modified files:

| File | Change |
|---|---|
| `internal/streammgr/manager.go` | Track listen sessions, call `InsertRecentSource` once both SOUND+WF received |
| `internal/api/api.go` | Register `GET /api/streams/{id}/recent-sources` |
| `frontend/src/lib/api.ts` | Add `RecentSource` type and `listRecentSources()` |
| `frontend/src/routes/stream-player-page.tsx` | Fetch and pass recent sources down |
| Sources panel component | Render "Recent" section at bottom |
