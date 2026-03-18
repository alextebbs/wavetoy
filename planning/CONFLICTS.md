# Multiplayer State Synchronization

How state propagates between connected clients, how conflicts are resolved, and how the frontend avoids feedback loops. Read MULTIPLAYER.md first for the protocol design — this doc covers how it's actually implemented.

## Message Channels

There are two independent WebSocket channels carrying state between clients:

### 1. Patch Channel (authoritative state)

```
Client → Server: { type: "patch", version: N, patch: { frequency_khz: 7850 } }
Server → ALL clients: { type: "stream_updated", stream: {...}, changed_by: {...} }
```

Patches carry a `version` number. The server compares it to the current version:
- Match → apply, increment version, broadcast `stream_updated` to ALL clients (including the sender).
- Mismatch → reject with `CONFLICT` error containing current state.

The sender receiving its own echo is intentional — it gives the client the server-authoritative version of what it just sent (e.g., clamped values).

### 2. Waterfall Config Channel (view coordination)

```
Client → Server: { type: "wf_config", zoom: 11, center_khz: 7850, start_khz: 7800, end_khz: 7900 }
Server → OTHER clients: { type: "wf_view_changed", start_khz: 7800, end_khz: 7900 }
```

This tells the kiwi what frequency range to render in its waterfall, and tells other clients where the view is. Unlike patches, this is broadcast EXCLUDING the sender — the sender already has the correct view.

## Client-Side State Flow

### The Band View Store

`band-view-store.ts` is a zustand store that holds the current view window (`startKHz`, `endKHz`). Every view update is tagged with a `viewSource`:

- `"local"` — originated from this client (drag, zoom, click, frequency input)
- `"remote"` — received from the server or a peer

This tag drives downstream behavior:

| Subscriber | Fires on `"local"` | Fires on `"remote"` |
|---|---|---|
| BandViewport → sends `wf_config` to server | Yes | No |
| Locked-view → derives frequency from center | Yes | No |

Three methods exist for setting the view:

| Method | viewSource | Animation | When to use |
|---|---|---|---|
| `setView(start, end)` | `"local"` | None | User-initiated actions (drag, zoom, typed freq) |
| `setViewQuiet(start, end)` | `"remote"` | None | Programmatic updates that must not echo |
| `setViewRemote(start, end)` | `"remote"` | 200ms lerp | Peer updates (smooth visual transition) |

### Patch Flow

When the client wants to change stream settings (frequency, mode, bandwidth, filters, etc.):

1. Local state updates immediately (optimistic).
2. `throttledAutoPatch` encodes the control state as JSON and compares to `lastAutoPatchRef`. If identical, it's dropped.
3. If different, a `patch` message is sent over WebSocket with the current `version`.
4. Server applies and broadcasts `stream_updated` to all clients.
5. The sending client receives its own echo. `lastAutoPatchRef` is updated with the server values, preventing a re-send.

### Receiving Remote Updates

When `stream_updated` arrives:

1. `lastRemoteUpdateAtRef` is set to `performance.now()` — this timestamps the remote update.
2. `lastAutoPatchRef` is set to the server's values — prevents echoing identical state back.
3. `freqAnimating` is set to `true` (cleared after 250ms) — tells the UI to animate transitions.
4. React state is updated: `setStream`, `setFrequency`, `setMode`, etc.
5. The `throttledAutoPatch` effect fires (because frequency/mode changed), checks the timestamp, sees it's within 150ms, and skips sending a patch.

This prevents the most basic feedback loop: remote update → local state change → patch sent back → remote update → repeat.

### Why a Timestamp Instead of a Boolean Flag

React effects are asynchronous — they run after render, not synchronously when state is set. A boolean ref set in the WS handler and cleared in an effect is vulnerable to React batching and effect ordering. A timestamp comparison (`performance.now() - ref < 150`) is immune to these issues — it's just two numbers compared at execution time, regardless of when the effect runs.

## View-Frequency Coupling (Center Lock)

Center lock (`view_locked`) creates a bidirectional relationship between frequency and view bounds: the frequency must always be at the center of the view. This is the hardest part of multiplayer sync because changes to either side propagate to the other.

### Local User Actions

**Panning/dragging the waterfall:**
`panByNorm` updates the view store with `viewSource: "local"` → the locked-view subscriber fires → computes the new center frequency → `setFrequency` → `throttledAutoPatch` sends a patch.

