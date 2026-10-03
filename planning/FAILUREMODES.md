# Failure Modes

The audio streaming pipeline is a 4-hop chain:

```
Kiwi SDR ──[WS]──▶ Server Pump ──[chan]──▶ WS Client Pump ──[WS]──▶ Browser ──▶ AudioWorklet
                                              ▲ shared mutex
                   WF Pump ────[chan]──▶ WS Client Pump ──[WS]──▶ Browser ──▶ Canvas
                   Log Pump ───[chan]──▶ WS Client Pump ──[WS]──▶ Browser ──▶ Log Panel
```

Audio, waterfall, and log pumps run as independent goroutines but write through the
same `streamWSClient` and its single `sync.Mutex`. A blocked write in any pump blocks
all three channels to that client.

---

## Layer 1 — Kiwi SDR Connection (server ↔ kiwi)

### K1: Kiwi TCP drops cleanly

The kiwi closes the WebSocket or the TCP connection resets.

**What happens now:** `ReadMessage()` returns an error. The pump exits, `ensureReconnect`
fires with exponential backoff (1s → 30s). After 3 unstable reconnects, auto-fallback
triggers if enabled. After 10 unstable reconnects, the stream enters error state.

**What the user sees:** Brief silence (1–30s depending on backoff), then audio resumes.
Logs show `disconnect → reconnect.start → connect`.

**What we should show:** A transient "source reconnecting" badge in the top bar.
Already partially implemented — `streamState === "connecting"` shows a badge.

---

### K2: Kiwi stops sending audio but keeps TCP alive

The kiwi SDR process stalls, runs out of CPU, or enters an internal error state
where it stops sending SND frames but the TCP connection stays open.

**What happens now:** No read deadline exists on the kiwi connection. The `readLoop`
goroutine blocks on `ReadMessage()` indefinitely. The pump's `client.Samples()` channel
starves. No frames are broadcast. The stale watchdog on the client pump detects the
gap after ~10s and logs `pump.stale`, but takes no corrective action. Eventually TCP
times out at the OS level (50–120s) and triggers K1 recovery.

**What the user sees:** Extended silence (50s+). Waterfall freezes. No error indication.
The `pump.stale` warning appears in the log panel if they're watching it.

**What we should show:** After ~5s of no audio frames, show a "source not responding"
indicator. After ~15s, the server should force-close the kiwi connection and reconnect
rather than waiting for TCP timeout.

---

### K3: Kiwi PCM channel full

The server's kiwi reader produces frames faster than the pump goroutine can consume
them. The PCM channel has a capacity of 64 frames.

**What happens now:** Frames are dropped. `sndQueueDropFrames` counter is incremented.
No log is emitted and no error is raised.

**What the user sees:** Occasional audio glitches or skips. Invisible unless checking
internal metrics via `dumpAudioMetrics`.

**What we should show:** Nothing — this is a transient buffer overflow that self-corrects.
If it becomes persistent (e.g. sustained drops for >5s), it should be logged as a warning.

---

### K4: Kiwi handshake fails

The kiwi rejects the WebSocket handshake: bad password, full slots, server offline,
DNS failure, TLS error, etc.

**What happens now:** `Connect()` returns an error. `ensureReconnect` retries with backoff.
After 3 unstable attempts, auto-fallback triggers if enabled. After 10, error state.

**What the user sees:** Silence with `reconnect.start` log entries. If auto-fallback is
enabled, the system switches to an alternate source. Otherwise, the stream enters
error state.

**What we should show:** "Source unreachable" badge. If fallback kicks in, show
"Switched to fallback source" in the log.

---

### K5: Kiwi keepalive write fails

The kiwi connection's keepalive loop (sends `SET keepalive` every 3s) fails to write.

**What happens now:** The `keepAliveLoop` goroutine returns. No explicit reconnect is
triggered. The system relies on the read side eventually failing (when the kiwi
notices the dead connection and stops sending, or TCP times out).

**What the user sees:** Potential delayed detection — the kiwi connection may appear
alive for seconds to minutes before the read side fails.

**What we should show:** Same as K2 — "source not responding" if frames stop arriving.
The fix is to call `Close()` on keepalive failure so the read side exits immediately
and triggers reconnection.

---

## Layer 2 — Stream Manager / Pump (kiwi frames → subscriber channels)

### P1: Subscriber channel full

The subscriber channel (capacity 256 for audio, 32 for waterfall) fills up because
the client-side pump can't drain it fast enough.

