# Stream Logging Plan

## Overview

Replace the current split logging approach (backend `log.Printf` to stdout + frontend client-side fake log lines) with a unified, backend-managed, per-stream structured log system. Every meaningful event in a stream's lifecycle gets recorded in a single log buffer on the backend. The frontend reads this log over WebSocket — it never invents its own entries.

---

## Log entry structure

```go
type StreamLogEntry struct {
    Time     time.Time `json:"t"`
    StreamID string    `json:"sid"`
    Level    LogLevel  `json:"level"`
    Action   string    `json:"action"`
    From     string    `json:"from,omitempty"`
    To       string    `json:"to,omitempty"`
    Message  string    `json:"msg,omitempty"`
}

type LogLevel string

const (
    LevelError LogLevel = "error"
    LevelWarn  LogLevel = "warn"
    LevelInfo  LogLevel = "info"
    LevelDebug LogLevel = "debug"
)
```

| Field | Description | Examples |
|-------|-------------|----------|
| `Time` | When the event occurred | `2026-03-14T14:30:05.123Z` |
| `StreamID` | Which stream this belongs to | `2K1xABC...` |
| `Level` | Severity | `error`, `warn`, `info`, `debug` |
| `Action` | Machine-readable event category | `connect`, `retune`, `fallback.switch` |
| `From` / `To` | Only for over-the-wire messages | `wavetoy`→`kiwi`, `wavetoy`→`client` |
| `Message` | Human-readable detail (kept terse) | `freq=14100.0 mode=am` |

### When to use `From` → `To`

The `from`/`to` fields exist only for messages that cross a network boundary:

- **wavetoy → kiwi**: Commands we send to a KiwiSDR (`SET mod=...`, `SET zoom=...`, dial attempts)
- **kiwi → wavetoy**: Data/messages the KiwiSDR sends us (`sample_rate=12000`, SND frames, MSG responses)
- **wavetoy → client**: WebSocket messages we push to a browser subscriber
- **client → wavetoy**: WebSocket messages a browser subscriber sends us (`patch`, `wf_config`, `switch_fallback`)

Internal state transitions within wavetoy (pump started, quality state changed, reconnect decision made) do NOT use `from`/`to` — the action and message are sufficient.

### Log levels

**error** — Something failed and we couldn't recover automatically. The stream is degraded or broken, and the situation needs attention.

**warn** — Something unexpected happened but the system handled it. Degraded performance, dropped frames, a probe that failed to connect, a fallback with no suggestions available.

**info** — Normal lifecycle events. Connections, disconnections, retunes, subscriber changes, fallback switches, state transitions. The backbone of the log — you should be able to read only `info` entries and understand the full story of what happened.

**debug** — Verbose detail useful for diagnosing specific problems. KiwiSDR protocol negotiation, ADPCM state syncs, individual probe scores, per-frame quality metrics, waterfall parameter calculations. Off by default. Eventually exposed as a per-stream "debug mode" toggle.

### Rendered format

When serialized for display in the frontend log panel:

```
14:30:05 INF connect         connected source=sdr.example.com freq=14100.0 mode=am
14:30:05 INF wf.connect      waterfall connected
14:30:06 INF subscriber.add  audio subscriber added (total=1) session=abc123
14:30:30 INF retune           freq 14100.0 → 7200.0
14:31:00 INF quality.ok       healthy fps=30.2 rms=-28.3dB
14:32:15 WRN disconnect       connection lost: read timeout
14:32:15 INF reconnect.start  attempt=1 backoff=1s
14:32:16 INF connect          reconnected source=sdr.example.com
14:35:00 INF fb.probe         probing source=sdr2.example.com (3/10)
14:35:04 INF fb.score         source=sdr2.example.com score=87% rank=1
14:40:00 WRN quality.degraded frame_gap=3.2s fps=8.1
14:40:05 INF fb.switch        sdr.example.com → sdr2.example.com (score=87%)
14:40:05 INF connect          connected source=sdr2.example.com freq=14100.0 mode=am
```

Over-the-wire messages include the direction:

