# SNR History: Time-Series Tracking & Analysis

## The Idea

Right now, the SNR reading for a source is a single number — either the broadband `snr_dbm` from the KiwiSDR's `/status` endpoint (updated once per health check cycle, typically hourly), or the in-band SNR computed during a 30-second probe window. Both are point-in-time snapshots. You can't answer questions like:

- "Does this source get noisier at night?"
- "Has this source been degrading over the past week?"
- "Which sources are most consistent across time of day?"
- "Is the current SNR reading anomalous or typical for this time of day?"

By recording SNR at every health check and building a time-series, we can answer all of these. The health check already runs hourly against every source in the database (~800+ KiwiSDRs). Each check parses the `snr` field from `/status`. Today that value overwrites `sources.snr_dbm` — we throw away the previous reading. Instead, we append it to a history table.

---

## What We Already Have

### Health check SNR (`sources.snr_dbm`)

The KiwiSDR `/status` endpoint reports a broadband SNR value (e.g. `snr=50,51`). `parseStatus` in `internal/sync/health.go` averages the values and writes the result to `sources.snr_dbm` via `SetSourceStatus`. This runs every `HealthInterval` (default 1 hour) for all sources.

This is a **receiver-wide** measurement — it reflects the overall noise environment of the KiwiSDR, not a specific frequency. A KiwiSDR in a quiet rural area might report 55 dB; one in a city might report 25 dB. It doesn't tell you whether a specific shortwave frequency has signal, but it's a strong proxy for receiver site quality and local interference.

### In-band SNR (probe system)

The `internal/snr/` package computes SNR for a specific frequency by comparing in-band waterfall bins to out-of-band reference regions. This is used in:

- **Probes**: `snr.FromWFFrames` during a 30-second probe session → stored as `probe_suggestions.in_band_snr_db`
- **Quality monitor**: `snr.FromWFFrame` every 10s on the live stream → in-memory rolling window (12 samples, ~2 min), used for degradation detection

Neither is recorded historically. Probe results overwrite the previous row. The quality monitor discards samples after 2 minutes.

### What's missing

A persistent time-series of SNR readings that lets you see patterns over hours, days, and weeks. The data is already flowing through the system — we just need to stop throwing it away.

---

## Design

### New table: `snr_readings`

```sql
CREATE TABLE snr_readings (
    source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    snr_dbm     FLOAT NOT NULL,
    users       INT,
    max_users   INT,
    PRIMARY KEY (source_id, recorded_at)
);

CREATE INDEX idx_snr_readings_source_time ON snr_readings (source_id, recorded_at DESC);
```

One row per source per health check. At ~800 sources and 24 checks/day, that's ~19,200 rows/day, ~576,000 rows/month. With the index on `(source_id, recorded_at DESC)`, queries for a specific source's recent history are fast.

We store `users` and `max_users` alongside SNR because they're useful context — a source with high SNR but 4/4 user slots full isn't useful. These values are already parsed in `parseStatus`.

### Why broadband SNR and not in-band?

The health check doesn't connect to the KiwiSDR's audio or waterfall streams — it just fetches `/status` over HTTP. Computing in-band SNR requires a WebSocket connection, tuning to a frequency, and collecting waterfall frames. That would be 800+ WebSocket connections per cycle, each needing ~5 seconds minimum. It's a full probe, not a health check.