**What happens now:** The broadcast loop drops the oldest frame and tries to deliver
the newest. `fanoutDroppedFinal` is incremented for audio. Waterfall drops are
**not tracked at all**.

**What the user sees:** Audio skips or waterfall gaps. Only visible in `pump.metrics`
for audio; completely invisible for waterfall.

**What we should show:** Nothing for transient drops. If sustained, it should appear
as a quality warning in the log panel.

---

### P2: Pump goroutine exits (kiwi disconnect)

The kiwi client's `Done()` channel closes, signaling the pump to exit.

**What happens now:** `ensureReconnect(as)` is called. Same recovery as K1.

**What the user sees:** Brief silence during reconnect.

**What we should show:** Same as K1 — "source reconnecting" badge.

---

### P3: Idle timeout (no subscribers for 10 minutes)

No browser clients are connected to the stream for 10 minutes.

**What happens now:** The pump closes the kiwi connection and exits. No reconnect
is scheduled. The stream still exists in the database but has no active connection.

**What the user sees:** If they navigate back to the stream, it reconnects on the
next WebSocket subscription.

**What we should show:** Nothing — this is expected behavior. The stream page should
show "connecting" when the pump restarts.

---

## Layer 3 — Server → Browser WebSocket

### W1: Browser WebSocket disconnects cleanly

The browser closes the tab, navigates away, or the WebSocket connection is reset.

**What happens now:** Server-side `ReadMessage()` returns an error. The pump goroutines
exit, unsubscribing from the stream. On the browser side, `ws.onclose` fires and
`scheduleReconnect` starts with exponential backoff (1s → 30s).

**What the user sees:** Brief interruption if reconnecting (e.g. network blip).
Nothing if navigating away.

**What we should show:** "Reconnecting" badge (already implemented).

---

### W2: Browser goes to sleep / connection silently dies

The browser's TCP connection becomes dead (laptop sleep, network switch, mobile
background) but neither side sends a close frame.

**What happens now:** The server has **no ping/pong mechanism**. The server-side pump
tries to write to the dead connection. The 5s write deadline (W3 fix) means the
write will time out rather than block forever. The pump exits and the connection is
cleaned up. However, detection still takes up to 5s per write attempt, and without
ping/pong the server won't detect a dead connection until the next write.

**What the user sees:** Everything freezes — audio stops, waterfall stops, logs stop.
Refreshing the page creates a new WebSocket but the old connection's pump goroutines
are still blocked, leaking resources on the server.

**What we should show:** The browser-side silence watchdog detects this after 10s but
currently only logs. It should trigger a reconnect. The server needs write deadlines
and ping/pong to detect and clean up dead connections.

---

### W3: Slow client — write blocks on TCP backpressure

*Fixed in commit 9b11863.*

The browser is on a slow connection or is throttled (background tab, CPU-saturated).
The server's `WriteMessage` blocks because the kernel's TCP send buffer is full.

**What happens now:** `SetWriteDeadline(5s)` is set before every `writeJSON` and
`writeBinary` call. If the write doesn't complete within 5 seconds, it returns a
timeout error. The pump logs the error to the stream log (`pump.audio.write_err`,
`pump.wf.write_err`, or `pump.log.write_err`) and exits. The connection is
effectively closed, and the browser reconnects automatically.

**What the user sees:** If the connection is too slow, the server drops it after 5s.
The browser reconnects. A brief interruption rather than a permanent freeze.

---

### W4: Fly.io proxy drops idle connection

The Fly.io proxy terminates connections that have been idle (no data in either
direction) for its timeout period.

**What happens now:** No application-level heartbeat exists between server and browser.
If there's a period with no audio, no waterfall, and no log data, the proxy may
silently close the connection. The browser's `ws.onclose` fires with no meaningful
close code.

**What the user sees:** Sudden silence, then reconnect. Could happen during quiet
radio bands or when the kiwi source is temporarily silent.

**What we should show:** The reconnect badge is sufficient. The fix is to add periodic
server-sent ping frames to keep the connection alive through the proxy.

---

### W5: Session eviction race

A client reconnects with the same `session_id` before the old connection is cleaned up.

**What happens now:** `evictStaleSession` closes the old connection. The 5s write
deadline (W3 fix) means a blocked pump goroutine will exit within 5s rather than
hanging forever.

**What the user sees:** Potential duplicate data or delayed cleanup. Usually harmless
but can cause resource leaks if the old pump goroutines don't exit promptly.

**What we should show:** Nothing — this is a server-side cleanup concern.

---

