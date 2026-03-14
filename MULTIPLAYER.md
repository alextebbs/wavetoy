# Multiplayer: Real-Time Collaborative Stream Control

## Problem

Today, multiple browser clients can connect to the same stream and receive the same
audio. When any client sends a `patch`, the server updates the database, reconfigures
the KiwiSDR connection, and broadcasts `stream_updated` to all connected clients.

This works, but it was designed for single-user control. It breaks down for real
collaboration:

- **No conflict resolution.** Two users tuning the frequency at the same time results
  in a last-write-wins race. Neither user knows the other is editing.
- **No presence.** Clients have no idea who else is listening or controlling the stream.
- **No attribution.** When the stream changes, clients don't know who changed it or why.
- **No scope beyond streams.** Sources, stream lists, and other shared state aren't
  synced in real time. Creating or deleting a stream on one tab isn't reflected on
  another.
- **No optimistic updates.** The client waits for the server round-trip before the UI
  reflects a change, making knob-turning feel sluggish.

## Recommendation: Server-Authoritative Versioned State

Use the server as the single source of truth. Extend the existing WebSocket protocol
with three new concepts: **versioned state**, **presence**, and **scoped
subscriptions**. No new libraries required — this builds on gorilla/websocket and the
native browser WebSocket API already in use.

This is deliberately not a CRDT or OT system. Stream settings are a flat bag of
key-value pairs, not a rich document. A versioned patch model with server arbitration
is simpler, sufficient, and keeps the server in full control of what reaches the
KiwiSDR.

---

## Design

### 1. Versioned State

Add a monotonically increasing version number to every synced object. The version
increments on every successful mutation.

```sql
ALTER TABLE streams ADD COLUMN version BIGINT NOT NULL DEFAULT 1;
```

Every `stream_updated` event now includes the version:

```json
{
  "type": "stream_updated",
  "stream": { "id": "...", "version": 42, "frequency_khz": 7850, ... },
  "sample_rate": 12000
}
```

When a client sends a `patch`, it includes the version it is patching against:

```json
{
  "type": "patch",
  "version": 41,
  "patch": { "frequency_khz": 7850 }
}
```

The server validates:

1. If `version` matches the current version → apply, increment version, broadcast.
2. If `version` is stale → reject with a `conflict` error that includes the current
   state so the client can reconcile.

```json
{
  "type": "error",
  "code": "CONFLICT",
  "error": "patch based on stale version",
  "current_version": 42,
  "stream": { ... }
}
```

This gives us safe concurrent edits without the complexity of vector clocks or merge
functions. For rapid-fire changes (e.g., dragging a frequency slider), the client can
**debounce** outgoing patches and always send against the latest known version.

#### Optimistic Updates

The client applies the patch to local state immediately and tags it as unconfirmed. When
the server responds:

- `stream_updated` with a matching or newer version → confirm, merge any server-side
  differences (e.g., clamped values).
- `CONFLICT` → roll back local state to the server-provided `stream` and surface a
  brief toast: *"Frequency was changed by another listener."*

This makes single-user interaction feel instant while keeping multi-user edits safe.

### 2. Presence

Track which users are connected to each stream and broadcast join/leave events.

#### Client Identity

On connect, the client sends a `hello` message with a locally generated session ID
(a UUID stored in `sessionStorage` so it survives page reloads within a tab but not
across tabs) and a color:

```json
{
  "type": "hello",
  "session_id": "a1b2c3d4",
  "color": "#4f87e2"
}
```

The color is randomly assigned by the client from a curated palette. There are no
display names — peers are anonymous, identified only by color and session ID. `hello`
replaces the implicit connection event — the server does not send `connected` until it
receives `hello`.

#### Server Tracking

Extend `streamWSClient` on the server:

```go
type streamWSClient struct {
    conn      *websocket.Conn
    mu        sync.Mutex
    sessionID string
    color     string
    joinedAt  time.Time
}
```

#### Events

```json
// Server → all clients on the stream
{ "type": "peer_joined", "peer": { "session_id": "a1b2c3d4", "color": "#4f87e2" } }
{ "type": "peer_left",   "peer": { "session_id": "a1b2c3d4" } }
```

On initial connect, the server sends the full peer list so the new client can render
everyone:

```json
{
  "type": "connected",
  "stream": { ... },
  "sample_rate": 12000,
  "audio_type": "pcm_s16le",
  "peers": [
    { "session_id": "a1b2c3d4", "color": "#4f87e2" },
    { "session_id": "e5f6a7b8", "color": "#e24f87" }
  ]
}
```

#### Peer Cursor / Focus

Optionally, clients can broadcast what control they're currently interacting with.
This is low-priority but useful for "see who's turning the frequency knob" UX:

```json
{
  "type": "focus",
  "field": "frequency_khz"
}
```