```
14:30:04 DBG dial             wavetoy → kiwi dialing wss://sdr.example.com:8073
14:30:05 DBG kiwi.msg         kiwi → wavetoy sample_rate=12000
14:30:06 DBG ws.send          wavetoy → client connected msg sent session=abc123
14:30:30 DBG kiwi.cmd         wavetoy → kiwi SET mod=lsb low_cut=-2700 high_cut=-300 freq=7200.000
```

The frontend omits the `StreamID` column since the panel is already scoped to one stream. An agent or debug dump includes it.

---

## Log level guidelines

### error

| Action | When | Example message |
|--------|------|-----------------|
| `connect.fail` | KiwiSDR dial failed and we're giving up (not retrying) | `source=sdr.example.com err=connection refused` |
| `reconnect.fail` | All reconnection attempts exhausted | `abandoned after 15 attempts` |
| `fb.failover.fail` | Fallback failover attempted but reconfigure failed | `target=sdr2.example.com err=dial timeout` |
| `pump.error` | Audio pump hit an unrecoverable error | `sample channel closed unexpectedly` |
| `capture.fail` | Audio capture requested but failed | `ring buffer nil` |
| `patch.fail` | Stream patch failed (DB error, source not found) | `source not found: abc123` |

### warn

| Action | When | Example message |
|--------|------|-----------------|
| `disconnect` | KiwiSDR connection lost (will attempt reconnect) | `read timeout` |
| `wf.disconnect` | Waterfall connection lost (audio continues) | `read error: EOF` |
| `wf.timeout` | No waterfall data received within 15s | `no data in 15s` |
| `quality.degraded` | Quality monitor entered degraded state | `reason=frame_gap gap=3.2s` |
| `quality.failing` | Quality held degraded past holdoff, escalating | `reason=frame_gap held=5.1s` |
| `frame.drop` | Audio frame dropped (slow subscriber) | `subscriber queue full` |
| `kiwi.queue.drop` | KiwiSDR PCM channel full, frame dropped | `pcm channel full` |
| `fb.nosuggestions` | Failover triggered but no fallback suggestions available | `cannot failover, no candidates` |
| `fb.probe.fail` | Probe failed to connect to a candidate | `source=sdr3.example.com err=timeout` |
| `fb.nocandidates` | Discovery found zero candidates | `no sources within 2000km` |
| `patch.conflict` | Optimistic concurrency conflict on patch | `version=5 current=6` |
| `ws.resume.err` | Resume topic failed (stream not found) | `stream not found for topic stream:abc` |

### info

