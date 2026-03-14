.PHONY: dev dev-backend server build frontend-lint

# Full local dev: Postgres (docker), backend reload (air), frontend HMR (vite via bun)
dev:
	./scripts/dev.sh

# Backend-only live reload
dev-backend:
	air

# Run server once (no reload)
server:
	go run ./cmd/server

# Build server binary
build:
	go build -o bin/server ./cmd/server

# Lint frontend with Biome via Bun
frontend-lint:
	cd frontend && bun run lint
