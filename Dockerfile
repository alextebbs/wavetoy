FROM oven/bun:1.3.10-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile

COPY frontend/ ./
RUN bun run build

FROM golang:1.25-alpine AS backend-builder
WORKDIR /app

RUN apk add --no-cache ca-certificates git

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
COPY migrations ./migrations
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/server ./cmd/server
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/sync-sources ./cmd/sync-sources
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/create-tenant ./cmd/create-tenant

FROM alpine:3.20
WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata

COPY --from=backend-builder /out/server ./server
COPY --from=backend-builder /out/sync-sources ./sync-sources
COPY --from=backend-builder /out/create-tenant ./create-tenant
COPY --from=backend-builder /app/migrations ./migrations
COPY --from=backend-builder /app/frontend/dist ./frontend/dist

EXPOSE 8080

CMD ["./server"]