| Action | When | Example message |
|--------|------|-----------------|
| `connect` | KiwiSDR SND connection established | `source=sdr.example.com freq=14100.0 mode=am` |
| `reconnect.start` | Reconnection attempt starting | `attempt=3 backoff=4s` |
| `reconnect.ok` | Reconnection succeeded | `after 3 attempts source=sdr.example.com` |
| `reconnect.abandon` | Reconnection loop giving up (no subscribers, no auto-fb) | `no subscribers, auto_fallback=off` |
| `wf.connect` | Waterfall connection established | (none needed) |
| `retune` | Frequency, mode, bandwidth, or AGC changed in-place | `freq 14100.0→7200.0 mode am→lsb` |
| `source.switch` | Source changed (manual, via patch) | `sdr.example.com → sdr2.example.com` |
| `filter.update` | Filter config changed | `nr=on notch=60Hz` |
| `state.change` | Stream state transition | `connecting → active` |
| `pump.start` | Audio pump goroutine started | `gen=3` |
| `pump.stop` | Audio pump goroutine exited | `reason=kiwi_closed gen=3` |
| `wf.pump.start` | Waterfall pump started | `gen=3` |
| `wf.pump.stop` | Waterfall pump exited | `gen=3` |
| `subscriber.add` | Audio subscriber added | `total=2 session=abc123` |
| `subscriber.remove` | Audio subscriber removed | `total=1 session=abc123` |
| `wf.subscriber.add` | Waterfall subscriber added | `total=1 session=abc123` |
| `wf.subscriber.remove` | Waterfall subscriber removed | `total=0 session=abc123` |
| `ws.connect` | WebSocket client connected and subscribed to this stream | `session=abc123 via=global` |
| `ws.disconnect` | WebSocket client disconnected from this stream | `session=abc123` |
| `ws.evict` | Stale session evicted (same session_id reconnected) | `session=abc123` |
| `peer.join` | Peer joined (broadcast to others) | `session=abc123` |
| `peer.leave` | Peer left | `session=abc123` |
| `patch` | Stream configuration patched | `changed=[frequency_khz,mode] by=abc123` |
| `wf.view` | Waterfall view bounds changed | `start=7000 end=7300 by=abc123` |
| `quality.ok` | Quality returned to healthy from degraded/failing | `recovered` |
| `quality.disconnect` | Quality monitor recorded a full disconnect | `connection_lost → failing` |
| `fb.enable` | Auto-fallback enabled | (none needed) |
| `fb.disable` | Auto-fallback disabled | (none needed) |
| `fb.cycle` | Probe cycle started | (none needed) |
| `fb.discover` | Candidate discovery completed | `found=8 healthy=5 within=2000km` |
| `fb.ref` | Reference snapshot captured from live stream | `rms=-28dB silence=0.02 fps=30` |
| `fb.probe` | Probing a candidate | `source=sdr2.example.com (3/5)` |
| `fb.score` | Candidate scored | `source=sdr2.example.com score=87% rank=1` |
| `fb.cycle.done` | Probe cycle completed | `suggestions=3 top=87%` |
| `fb.switch` | Automatic failover executed | `sdr.example.com → sdr2.example.com score=87% reason=frame_gap` |
| `fb.switch.manual` | Manual source switch via fallback UI | `sdr.example.com → sdr2.example.com` |
| `fb.reprobe` | Reprobe requested, cycle restarting | (none needed) |
| `fb.clear` | Suggestions cleared (after switch) | (none needed) |
| `capture` | Audio capture requested | `duration=5m samples=7200000` |
| `created` | Stream created | `source=sdr.example.com freq=14100.0` |
| `deleted` | Stream deleted | (none needed) |

### debug

| Action | When | Example message |
|--------|------|-----------------|
| `dial` | About to dial KiwiSDR (before connect result) | `wavetoy→kiwi wss://sdr.example.com:8073/{ts}/SND` |
| `dial.wf` | About to dial KiwiSDR waterfall | `wavetoy→kiwi wss://sdr.example.com:8073/{ts}/W/F` |
| `kiwi.cmd` | Command sent to KiwiSDR | `wavetoy→kiwi SET mod=am low_cut=-4900 high_cut=4900 freq=14100.000` |
| `kiwi.msg` | MSG received from KiwiSDR | `kiwi→wavetoy sample_rate=12000` |
| `kiwi.snd.first` | First SND audio frame received | `kiwi→wavetoy bytes=1024 compressed=true flags=0x90` |
| `kiwi.wf.first` | First waterfall frame received | `kiwi→wavetoy bins=1024 xbin=0 zoom=3` |
| `kiwi.adpcm` | ADPCM decoder state synced from server | `kiwi→wavetoy index=42 prev=1234` |
| `kiwi.samplerate` | Sample rate negotiated | `kiwi→wavetoy audio_rate=12000 → SET AR OK in=12000 out=12000` |
| `kiwi.bandwidth` | WF bandwidth received | `kiwi→wavetoy bandwidth=30000kHz` |
| `ws.hello` | Client hello message received | `client→wavetoy session=abc123 color=#ff5500` |
| `ws.subscribe` | Client subscribed to stream topic | `client→wavetoy topic=stream:abc123` |
| `ws.unsubscribe` | Client unsubscribed from stream topic | `client→wavetoy topic=stream:abc123` |
| `ws.patch` | Patch message received (before processing) | `client→wavetoy fields=[frequency_khz,mode] version=5` |
| `ws.wf_config` | Waterfall config message received | `client→wavetoy zoom=3 center=14100 speed=4` |
| `ws.resume` | Client reconnected with resume state | `client→wavetoy topics=1 version_match=true` |
| `ws.send.connected` | Connected message sent to client | `wavetoy→client sample_rate=12000 peers=2` |
| `ws.send.updated` | Stream updated message sent | `wavetoy→client changed=[frequency_khz] version=6` |
| `pump.metrics` | Periodic audio pipeline health (every 10s) | `uptime=120s subs=2 kiwi_frames=1800 kiwi_bytes=3686400 fanout_ok=3600 fanout_drop=0` |
| `quality.check` | Quality monitor periodic check (every 1s, only when interesting) | `fps=30.2 gap=0.0s errs=0 state=healthy` |
| `reconnect.precheck` | Reconnect loop pre-connect state check | `subs=2 auto_fb=true client_nil=true` |
| `reconnect.race` | Reconnect discovered another path already reconnected | `client already set, discarding new connection` |
| `fb.health` | Health check results for candidates | `checked=8 healthy=5` |
| `fb.filter` | Candidate filtered out during discovery | `source=sdr4.example.com reason=unavailable` |
| `fb.probe.detail` | Detailed probe metrics | `rms=-30dB floor=-55dB silence=0.03 spectral=0.82 latency=340ms` |
| `fb.ref.persist` | Reference audio persisted to DB | `bytes=72000 sample_rate=12000` |
| `fb.suggest.persist` | Suggestions persisted to DB | `rows=3` |
| `wf.params` | Waterfall zoom/center calculated from view bounds | `view=7000-7300kHz → zoom=7 center=7150` |
| `startstream.race` | Concurrent startStream detected, discarding duplicate | `already tracked, closing new connection` |