The broadband SNR from `/status` is free — we already have it. It answers a different but still valuable question: "how noisy is this receiver's environment?" A source whose broadband SNR drops 20 dB every evening likely has local interference (a neighbor's plasma TV, a switching power supply, etc.). That pattern repeats predictably and affects every frequency.

In-band SNR history is also valuable but comes from probe cycles (per-stream, per-frequency, every 10 minutes when active). That's a much smaller dataset and a different granularity — see "Future: Probe SNR History" below.

### Recording readings

In `SetSourceStatus` (or immediately after it in the health check loop), insert into `snr_readings`:

```go
func (h *HealthChecker) Run(ctx context.Context) error {
    sources, err := h.db.ListSourceIDsForHealthCheck(ctx)
    // ...
    for _, s := range sources {
        go func(src db.SourceForHealthCheck) {
            st, ok := h.fetchStatus(ctx, src.Host, src.Port, src.UseTLS)
            if ok {
                h.db.SetSourceStatus(ctx, src.ID, st)
                if st.SNRDBM != nil {
                    h.db.InsertSNRReading(ctx, src.ID, *st.SNRDBM, st.Users, st.MaxListeners)
                }
            }
            // ...
        }(s)
    }
}
```

`InsertSNRReading` is a simple INSERT:

```go
func (db *DB) InsertSNRReading(ctx context.Context, sourceID string, snrDBM float64, users, maxUsers int) error {
    _, err := db.Pool.Exec(ctx,
        `INSERT INTO snr_readings (source_id, snr_dbm, users, max_users) VALUES ($1, $2, $3, $4)`,
        sourceID, snrDBM, users, maxUsers)
    return err
}
```

### Moving average

For each source, maintain a moving average alongside the raw readings. Rather than computing it on read (which would require scanning many rows), store it as a column on `sources`:

```sql
ALTER TABLE sources ADD COLUMN snr_ema FLOAT;
```

Updated on each health check:

```go
const snrEMAAlpha = 0.03 // effective window ≈ 72 readings ≈ 3 days at hourly checks

func (db *DB) SetSourceStatus(ctx context.Context, id string, st SourceStatus) error {
    // existing update query, add:
    // snr_ema = CASE WHEN snr_ema IS NULL THEN $snr ELSE $alpha * $snr + (1-$alpha) * snr_ema END
}
```

Alpha of 0.03 gives an effective window of ~72 readings (~3 days at hourly checks). A single noisy reading barely moves the average. A sustained change over a day or two will shift it clearly.

The EMA is useful everywhere the code currently reads `snr_dbm`. Rather than adding new scoring logic or special filtering, we simply replace `snr_dbm` with `COALESCE(snr_ema, snr_dbm)` in every query that reads it. This means:
- **Map coloring**: dots colored by the stable EMA instead of a single-point reading that flickers on temporary interference
- **Source listings and detail panel**: the SNR value shown is the EMA
- **Probe candidate discovery**: `DiscoverCandidates` already reads `snr_dbm` when building candidate lists — reading `snr_ema` instead gives a more trustworthy picture of receiver site quality
- **Any future consumer**: gets the smoothed value by default

The `snr_dbm` column continues to hold the latest raw reading (useful for the time-series chart and for seeing "what did the last health check say"). The EMA is the public-facing number.

### Retention

Keep 30 days of raw readings, drop everything older. There's already a daily retention goroutine in `main.go` that prunes expired offloaded chunk rows — add `DeleteExpiredSNRReadings` to the same loop:

```go
go func() {
    retentionDays := 30
    ticker := time.NewTicker(24 * time.Hour)
    defer ticker.Stop()
    for {
        cutoff := time.Now().AddDate(0, 0, -retentionDays)
        // existing chunk cleanup ...
        database.DeleteExpiredSNRReadings(ctx, cutoff)
        // ...
    }
}()
```

30 days at hourly resolution is plenty — the EMA captures the long-term trend, and the raw readings give you the detail for recent analysis.

---

## API

### `GET /sources/{id}/snr-history`

Returns the raw time-series for a source.

Query params:
- `from` — start time (ISO 8601), default 24 hours ago
- `to` — end time (ISO 8601), default now

Response:

```json
{
    "source_id": "abc123",
    "source_name": "KiwiSDR @ AB1CDE",
    "readings": [
        { "t": "2026-03-20T14:00:00Z", "snr": 48.5, "users": 2, "max_users": 4 },
        { "t": "2026-03-20T15:00:00Z", "snr": 47.2, "users": 1, "max_users": 4 },
        ...
    ],
    "ema": 47.8,
    "stats": {
        "avg": 46.3,
        "min": 32.1,
        "max": 52.0,
        "stddev": 4.2,
        "count": 24
    }
}
```

---

## Frontend

### Source detail panel: SNR chart

When viewing a source (the existing source details panel), add a chart showing SNR over time. This is the primary visualization.

**Chart requirements:**
- Line chart, time on x-axis, SNR (dB) on y-axis
- Default view: last 24 hours (one dot per hour)
- Switchable to: 7 days, 30 days
- Overlay the EMA as a smoothed line
- Show user count as a secondary axis or as dot size/color — helps correlate "SNR dropped because 4/4 users were on"
- Horizontal reference line at the current `snr_ema` value

**Chart library:** Given the frontend is React/TypeScript, a lightweight option like [Recharts](https://recharts.org/) or [uPlot](https://github.com/leeoniya/uPlot) works. uPlot is faster for time-series data; Recharts is more React-idiomatic. Since this is the only chart in the app currently, pick whichever is simpler to integrate.

### Source map and listings: EMA everywhere

Every place that currently reads `snr_dbm` for display or filtering switches to `COALESCE(snr_ema, snr_dbm)`. This includes:
- `ListSources`, `ListMapSources`, `GetSource` queries
- The `Source` model's `SNRDBM` field (which now carries the EMA value)
- The map dot coloring in the frontend
- `DiscoverCandidates` in the probe system

No new scoring factors, no hourly deprioritization, no stability weights. The probe system's `ScoreCandidate` is unchanged — the EMA just means the `snr_dbm` value it sees for candidate filtering is more stable.

The change is backward-compatible: `snr_ema` is `NULL` until the first health check after deployment, and `COALESCE` falls back to `snr_dbm`.

---

## Implementation Order

### Phase 1: Record history and EMA

| # | Task | Notes |
|---|------|-------|
| 1 | Migration: create `snr_readings` table, add `snr_ema` to `sources` | Single migration. `snr_ema` nullable, null until first health check |
| 2 | `InsertSNRReading` DB method | Simple INSERT, called from health check loop |
| 3 | Update `SetSourceStatus` to compute `snr_ema` | EMA with alpha=0.03 (~3-day window), handle null (first reading) |
| 4 | Switch all `snr_dbm` reads to `COALESCE(snr_ema, snr_dbm)` | `ListSources`, `ListMapSources`, `GetSource`, `DiscoverCandidates`, etc. |
| 5 | Retention job: prune `snr_readings` older than 30 days | Run daily |
| 6 | `ListSNRReadings(sourceID, from, to)` DB method | For the API |
| 7 | `GET /sources/{id}/snr-history` API endpoint | Returns readings + stats |

**Verification:** Run health checks, confirm rows appear in `snr_readings`, confirm `snr_ema` updates on `sources`. Confirm the map, source lists, and probe candidate discovery all read the EMA. Hit the API endpoint and see readings.

### Phase 2: Frontend chart

| # | Task | Notes |
|---|------|-------|
| 8 | Add chart library dependency | Recharts or uPlot |
| 9 | SNR time-series chart in source detail panel | Line chart, 24h/7d/30d views |

---

## Data Volume Estimates

| Table | Rows/day | Max rows (30-day cap) | Row size (est.) | Max size |
|-------|----------|-----------------------|-----------------|----------|
| `snr_readings` | ~19,200 | ~576,000 | ~60 bytes | ~33 MB |

With 30-day retention, `snr_readings` stays under 600K rows. Postgres handles this trivially. The index on `(source_id, recorded_at DESC)` means per-source queries scan at most ~720 rows (30 days × 24 readings/day).