The server rebroadcasts to other peers:

```json
{
  "type": "peer_focus",
  "session_id": "a1b2c3d4",
  "field": "frequency_khz"
}
```

### 3. Attributed Mutations

Every `stream_updated` broadcast includes who made the change:

```json
{
  "type": "stream_updated",
  "stream": { "id": "...", "version": 42, ... },
  "sample_rate": 12000,
  "changed_by": { "session_id": "a1b2c3d4", "color": "#4f87e2" },
  "changed_fields": ["frequency_khz"]
}
```

This lets the client decide how to render it: suppress animation if the change is your
own, show a toast if it's from a peer, highlight the changed field in the peer's color.

### 4. Scoped Subscriptions (Beyond Single-Stream)

The current protocol is 1 WebSocket = 1 stream. This makes it impossible to sync
cross-stream events (stream created, stream deleted, source availability changes) to
clients viewing the stream list or the map.

#### Option A: Topic-Based Multiplexing (Recommended)

Keep a single WebSocket connection per client. Let the client subscribe to topics:

```json
{ "type": "subscribe",   "topics": ["streams", "sources"] }
{ "type": "unsubscribe", "topics": ["sources"] }
```

Topics:

| Topic | Events |
|-------|--------|
| `stream:{id}` | `stream_updated`, `stream_deleted`, `peer_joined`, `peer_left`, `peer_focus`, audio frames |
| `streams` | `stream_created`, `stream_deleted`, `stream_updated` (summary, no audio) |
| `sources` | `source_updated` (availability, users count changes) |

This requires a new top-level WebSocket endpoint that isn't scoped to a single stream:

```
GET /api/ws → general multiplexed WebSocket
```

The existing `/api/streams/{id}/ws` can remain as a convenience alias that auto-subscribes
to `stream:{id}` and `streams`.

#### Option B: Separate Connections

Keep the current per-stream WebSocket as-is. Add a second lightweight WebSocket for
global events:

```
GET /api/events/ws → global event stream
```

This is simpler to implement but means two connections per client, and the client must
correlate events across them.

**Recommendation: Option A.** It's a modest server change (topic registry instead of
a flat client map) and gives the client a single connection to manage.

#### Server-Side Topic Registry

Replace the current `wsClients map[string]map[*streamWSClient]struct{}` with:

```go
type topicRegistry struct {
    mu     sync.RWMutex
    topics map[string]map[*wsClient]struct{}  // topic → set of clients
}

func (r *topicRegistry) subscribe(client *wsClient, topic string)
func (r *topicRegistry) unsubscribe(client *wsClient, topic string)
func (r *topicRegistry) broadcast(topic string, event any)
func (r *topicRegistry) peers(topic string) []*wsClient
```

Audio frames are broadcast to the `stream:{id}` topic just as they are today.

### 5. Reconnection and Sync

The current client has no automatic reconnect. For multiplayer, this must change.

#### Client Reconnection Protocol

1. On disconnect, start exponential backoff reconnection (1s, 2s, 4s, ... capped at 30s).
2. On reconnect, send `hello` with the same `session_id` and the last known version of
   each subscribed object.
3. The server responds with the current state of each subscribed topic only if the
   version has changed, avoiding redundant data transfer.

```json
// Client → Server (on reconnect)
{
  "type": "hello",
  "session_id": "a1b2c3d4",
  "color": "#4f87e2",
  "resume": {
    "stream:abc123": { "version": 41 }
  }
}
```

```json
// Server → Client
{
  "type": "connected",
  "stream": { "id": "abc123", "version": 42, ... },
  "peers": [ ... ]
}
```

If the client's version matches, the server can send a lightweight ack instead of the
full state.

### 6. Rate Limiting and Throttling

With multiple users, patch storms are likely. The server should:

- **Throttle patches per client**: max 10 patches/second per client. Excess patches
  return a `RATE_LIMITED` error.
- **Coalesce rapid broadcasts**: if multiple patches arrive within a 50ms window,
  batch them into a single `stream_updated` broadcast with the final state.
- **Debounce on the client**: the client should debounce slider/knob changes to ~100ms
  before sending a patch.

---

## Message Protocol Summary

### Client → Server

| Type | Fields | Purpose |
|------|--------|---------|
| `hello` | `session_id`, `color`, `resume?` | Identify on connect/reconnect |
| `subscribe` | `topics[]` | Join topics |
| `unsubscribe` | `topics[]` | Leave topics |
| `patch` | `version`, `patch` | Mutate stream settings |
| `focus` | `field` | Broadcast cursor/focus |
| `ping` | — | Keepalive |

### Server → Client

