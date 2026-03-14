#!/bin/bash
# End-to-end test: start services, sync sources, health check, list sources.
# Prerequisites: Docker (for Postgres), Go
set -e
cd "$(dirname "$0")/.."

echo "==> Starting Postgres..."
docker compose up -d postgres 2>/dev/null || docker-compose up -d postgres 2>/dev/null
sleep 3

echo "==> Syncing Kiwi sources..."
go run ./cmd/sync-sources/

echo "==> Starting server on :8081..."
HTTP_ADDR=:8081 go run ./cmd/server/ &
SERVER_PID=$!
sleep 5

cleanup() {
  kill $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Fetching sources..."
SOURCES=$(curl -s http://localhost:8081/sources)
COUNT=$(echo "$SOURCES" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d))")
if [ "$COUNT" -lt 1 ]; then
  echo "No sources found"
  exit 1
fi
echo "OK: $COUNT sources listed"
echo ""
echo "Press Ctrl+C to stop server..."

wait $SERVER_PID