## Layer 4 — Browser Audio Pipeline

### B1: AudioContext suspended (no user gesture)

The browser's autoplay policy prevents the AudioContext from starting until the user
interacts with the page.

**What happens now:** `ensureAudio()` creates the AudioContext in "suspended" state.
The WebSocket connects and data flows. Audio frames are resampled and posted to the
worklet, but the worklet produces silence because the context is suspended.
`resumeOnGesture` listens for click/keydown and calls `ctx.resume()`.

**What the user sees:** Mute icon shown (muted state starts as `true`). Waterfall and
logs work. First click/keypress starts audio and unmutes.

**What we should show:** Current behavior is correct. The mute button visually
indicates "no audio yet" and flips to unmuted on first interaction.

---

### B2: AudioWorklet fails to load

`ctx.audioWorklet.addModule(blobURL)` throws — could be a CSP violation, a browser
bug, or a corrupted blob URL.

**What happens now:** `ensureAudio()` throws. The `.catch(() => {})` in `connect()`
swallows the error. `audioCtxRef` and `workletRef` remain null. The WebSocket
connects, data arrives, but `workletRef.current?.port.postMessage(resampled)` is
a no-op because `workletRef` is null.

**What the user sees:** **Complete silence with no error indication.** Waterfall and
logs work fine. There is no visual signal that audio is broken.

**What we should show:** An error state on the audio indicator — e.g. a red mute icon
or "audio failed" badge. The error should be logged to the console and to the log panel.

---

### B3: WebSocket never opens

Auth token expired, server down, network unreachable, or CORS issue prevents the
WebSocket handshake from completing.

**What happens now:** `ws.onerror` fires, status set to "error". `ws.onclose` fires,
`scheduleReconnect` starts backoff.

**What the user sees:** Status badge shows "error" or "reconnecting". No audio, no
waterfall, no logs.

**What we should show:** Current behavior is adequate. Could be improved with a more
descriptive message (e.g. "server unreachable" vs "auth expired").

---

### B4: WebSocket open but no data arrives

The WebSocket connection is alive (readyState === OPEN) but the server has stopped
sending data. This can happen due to K2, W3, or a server-side bug.

**What happens now:** The silence watchdog checks every 5s. If no data for 10s, it
logs `[WS-DIAG] SILENCE detected` to the console and adds a log entry. **It does
not close the WebSocket or trigger a reconnect.**

**What the user sees:** Everything freezes. The silence warning appears in the log
panel if they're watching it, but there's no prominent visual indicator and no
automatic recovery.

**What we should show:** After 10s of silence, show a "no data" warning badge. After
30s, automatically close the WebSocket and reconnect. The silence watchdog should
escalate from warning to action.

---

### B5: AudioContext interrupted

The OS interrupts audio — phone call, Bluetooth route change, audio device
disconnected, or the OS suspends the audio session.

**What happens now:** `ctx.onstatechange` fires and logs the state change. No recovery
action is taken.

**What the user sees:** Audio stops. May auto-resume when the interruption ends
(browser-dependent). No visual indicator of the interruption.

**What we should show:** If `ctx.state` transitions to "interrupted" or "suspended"
after previously being "running", show a "audio interrupted" indicator and attempt
`ctx.resume()` periodically.

---

### B6: AudioWorklet ring buffer underrun

Audio data arrives too slowly (network jitter, kiwi frame gaps) and the worklet's
ring buffer drains below `lowWatermark` (768 samples).

**What happens now:** The worklet sets `started = false` and outputs silence. When the
buffer refills to `threshold` (8192 samples), playback resumes with a 128-sample
fade-in.

**What the user sees:** Brief audio dropout followed by silence, then audio resumes.
No visual indicator.

**What we should show:** Nothing — this is expected behavior for network jitter. If
underruns become frequent (multiple per minute), it could indicate a deeper issue
and should be logged.

---

### B7: Tab throttled by browser

The browser reduces timer resolution and may throttle the tab when it's in the
background (not visible).

**What happens now:** `setInterval` and `setTimeout` fire less frequently. `ws.onmessage`
still fires but the event loop may be delayed. Audio data accumulates in the worklet's
ring buffer or gets dropped if the buffer fills.

**What the user sees:** Audio may glitch or skip when the tab is backgrounded. Waterfall
freezes. When the tab is foregrounded, audio resumes (possibly with a skip) and
the waterfall catches up or shows gaps.

**What we should show:** Nothing — this is browser behavior. Could show a "tab was
backgrounded" notice when the user returns.