| Type | Fields | Purpose |
|------|--------|---------|
| `connected` | `stream?`, `sample_rate?`, `peers[]`, `subscriptions[]` | Connection established |
| `stream_updated` | `stream`, `sample_rate`, `changed_by`, `changed_fields`, `version` | State change |
| `stream_created` | `stream` | New stream (on `streams` topic) |
| `stream_deleted` | `stream_id` | Stream removed |
| `source_updated` | `source` | Source availability change |
| `peer_joined` | `peer` | User connected |
| `peer_left` | `peer` | User disconnected |
| `peer_focus` | `session_id`, `field` | User focusing a control |
| `error` | `error`, `code`, `current_version?`, `stream?` | Includes `CONFLICT`, `RATE_LIMITED` |
| `pong` | — | Keepalive response |

Binary frames remain unchanged: `[0x02][PCM16 LE audio bytes]`.

---

## Implementation Plan

### Phase 1: Versioned State + Conflict Handling

**Server:**
- Add `version` column to `streams` table.
- Modify `applyPatchStream` to accept a `base_version`, compare, increment on success.
- Return `CONFLICT` error with current state on version mismatch.
- Include `version` in all stream JSON responses.

**Client:**
- Track `version` in local stream state.
- Send `version` with every patch.
- Handle `CONFLICT` errors: replace local state, show toast.
- Implement optimistic local updates.

### Phase 2: Presence

**Server:**
- Add `session_id`, `color` to `streamWSClient`.
- Require `hello` message before sending `connected`.
- Broadcast `peer_joined` / `peer_left` to stream clients.
- Include `peers` list in `connected` response.

**Client:**
- Generate session ID in `sessionStorage` on first load.
- Assign a random color from a curated palette.
- Render peer indicators (colored dots) in the stream player header.
- Send `hello` on connect.

### Phase 3: Attributed Mutations

**Server:**
- Include `changed_by` and `changed_fields` in `stream_updated` broadcasts.

**Client:**
- Distinguish own changes from peer changes in the UI.
- Highlight changed fields briefly in the peer's color.

### Phase 4: Topic Multiplexing + Global Sync

**Server:**
- Implement `topicRegistry`.
- Add `/api/ws` endpoint.
- Implement `subscribe`/`unsubscribe` handling.
- Broadcast `stream_created`, `stream_deleted` on the `streams` topic.
- Broadcast `source_updated` on the `sources` topic when health checks change
  availability.
- Deprecate `/api/streams/{id}/ws` (or keep as alias).

**Client:**
- Replace per-stream WebSocket with a single connection to `/api/ws`.
- Subscribe to relevant topics based on current page.
- Auto-update stream list when `stream_created`/`stream_deleted` arrives.
- Auto-update source availability on the map.

### Phase 5: Reconnection

**Server:**
- Handle `resume` in `hello` — diff versions, send only changed state.
- Deduplicate session IDs (if the same session reconnects, close the stale connection).

**Client:**
- Exponential backoff reconnection with jitter.
- Re-send `hello` with `resume` containing last known versions.
- Show "Reconnecting..." status in the UI.

### Phase 6: Focus Sharing (Optional)

**Server:**
- Rebroadcast `focus` messages to peers.

**Client:**
- Send `focus` when interacting with a control (debounced).
- Render colored ring/highlight around controls other peers are using.

---

## Data Flow: Two Users Tuning Simultaneously

```
 User A (v=41)                  Server (v=41)                User B (v=41)
     │                              │                             │
     ├─ patch {v:41, freq:7850} ──→ │                             │
     │                              ├─ v=41 ✓, apply, v→42       │
     │                              ├─ stream_updated {v:42} ───→ │
     │  ←── stream_updated {v:42} ──┤                             │
     │                              │  ←── patch {v:41, freq:8000}│
     │                              ├─ v=41 ≠ 42, reject         │
     │                              │  ── error CONFLICT {v:42} →│
     │                              │                             │
     │                              │  (User B sees conflict,     │
     │                              │   state resets to v=42,     │
     │                              │   toast: "Frequency was     │
     │                              │   changed by another        │
     │                              │   listener")                │
     │                              │                             │
     │                              │  ←── patch {v:42, freq:8000}│
     │                              ├─ v=42 ✓, apply, v→43       │
     │                              ├─ stream_updated {v:43} ───→ │
     │  ←── stream_updated {v:43} ──┤                             │
```

---

## What This Doesn't Cover (Future Work)

- **Authentication and permissions.** The current system has no auth. Multiplayer
  amplifies the need: who can tune vs. who can only listen? This plan assumes all
  connected users have equal control. Auth should be tackled separately.
- **Undo/redo.** Versioned state enables a server-side history log, but the undo
  UX needs design work (whose undo? per-field or whole-state?).
- **Chat / voice.** Out of scope. If wanted, it would ride on the same topic system.
- **Per-user audio settings.** Things like volume and filter cutoffs that are local to
  each listener, not shared. These should stay client-only and never go through the
  protocol.
