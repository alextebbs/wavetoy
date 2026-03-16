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

# Build server binary with whisper support
build-whisper:
	go build -tags whisper -o bin/server ./cmd/server

# Download whisper model(s)
whisper-model:
	mkdir -p data/whisper-models
	@test -f data/whisper-models/ggml-base.bin || \
		curl -L -o data/whisper-models/ggml-base.bin \
		https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

# Lint frontend with Biome via Bun
frontend-lint:
	cd frontend && bun run lint