---

## Waterfall-Specific Failures

### WF1: Kiwi W/F WebSocket drops but SND stays alive

The waterfall and audio connections to the kiwi are separate WebSockets. The W/F
connection can fail independently.

**What happens now:** The W/F reader goroutine exits. But `ensureReconnect` only fires
when the SND (audio) connection fails. There is **no independent reconnect for the
waterfall path.** The audio keeps playing normally.

**What the user sees:** **Waterfall freezes permanently** while audio continues. There
is no error indicator and no recovery until the entire kiwi connection cycles (e.g.
source swap or SND disconnect).

**What we should show:** "Waterfall disconnected" indicator. The server should either
reconnect the W/F connection independently or tear down both connections and do a
full reconnect.

---

### WF2: Kiwi W/F stops sending but TCP stays alive

Same as K2 but on the waterfall connection specifically.

**What happens now:** Same as K2 — no read deadline, no detection, no recovery.

**What the user sees:** Waterfall freezes. Audio may still work.

**What we should show:** Same as K2 — a "waterfall stalled" indicator after a timeout.

---

### WF3: Waterfall subscriber channel full (32 frames)

The waterfall subscriber channel is smaller than audio (32 vs 256). It fills faster
under backpressure.

**What happens now:** Frames are dropped. Unlike audio drops, waterfall drops have
**no tracking counter**. Completely invisible.

**What the user sees:** Gaps in the waterfall display. No log, no metric, no warning.

**What we should show:** Nothing for transient drops. A counter should be added for
observability.

---

### WF4: Write mutex contention freezes all channels

*Fixed in commit 9b11863.*

The audio, waterfall, and log pumps all call `client.writeBinary()` or
`client.writeJSON()` which acquire the same `sync.Mutex`. If any write blocks
(due to TCP backpressure, dead connection, etc.), it holds the mutex and all
other pumps block waiting for it.

**What happens now:** The 5s write deadline (W3 fix) bounds how long any single
write can hold the mutex. If a write times out, the pump logs the error to the
stream log and exits. The connection is effectively killed, preventing one stuck
channel from freezing the others indefinitely. The maximum mutex contention is
now 5 seconds rather than unbounded.

**What the user sees:** If the connection goes bad, the server drops it within 5s.
The browser reconnects. The write error is visible in the stream log panel.

---

### WF5: Chained pump startup failure

The pump startup is chained: audio → waterfall → log. If audio subscription fails,
neither waterfall nor log pumps start. If waterfall subscription fails, the log
pump doesn't start.

**What happens now:** The failure is logged (`[WS-DIAG] audio/waterfall subscribe FAILED`)
but there is no retry. The client is left with partial or no data channels.

**What the user sees:** Partial functionality — e.g. audio works but no waterfall or
logs. Or nothing works at all.

**What we should show:** Each channel should start independently. If a channel fails,
show a specific error ("waterfall unavailable") rather than silently omitting it.

---

## Summary: Priority of Fixes

### Critical (causes frozen UI with no recovery)

| ID | Issue | Fix |
|----|-------|-----|
| W3/WF4 | Shared mutex + no write deadline | **Fixed (9b11863).** 5s `SetWriteDeadline` on every write. Timeout kills the connection. Write errors logged to stream log. |
| W2 | Dead connection, no detection | Add server-side ping/pong (30s interval, 10s deadline). |
| B4 | Silence watchdog is log-only | After 30s of silence, close WebSocket and reconnect. |
| K2/WF2 | Kiwi silent, no read deadline | Add `SetReadDeadline(15s)` on the kiwi connection, reset on each frame. |

### High (causes extended silence or partial failure)

| ID | Issue | Fix |
|----|-------|-----|
| K5 | Keepalive failure doesn't trigger reconnect | Call `Close()` on keepalive write failure. |
| WF1 | W/F drops independently, no reconnect | Reconnect W/F independently, or tear down both and do a full reconnect. |
| WF5 | Chained pump startup | Start each pump independently. |
| B2 | Worklet load failure is silent | Surface the error to the UI. |

### Medium (causes degraded experience)

| ID | Issue | Fix |
|----|-------|-----|
| WF3 | Waterfall drops not tracked | Add a `fanoutDroppedWF` counter. |
| B5 | AudioContext interrupted, no recovery | Attempt periodic `resume()` and show indicator. |
| W4 | Fly proxy drops idle connections | Add server-sent ping frames every 30s. |
| P1 | Subscriber channel drops not surfaced | Log sustained drop events as warnings. |