---

## What does NOT get its own log entry

Some things are too frequent, too low-level, or not per-stream:

| Thing | Why not | Where it lives instead |
|-------|---------|----------------------|
| Individual audio frames (24+ per second) | Would fill buffer in seconds | Summarized in `pump.metrics` debug entry every 10s |
| Individual waterfall frames | Same | Summarized in `pump.metrics` |
| KiwiSDR keepalive sends (every 3s) | Pure noise, no information content | Nowhere — fire and forget |
| Source sync / health check (global) | Not per-stream | `slog` stdout with source context |
| HTTP request/response logging | Not per-stream | Standard HTTP middleware |
| Frontend UI state (selected tab, panel collapsed) | Not a stream event | Frontend local state |
| ADPCM decode per-nibble | Absurd volume | Nowhere |
| Quality check when nothing changed | Would be 1/sec of "still healthy" | Only logged at `debug` when state is non-healthy or metrics are interesting |

---

## Architecture

### StreamLogger (new package: `internal/streamlog`)

```
┌───────────────────────────────────────────────────────────┐
│                     StreamLogger                          │
│                                                           │
│  config:                                                  │
│    defaultLevel = info  (per-stream overridable)          │
│    bufferSize   = 2000                                    │
│                                                           │
│  map[streamID] → *StreamLog                               │
│                      │                                    │
│                      ├── ring buffer (2000 entries)       │
│                      ├── current level (info or debug)    │
│                      ├── subscriber channels (fan-out)    │
│                      └── also writes to slog (stdout)     │
│                                                           │
│  Methods:                                                 │
│    Info(streamID, action, msg)                             │
│    Warn(streamID, action, msg)                             │
│    Error(streamID, action, msg)                            │
│    Debug(streamID, action, msg)                            │
│    Wire(streamID, level, action, from, to, msg)           │
│    Subscribe(streamID) → (<-chan StreamLogEntry, unsub)    │
│    Snapshot(streamID, opts) → []StreamLogEntry             │
│    SetLevel(streamID, level)                               │
│                                                           │
└───────────────────────────────────────────────────────────┘
         │                            ▲
         │ writes structured          │ reads
         ▼                            │
   ┌──────────┐              ┌────────────────┐
   │  stdout   │              │  WebSocket      │
   │  (slog)   │              │  stream_log     │
   └──────────┘              └────────────────┘
```

### Ring buffer: 2000 entries

At typical activity levels:

