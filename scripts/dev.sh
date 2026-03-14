#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN_DIR="$HOME/.bun/bin"

if [[ -x "$BUN_BIN_DIR/bun" ]]; then
  export PATH="$BUN_BIN_DIR:$PATH"
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd bun

if ! command -v air >/dev/null 2>&1; then
  if command -v go >/dev/null 2>&1; then
    echo "==> installing air (go install github.com/air-verse/air@latest)"
    go install github.com/air-verse/air@latest
    export PATH="$HOME/go/bin:$PATH"
  fi
fi
require_cmd air

cleanup() {
  if [[ -n "${VITE_PID:-}" ]]; then
    kill "$VITE_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${AIR_PID:-}" ]]; then
    kill "$AIR_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> starting postgres (docker compose)"
docker compose -f "$ROOT_DIR/docker-compose.yml" up -d postgres

# Avoid startup failure if stale local processes are still bound to dev ports.
if command -v lsof >/dev/null 2>&1; then
  if lsof -ti:5173 >/dev/null 2>&1; then
    echo "==> freeing :5173 from stale process"
    lsof -ti:5173 | xargs kill -9 2>/dev/null || true
  fi
  if lsof -ti:8080 >/dev/null 2>&1; then
    echo "==> freeing :8080 from stale process"
    lsof -ti:8080 | xargs kill -9 2>/dev/null || true
  fi
fi

echo "==> starting vite dev server (http://localhost:5173)"
(
  cd "$ROOT_DIR/frontend"
  bun run dev
) &
VITE_PID=$!

echo "==> starting backend with air + frontend proxy (http://localhost:8080)"
(
  cd "$ROOT_DIR"
  FRONTEND_DEV_URL="http://localhost:5173" air
) &
AIR_PID=$!

wait "$VITE_PID" "$AIR_PID"
