# SDR Radio

Backend for the SDR radio group listening app. Scrapes KiwiSDR sources and health-checks them.

## Features

- **Source sync**: Fetches KiwiSDR list from kiwisdr.com/.public/ or rx.kiwisdr.com
- **Health check**: Probes each source's /status endpoint, updates availability + metadata, and learns TLS
- **REST API**: `GET /api/sources` — list KiwiSDR sources (paginated)
- **Streams API**: `POST /api/streams` — create and auto-connect a stream
- **Streams API**: `PATCH /api/streams/{id}` — update tuning/source and reconnect
- **Stream WS**: `GET /api/streams/{id}/ws` — control + low-latency PCM audio frames
- **Frontend UI**: SPA served from `/` (stream list + player page)

## Setup

### Prerequisites

- Go 1.24+
- PostgreSQL 15+

### Database

```bash
createdb sdrradio
```

Or use Docker Compose:

```bash
docker compose up -d postgres
```

### Dev workflow (hot reload)

```bash
# one command:
# - starts postgres in docker
# - starts Vite dev server with HMR on :5173
# - starts Go backend with auto-reload (air) on :8080
make dev
```

In dev, the backend proxies non-API routes to Vite via `FRONTEND_DEV_URL`, so you can use a single app URL:

```bash
open http://localhost:8080
```

### Production run

```bash
# build frontend
cd frontend && bun run build && cd ..

# run backend (serves frontend/dist)
go run ./cmd/server
```

Migrations run automatically on startup. Server listens on `:8080` by default.

### Single-container deploy (Fly-friendly)

This repo includes a root `Dockerfile` that builds frontend + backend and runs a single container where:
- Go serves API + WebSocket + static frontend.
- `frontend/dist` is baked into the image.
- Migrations are included and run on startup.

Build locally:

```bash
docker build -t sdr-radio:local .
docker run --rm -p 8080:8080 \
  -e DATABASE_URL="postgres://postgres:postgres@host.docker.internal:5432/sdrradio?sslmode=disable" \
  sdr-radio:local
```

## Deploy to Fly.io

This project follows the same Fly pattern as `diplomacy`:
- committed `fly.toml`
- containerized deploy
- app-level health check at `/health`
- runtime `DATABASE_URL` injected by Fly Postgres attach

First-time setup:

```bash
# from repo root
fly launch --no-deploy
```

Create and attach a Fly Postgres database:

```bash
fly postgres create --name sdr-radio-db
fly postgres attach --app sdr-radio sdr-radio-db
```

Deploy:

```bash
fly deploy
```

### Seed sources on Fly

This image includes a `sync-sources` binary. Run it as a one-shot command on the app:

```bash
fly ssh console -C "/app/sync-sources"
```

That command runs migrations (safe if already applied), fetches from the default `.public` URL (or `KIWI_PUBLIC_URL` if set), and upserts sources.

You can verify seeding:

```bash
fly ssh console -C "wget -qO- http://127.0.0.1:8080/api/sources?limit=3&offset=0"
```

## API

### List sources

```bash
curl http://localhost:8080/api/sources
curl "http://localhost:8080/api/sources?limit=50&offset=0"
```

### How source discovery works

- `sync-sources` ingests only source identity (`host:port`) and stores a fallback name as `host:port`.
- Health checks are the source of truth for metadata (`name`, `users`, `snr`, `antenna`, `location`, etc).
- TLS is discovered by probing `/status` over `http` and `https`; the working scheme is persisted in `use_tls`.

### Create stream

```bash
curl -X POST http://localhost:8080/api/streams \
  -H "Content-Type: application/json" \
  -d '{
    "source_id":"<source-id>",
    "frequency_khz":7039.0,
    "mode":"am",
    "name":"40m monitor"
  }'
```

### Open the app

```bash
open "http://localhost:8080/"
```

### Retune / change source

```bash
curl -X PATCH http://localhost:8080/api/streams/<stream-id> \
  -H "Content-Type: application/json" \
  -d '{
    "frequency_khz": 10000.0,
    "mode": "am"
  }'
```

### Multiplayer stream control and audio (WebSocket)

Connect to `ws://localhost:8080/api/streams/<stream-id>/ws`:
- Binary messages with first byte `0x02` are little-endian PCM16 mono audio payloads.
- JSON messages are control/events.

Send control patches:

```json
{"type":"patch","patch":{"frequency_khz":9990,"mode":"usb","bandwidth_low_hz":300,"bandwidth_high_hz":2200}}
```

All connected clients receive:

```json
{"type":"stream_updated","stream":{...}}
```

## Environment

| Variable | Default |
|----------|---------|
| `DATABASE_URL` | `postgres://localhost:5432/sdrradio?sslmode=disable` |
| `HTTP_ADDR` | `:8080` |
| `KIWI_SOURCE_LIST_URL` | `https://rx.kiwisdr.com/` |
| `HEALTH_INTERVAL` | `1h` |
| `MIGRATIONS_PATH` | `migrations` |
| `FRONTEND_DEV_URL` | unset (set in dev to proxy to Vite, e.g. `http://localhost:5173`) |

## Project Structure

```
sdr-radio/
├── cmd/
│   ├── server/       # HTTP server, health check loop
│   └── sync-sources/ # One-shot source sync
├── internal/
│   ├── api/          # HTTP handlers (sources)
│   ├── config/       # Config loading
│   ├── db/           # DB pool, queries, migrations
│   ├── models/       # Domain structs
│   ├── sourcefetcher/# Scrapes KiwiSDR public list
│   └── sync/         # Source sync, health checker
├── migrations/
└── go.mod
```