- **Idle stream (auto-fallback on, info level):** ~3 entries per 5-minute probe cycle → ~55 hours of history.
- **Active stream (user tuning around, info level):** ~1-3 entries per retune → easily 30-60 minutes of dense activity.
- **Failover event:** ~15-20 entries (probe cycle + quality transition + switch + reconnect).
- **Debug mode on:** ~6 entries per 10s (metrics) + 1/s (quality) + protocol messages → fills in ~15-30 minutes depending on activity. This is fine — debug mode is temporary.
- **Agent context:** 2000 entries × ~80 chars average ≈ 160K chars ≈ 40K tokens at maximum fullness. In practice you'd request the last 200-500 entries with level/action filters, landing at 5-15K tokens.

### Level filtering

Each `StreamLog` has a `level` field (default: `info`). Entries below this level are discarded before they enter the ring buffer. This means:

- At `info` level: `error`, `warn`, and `info` entries are stored. `debug` entries are silently dropped.
- At `debug` level: everything is stored. The buffer fills faster but gives full protocol-level visibility.

The level is per-stream, so you can turn on debug for one problematic stream without flooding others.

### WebSocket delivery

Subscribers receive all entries that pass the level filter (i.e., everything in the ring buffer). The `stream_log` message payload becomes a structured object:

```json
{
  "type": "stream_log",
  "entry": {
    "t": "2026-03-14T14:30:05.123Z",
    "level": "info",
    "action": "connect",
    "msg": "connected source=sdr.example.com freq=14100.0 mode=am"
  }
}
```

The `sid` field is omitted from the WebSocket payload since the client is already subscribed to a specific stream.

Over-the-wire entries include `from`/`to`:

```json
{
  "type": "stream_log",
  "entry": {
    "t": "2026-03-14T14:30:04.800Z",
    "level": "debug",
    "action": "kiwi.cmd",
    "from": "wavetoy",
    "to": "kiwi",
    "msg": "SET mod=am low_cut=-4900 high_cut=4900 freq=14100.000"
  }
}
```

### Snapshot on connect

When a client subscribes, the server sends the current ring buffer as an initial batch:

```json
{
  "type": "stream_log_history",
  "entries": [ ... ]
}
```

A client connecting to a stream that's been running for 20 minutes immediately sees the full history — connections, retunes, fallback events, everything that happened before they opened the tab.

### stdout mirror

Every entry also emits to Go's `log/slog` structured logger:

```
level=INFO msg="stream event" stream=2K1x... action=connect detail="connected source=sdr.example.com freq=14100.0"
level=WARN msg="stream event" stream=2K1x... action=disconnect detail="read timeout"
level=DEBUG msg="stream event" stream=2K1x... action=kiwi.cmd from=wavetoy to=kiwi detail="SET mod=am ..."
```

This replaces the current `log.Printf("[STREAM] ...")` calls. Backend operators still see everything on stdout.

---

## Frontend changes

### Remove all client-side log fabrication

The `log()` callback in `stream-player-page.tsx` and all ~25 call sites get deleted. Every one of these events will instead come from the backend as a real stream log entry.

| Current client-side log | Replaced by backend entry |
|------------------------|--------------------------|
| `"connected, subscribed to stream"` | `info` `ws.connect` |
| `"session ready"` | (implicit in `ws.connect`) |
| `"stream updated"` | `info` `retune` / `patch` / `source.switch` (specific) |
| `"peer joined (id)"` | `info` `peer.join` |
| `"peer left (id)"` | `info` `peer.leave` |
| `"source change sent"` | `info` `source.switch` |
| `"auto-fallback enabled"` | `info` `fb.enable` |
| `"fallback probe complete"` | `info` `fb.cycle.done` |
| `"source switched: A → B"` | `info` `fb.switch` / `fb.switch.manual` |
| `"not connected"` | (frontend UI state — show a banner, not a log entry) |
| `"socket closed, reconnecting..."` | (frontend transport — show a banner) |
| `"reconnecting in Nms..."` | (frontend transport — show a banner) |
| `"socket error"` | (frontend transport — show a banner) |

**WebSocket transport events** (browser socket open/close/reconnect) are frontend transport concerns. They should appear as a UI status indicator (banner, icon), not in the stream log. The stream log shows what happened to the *stream* — which keeps running on the backend regardless of whether your browser tab is connected. When the browser reconnects, it receives `stream_log_history` and catches up on everything it missed.