**Typing a frequency or clicking the waterfall:**
`setFrequency` is called → the re-center effect fires → `setView` (local) adjusts the view to center on the new frequency → BandViewport sends `wf_config` to update kiwi coverage.

**Zooming:**
`zoomAtNorm` fires with `zoomToCenter` flag → zoom is symmetric around center → center frequency unchanged → no frequency derivation → BandViewport sends `wf_config` with new zoom. No loop.

### Remote Updates with Center Lock

When a peer changes the frequency:

1. `stream_updated` arrives → `setFrequency(newFreq)` → re-center effect fires.
2. The re-center effect checks `lastRemoteUpdateAtRef` — it's within 150ms, so it calls `setViewRemote` instead of `setView`.
3. `setViewRemote` sets `viewSource: "remote"` → BandViewport ignores it (no `wf_config` sent) → locked subscriber ignores it (no frequency re-derivation).
4. The `throttledAutoPatch` effect also skips (timestamp guard).

Result: the view smoothly animates to center on the new frequency, no outbound messages are generated, no feedback loop.

### The 50% Rule (Tuning Overlay)

When center-lock is on, the tuning overlay is rendered at 50% screen position unconditionally:

```typescript
if (centerLocked) {
  centerPct = 50;
  leftPct = 50 + ((effectiveLo / 1000) / span) * 100;
  rightPct = 50 + ((effectiveHi / 1000) / span) * 100;
}
```

This decouples the overlay from view/frequency sync timing. The waterfall slides underneath; the overlay stays pinned. Without this, any timing gap between the frequency update and the view re-center causes visible jitter.

## Animation Strategy

The initiating client sees instant feedback. Observing clients see smooth transitions.

### Waterfall View

- Local change → `setView` (instant)
- Remote change → `setViewRemote` (200ms ease-out lerp)

### Tuning Overlay

A `freqAnimating` state tracks whether the latest frequency change was remote:
- WS handler sets `freqAnimating = true`, clears after 250ms via timeout.
- `TuningOverlay` receives `animate` prop → applies CSS transition when true.
- Local interactions → `freqAnimating` stays false → instant positioning.

### When Not to Animate

- During active drag operations (the `isDragging` flag in TuningOverlay)
- When center-lock is on (overlay is pinned at 50%, nothing to animate)
- After tab return from backgrounding (stale data is dropped, not animated)

## Tab Backgrounding

While the tab is hidden, the browser queues WebSocket messages but throttles JS execution. On return, the backlog causes a freeze.

When the tab has been hidden for >2 seconds:
1. Audio worklet receives `"flush"` — resets its ring buffer, enters "waiting for threshold" state.
2. A 300ms window activates where waterfall frames and audio packets are dropped (early return, no processing).
3. After 300ms, fresh live data flows. The worklet accumulates its threshold (~170ms at 48kHz) and fades in.
4. Text/JSON messages (state updates, peer events, logs) are always processed.

## Key Files

| File | Role |
|---|---|
| `frontend/src/lib/band-view-store.ts` | View state, viewSource tagging, setView/setViewQuiet/setViewRemote |
| `frontend/src/routes/stream-player-page.tsx` | WS handler, patch flow, re-center effects, timestamp guards |
| `frontend/src/components/waterfall/band-viewport.tsx` | Throttled wf_config sending, viewSource filtering |
| `frontend/src/components/waterfall/tuning-overlay.tsx` | Center-lock 50% rule, animate prop |
| `internal/api/stream_ws.go` | Server-side WS handler, patch processing, broadcasting |
| `internal/api/streams.go` | Patch application, version checking, conflict detection |

## Common Pitfalls

**Adding a new reactive effect that touches frequency or view bounds:**
Make sure it respects the local/remote distinction. If it fires on remote updates and produces outbound messages, it will create a feedback loop. Check `viewSource` or the timestamp guard.

**Adding a new broadcastable field:**
If the field participates in a derived relationship (like frequency ↔ view), the derivation must be suppressed for remote updates. Use the timestamp guard pattern.

**Changing `broadcastStreamEvent` to `broadcastStreamEventExcluding` (or vice versa):**
`stream_updated` intentionally goes to ALL clients so the sender gets the authoritative state. `wf_view_changed` intentionally EXCLUDES the sender because they already have the correct view. Mixing these up creates either missing self-updates or feedback loops.

**Modifying the view store without viewSource:**
Every method that sets `startKHz`/`endKHz` must set a `viewSource`. Raw `set({ startKHz: x })` calls without a viewSource will leave the previous value in place, which may cause unexpected subscriber behavior.
