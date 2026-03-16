FROM --platform=$BUILDPLATFORM oven/bun:1.3.10-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile

COPY frontend/ ./
RUN bun run build

# Build whisper.cpp static libraries for the target platform
FROM alpine:3.20 AS whisper-builder
RUN apk add --no-cache build-base cmake git
WORKDIR /build
RUN git clone --depth 1 --branch v1.8.3 https://github.com/ggerganov/whisper.cpp.git
WORKDIR /build/whisper.cpp
RUN cmake -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_EXAMPLES=OFF \
      -DWHISPER_BUILD_SERVER=OFF \
      -DGGML_METAL=OFF \
      -DGGML_CUDA=OFF \
      -DGGML_BLAS=OFF \
      -DGGML_OPENMP=OFF \
    && cmake --build build --config Release -j$(nproc)

# Download whisper model
FROM --platform=$BUILDPLATFORM alpine:3.20 AS model-downloader
RUN apk add --no-cache curl
RUN mkdir -p /models && \
    curl -L -o /models/ggml-small.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin

FROM golang:1.25-alpine AS backend-builder
WORKDIR /app

RUN apk add --no-cache ca-certificates git build-base

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
COPY migrations ./migrations
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Copy whisper static libs into the expected path
COPY --from=whisper-builder /build/whisper.cpp/build/src/libwhisper.a /app/internal/whisper/lib/linux_amd64/
COPY --from=whisper-builder /build/whisper.cpp/build/ggml/src/libggml.a /app/internal/whisper/lib/linux_amd64/
COPY --from=whisper-builder /build/whisper.cpp/build/ggml/src/libggml-base.a /app/internal/whisper/lib/linux_amd64/
COPY --from=whisper-builder /build/whisper.cpp/build/ggml/src/libggml-cpu.a /app/internal/whisper/lib/linux_amd64/

RUN CGO_ENABLED=1 go build -tags whisper -o /out/server ./cmd/server
RUN CGO_ENABLED=0 go build -o /out/sync-sources ./cmd/sync-sources
RUN CGO_ENABLED=0 go build -o /out/create-tenant ./cmd/create-tenant

FROM alpine:3.20
WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata libstdc++ libgcc

COPY --from=backend-builder /out/server ./server
COPY --from=backend-builder /out/sync-sources ./sync-sources
COPY --from=backend-builder /out/create-tenant ./create-tenant
COPY --from=backend-builder /app/migrations ./migrations
COPY --from=backend-builder /app/frontend/dist ./frontend/dist
COPY --from=model-downloader /models ./data/whisper-models

EXPOSE 8080

CMD ["./server"]