### Log panel rendering

Update `LogsPanel` to accept structured entries and render them with:

- **Level-based styling:** errors in red, warnings in amber/yellow, info in default text, debug in muted/gray
- **Compact timestamp:** `HH:MM:SS` (no date, no milliseconds in the panel — tooltip can show full timestamp)
- **Action as the primary identifier:** monospace, fixed-width column
- **Direction arrows** only when `from`/`to` are present
- **Level filtering UI:** dropdown or toggle to show/hide debug entries (when debug mode is on for the stream)

---

## API

### Live log subscription (WebSocket)

Already described above — subscribe to a stream topic and receive `stream_log_history` + live `stream_log` messages.

### Log snapshot (HTTP)

```
GET /api/streams/{id}/logs?limit=200&level=info&actions=connect,disconnect,fb.*
```

| Param | Default | Description |
|-------|---------|-------------|
| `limit` | 200 | Max entries to return (max 2000 = full buffer) |
| `level` | `info` | Minimum level to include (`debug` returns everything) |
| `actions` | (all) | Comma-separated action prefixes, `*` suffix for prefix match |

Response:

```json
{
  "stream_id": "2K1xABC...",
  "count": 42,
  "level": "info",
  "entries": [
    {
      "t": "2026-03-14T14:30:05.123Z",
      "level": "info",
      "action": "connect",
      "msg": "connected source=sdr.example.com freq=14100.0 mode=am"
    }
  ]
}
```

### Debug mode toggle

```
POST /api/streams/{id}/debug
{ "enabled": true }
```

Sets the per-stream log level to `debug` (or back to `info`). Also available as a WebSocket message:

```json
{ "type": "set_debug", "enabled": true }
```

When debug mode is enabled, the frontend log panel automatically shows debug entries and applies debug styling. When disabled, debug entries stop being generated and the buffer gradually fills with only info+ entries.

---

## Implementation plan

### Phase 1: StreamLogger core + streammgr migration

**New files:**

- `internal/streamlog/entry.go` — `StreamLogEntry`, `LogLevel`, formatting helpers, action constants
- `internal/streamlog/logger.go` — `StreamLogger`, `StreamLog`, ring buffer, subscriber fan-out, level filtering

**Changes:**

- `cmd/server/main.go` — Create `StreamLogger` (buffer=2000, default level=info), inject into managers. Switch from stdlib `log` to `slog` for the default logger.
- `internal/streammgr/manager.go` — Accept `*streamlog.StreamLogger`. Replace all `log.Printf("[STREAM]"` and `log.Printf("[AUDIO_PIPELINE]"` calls with appropriate `streamLogger.Info/Warn/Error/Debug` calls. Remove `logSubscribers`, `broadcastLog` from `activeStream`.

### Phase 2: Fallback + quality + kiwi logging

**Changes:**

- `internal/fallback/manager.go` — Accept `*streamlog.StreamLogger`. Replace `log.Printf("[FALLBACK]"` calls.
- `internal/fallback/quality.go` — Log state transitions (`quality.degraded`, `quality.ok`, `quality.failing`).
- `internal/fallback/prober.go` — Log probe lifecycle (`fb.probe`, `fb.probe.fail`). Detailed metrics at debug level.
- `internal/kiwi/client.go` — Accept an optional log callback. Protocol messages (`kiwi.cmd`, `kiwi.msg`, `kiwi.snd.first`) logged at debug level. The kiwi package doesn't know about stream IDs — the callback is wired by streammgr.
- `internal/kiwi/wf_client.go` — Same pattern.

### Phase 3: WebSocket layer + frontend

**Changes:**

- `internal/api/stream_ws.go` — Log WebSocket lifecycle events (`ws.connect`, `ws.disconnect`, `peer.join`, `peer.leave`, `patch`, `retune`). Use `streamLogger.Subscribe` instead of `streammgr.SubscribeLogs`. Send `stream_log_history` on connect, structured `stream_log` entries live.
- `internal/api/global_ws.go` — Same changes. Log `ws.resume`, `ws.evict`, topic subscribe/unsubscribe at debug level.
- `internal/api/streams.go` — Log `created`, `deleted`. Add `GET /api/streams/{id}/logs` endpoint. Add `POST /api/streams/{id}/debug` endpoint.
- `internal/streammgr/manager.go` — Remove `SubscribeLogs` method entirely (replaced by `streamLogger.Subscribe`).
- `frontend/src/routes/stream-player-page.tsx` — Delete `log()` callback and all ~25 client-side log calls. Consume structured `stream_log` and `stream_log_history` messages. Show WebSocket transport status as a UI banner instead.
- `frontend/src/components/logs-panel.tsx` — Accept structured entries. Level-based coloring. Optional level filter UI.
- `frontend/src/components/fallback-section.tsx` — Remove `onLog` callback and all log calls.

### Phase 4: Debug mode

**Changes:**

- `internal/streamlog/logger.go` — `SetLevel(streamID, level)` method.
- `internal/api/streams.go` — `POST /api/streams/{id}/debug` endpoint.
- `internal/api/global_ws.go` — Handle `set_debug` WebSocket message.
- `frontend/` — Debug mode toggle in stream UI, auto-show debug entries when enabled.

---

## Migration strategy

Phases 1+2 can land in a single PR. The frontend continues to show its fabricated logs alongside new `[server]` entries during this period. No breaking changes.

Phase 3 is the breaking frontend change. The `stream_log` payload format changes from `{ message: string }` to `{ entry: StreamLogEntry }`. The `stream_log_history` message is new. This should be a single PR with both backend and frontend changes.

Phase 4 is independent polish.

---

## Message guidelines

1. **No redundancy.** Don't repeat the action in the message. The action is `connect`, so the message says `source=sdr.example.com freq=14100.0 mode=am`, not `connected to source=...`.
2. **Key=value for structured data.** `freq=14100.0 mode=am source=sdr.example.com score=87%`.
3. **Short identifiers.** Use hostnames not full URLs. Truncate KSUIDs only if space is critical.
4. **No stack traces.** Truncate error messages to 120 chars.
5. **No periodic noise.** Don't log events that fire on a timer unless something *changed*. Quality checks at debug level only log when state is non-healthy. Metrics summaries log at debug level every 10s.
6. **Direction for wire messages only.** `wavetoy→kiwi` and `kiwi→wavetoy` for KiwiSDR protocol. `wavetoy→client` and `client→wavetoy` for WebSocket messages. Everything else is internal and doesn't need direction.

---

## Summary of file changes

| File | Change |
|------|--------|
| `internal/streamlog/entry.go` | **New.** `StreamLogEntry`, `LogLevel`, action constants, formatting helpers. |
| `internal/streamlog/logger.go` | **New.** `StreamLogger`, `StreamLog`, ring buffer (2000), level filtering, fan-out. |
| `internal/streammgr/manager.go` | Accept `StreamLogger`, replace `log.Printf` calls, remove `logSubscribers`/`broadcastLog`/`SubscribeLogs`. |
| `internal/fallback/manager.go` | Accept `StreamLogger`, replace `log.Printf` calls. |
| `internal/fallback/quality.go` | Log state transitions to `StreamLogger`. |
| `internal/fallback/prober.go` | Log probe events to `StreamLogger`. |
| `internal/kiwi/client.go` | Optional log callback for debug-level protocol logging. |
| `internal/kiwi/wf_client.go` | Same. |
| `internal/api/stream_ws.go` | Log WS lifecycle, use `StreamLogger.Subscribe`, send structured entries + history. |
| `internal/api/global_ws.go` | Same, plus resume/evict logging. |
| `internal/api/streams.go` | Log create/delete, add `/logs` and `/debug` endpoints. |
| `cmd/server/main.go` | Create `StreamLogger`, inject everywhere, configure `slog`. |
| `frontend/src/routes/stream-player-page.tsx` | Remove `log()` and all fabricated log calls, consume structured entries, transport status as banner. |
| `frontend/src/components/logs-panel.tsx` | Structured entry types, level-based coloring, level filter. |
| `frontend/src/components/fallback-section.tsx` | Remove `onLog` calls. |
