# AUTH.md — Tenant Passphrase Authentication

## Overview

Simple passphrase-based auth at the tenant level. A tenant is identified by a
passphrase (magic phrase) — you type it in, get a JWT back, and that JWT is
attached to every subsequent request. No usernames, no email, no OAuth. Just a
phrase and a token.

Tokens are long-lived (default 1 year). There is no refresh flow — when it
expires you paste the phrase again.

---

## Current State

| What | Status |
|------|--------|
| `tenants` table | Exists — has `id`, `name`, `magic_phrase_hash`, `created_at`. No `max_streams` column yet. |
| `magic_phrase_hash` column | Stores literal `"phase1-no-auth"` — not a real hash |
| `MaxStreamsPerTenant` | Hardcoded to `5` in `internal/db/streams.go` |
| Auth middleware | None |
| Frontend token handling | None |
| WebSocket auth | None |
| Tenant creation | Hardcoded seed only — no CLI or API |

Everything uses the hardcoded `db.DefaultTenantID` (`"tenant_default"`).

---

## Design

### Auth Flow

```
  ┌──────────┐     POST /api/auth        ┌──────────┐
  │ Frontend │  ─────────────────────────▶│ Backend  │
  │          │  { "passphrase": "..." }   │          │
  │          │                            │          │
  │          │  ◀─────────────────────────│          │
  │          │  { "token": "eyJ..." }     │          │
  └──────────┘                            └──────────┘
       │                                       │
       │  All subsequent requests:             │
       │  Authorization: Bearer eyJ...         │
       │  (or ?token=eyJ... for WebSocket)     │
       ▼                                       ▼
```

1. User enters passphrase in frontend
2. Frontend `POST /api/auth` with `{ "passphrase": "..." }`
3. Backend iterates tenants, bcrypt-compares against each `magic_phrase_hash`
4. On match → sign JWT with `{ tenant_id, iat, exp }`, return it
5. On no match → `401 Unauthorized`
6. Frontend stores token in `localStorage`, attaches to all requests

### JWT Claims

```json
{
  "tid": "tenant_default",
  "iat": 1710000000,
  "exp": 1741536000
}
```

- `tid` — tenant ID (the only claim that matters)
- Default expiry: **1 year** from issuance
- Signing: **HMAC-SHA256** with a server-side secret

### Why bcrypt the passphrase?

Even though this is low-stakes auth, storing passphrases in plain text is a bad
habit. bcrypt is cheap to implement and means a DB leak doesn't hand out
passphrases.

---

## Implementation Plan

### 1. Config Changes (`internal/config/config.go`)

Add two env vars:

| Var | Default | Description |
|-----|---------|-------------|
| `JWT_SECRET` | (required, no default) | HMAC-SHA256 signing key. Server refuses to start if empty. |
| `JWT_EXPIRY` | `8760h` (1 year) | Token lifetime as Go duration. |

```go
type Config struct {
    // ... existing fields ...
    JWTSecret string
    JWTExpiry time.Duration
}
```

On startup, if `JWT_SECRET` is empty, log a fatal error and exit. No silent
fallbacks.

### 2. New Go Package: `internal/auth`

Small, self-contained package. Two files.

#### `internal/auth/hash.go`

```go
package auth

import "golang.org/x/crypto/bcrypt"

func HashPassphrase(passphrase string) (string, error) {
    bytes, err := bcrypt.GenerateFromPassword([]byte(passphrase), bcrypt.DefaultCost)
    return string(bytes), err
}

func CheckPassphrase(passphrase, hash string) bool {
    return bcrypt.CompareHashAndPassword([]byte(hash), []byte(passphrase)) == nil
}
```

#### `internal/auth/jwt.go`

```go
package auth

import (
    "time"
    "github.com/golang-jwt/jwt/v5"
)

type Claims struct {
    TenantID string `json:"tid"`
    jwt.RegisteredClaims
}

func SignToken(tenantID, secret string, expiry time.Duration) (string, error) {
    now := time.Now()
    claims := Claims{
        TenantID: tenantID,
        RegisteredClaims: jwt.RegisteredClaims{
            IssuedAt:  jwt.NewNumericDate(now),
            ExpiresAt: jwt.NewNumericDate(now.Add(expiry)),
        },
    }
    return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
}

func VerifyToken(tokenStr, secret string) (*Claims, error) {
    token, err := jwt.ParseWithClaims(tokenStr, &Claims{},
        func(t *jwt.Token) (any, error) { return []byte(secret), nil },
        jwt.WithValidMethods([]string{"HS256"}),
    )
    if err != nil {
        return nil, err
    }
    return token.Claims.(*Claims), nil
}
```

### 3. Database Changes

#### Migration: `012_tenant_max_streams.up.sql`

Add `max_streams` column to the tenants table:

```sql
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_streams INT NOT NULL DEFAULT 5;
```

The current hardcoded `MaxStreamsPerTenant = 5` in `internal/db/streams.go` gets
replaced with a per-tenant lookup.

#### Tenant Model (`internal/models/models.go`)

There's currently no `Tenant` struct. Add one:

```go
type Tenant struct {
    ID               string    `json:"id"`
    Name             string    `json:"name"`
    MagicPhraseHash  string    `json:"-"`
    MaxStreams        int       `json:"max_streams"`
    CreatedAt        time.Time `json:"created_at"`
}
```

Note: `MagicPhraseHash` is `json:"-"` — never serialized to the client.

#### Seed Update

The current seed in `internal/db/seed.go` inserts `"phase1-no-auth"` as a
literal string. This changes to:

```go
func (db *DB) Seed(ctx context.Context, passphraseHash string) error {
    _, err := db.Pool.Exec(ctx, `
        INSERT INTO tenants (id, name, magic_phrase_hash, max_streams)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET magic_phrase_hash = $3
    `, DefaultTenantID, "Default Tenant", passphraseHash, 5)
    return err
}
```

On startup in `main.go`:

```go
hash, err := auth.HashPassphrase(cfg.DefaultPassphrase)
// ...
database.Seed(ctx, hash)
```

New env var for bootstrapping:

| Var | Default | Description |
|-----|---------|-------------|
| `DEFAULT_PASSPHRASE` | (required on first run) | Passphrase for the default tenant. |

If the tenant already exists and `DEFAULT_PASSPHRASE` is set, the hash is
updated (allows rotation). If unset and tenant exists, seed is skipped.

#### Stream Limit Change (`internal/db/streams.go`)

Replace the hardcoded constant with a per-tenant lookup:

```go
// Before
const MaxStreamsPerTenant = 5

// ...
if count >= MaxStreamsPerTenant {
    return nil, ErrTenantAtCapacity
}

// After (constant removed, query tenant's max_streams instead)
var maxStreams int
err := db.Pool.QueryRow(ctx,
    `SELECT max_streams FROM tenants WHERE id = $1`, p.TenantID,
).Scan(&maxStreams)

// ...
if count >= maxStreams {
    return nil, ErrTenantAtCapacity
}
```

#### DB Queries (new)

```go
func (db *DB) ListTenants(ctx context.Context) ([]Tenant, error) { ... }
func (db *DB) GetTenantByID(ctx context.Context, id string) (*Tenant, error) { ... }
func (db *DB) CreateTenant(ctx context.Context, p CreateTenantParams) (*Tenant, error) { ... }
```

Used by the auth endpoint (iterate + bcrypt compare) and the CLI tool.

Only a handful of tenants will ever exist (this is not a SaaS with thousands of
users), so iterating is fine.

### 4. Auth Endpoint: `POST /api/auth`

New handler in `internal/api/auth.go`:

```go
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) {
    var req struct {
        Passphrase string `json:"passphrase"`
    }
    // decode, validate non-empty ...

    tenants, _ := s.db.ListTenants(r.Context())
    for _, t := range tenants {
        if auth.CheckPassphrase(req.Passphrase, t.MagicPhraseHash) {
            token, _ := auth.SignToken(t.ID, s.jwtSecret, s.jwtExpiry)
            writeJSON(w, http.StatusOK, map[string]string{"token": token})
            return
        }
    }

    writeError(w, http.StatusUnauthorized, "invalid passphrase", "UNAUTHORIZED")
}
```

Registered as:

```go
api.Post("/auth", s.authenticate)
```

This endpoint is **not** behind the auth middleware (obviously).

### 5. Auth Middleware (`internal/api/middleware.go`)

Chi middleware that:

1. Reads `Authorization: Bearer <token>` header
2. Calls `auth.VerifyToken`
3. Stores `tenant_id` in request context
4. Rejects with `401` on failure

```go
func (s *Server) requireAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        header := r.Header.Get("Authorization")
        if !strings.HasPrefix(header, "Bearer ") {
            writeError(w, http.StatusUnauthorized, "missing token", "UNAUTHORIZED")
            return
        }
        claims, err := auth.VerifyToken(strings.TrimPrefix(header, "Bearer "), s.jwtSecret)
        if err != nil {
            writeError(w, http.StatusUnauthorized, "invalid token", "UNAUTHORIZED")
            return
        }
        ctx := context.WithValue(r.Context(), tenantIDKey, claims.TenantID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

type ctxKey string
const tenantIDKey ctxKey = "tenant_id"

func TenantID(ctx context.Context) string {
    return ctx.Value(tenantIDKey).(string)
}
```

### 6. Router Changes

```go
r.Route("/api", func(api chi.Router) {
    // Public
    api.Post("/auth", s.authenticate)

    // Protected — everything else
    api.Group(func(protected chi.Router) {
        protected.Use(s.requireAuth)

        protected.Get("/sources", s.listSources)
        protected.Get("/sources/map", s.listMapSources)
        protected.Get("/streams", s.listStreams)
        // ... all existing routes ...
        protected.Get("/ws", s.globalWS)
    })
})
```

### 7. WebSocket Auth

WebSockets can't send custom headers during the upgrade handshake from the
browser. Two options:

- **Query parameter**: `ws://host/api/ws?token=eyJ...`
- **First message**: send token as the first WS message before `hello`

**Decision: query parameter.** It's simpler, the token is validated during the
HTTP upgrade (before the connection is established), and the middleware handles
it uniformly.

The `requireAuth` middleware is modified to also check `?token=` query param as
a fallback when no `Authorization` header is present:

```go
token := strings.TrimPrefix(header, "Bearer ")
if token == "" {
    token = r.URL.Query().Get("token")
}
if token == "" {
    writeError(w, http.StatusUnauthorized, "missing token", "UNAUTHORIZED")
    return
}
```

### 8. Tenant Creation CLI (`cmd/create-tenant/main.go`)

A small CLI binary for creating new tenants. Not an API endpoint — tenants are
an operator concern, not a user-facing feature.

```
go run ./cmd/create-tenant \
  --name "My Tenant" \
  --passphrase "some-secret-phrase" \
  --max-streams 10
```

#### What It Does

1. Connects to the database (reads `DATABASE_URL` from env / `.env`)
2. Generates a tenant ID (`ksuid`)
3. Bcrypt-hashes the passphrase
4. Inserts into `tenants` table
5. Prints the tenant ID to stdout

```go
package main

import (
    "context"
    "flag"
    "fmt"
    "log"
    "os"

    "github.com/joho/godotenv"
    "github.com/sammy/sdr-radio/internal/auth"
    "github.com/sammy/sdr-radio/internal/db"
    "github.com/segmentio/ksuid"
)

func main() {
    name := flag.String("name", "", "tenant display name (required)")
    passphrase := flag.String("passphrase", "", "tenant passphrase (required)")
    maxStreams := flag.Int("max-streams", 5, "max concurrent streams for this tenant")
    flag.Parse()

    if *name == "" || *passphrase == "" {
        flag.Usage()
        os.Exit(1)
    }

    _ = godotenv.Load()
    database, err := db.New(os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatal(err)
    }

    hash, err := auth.HashPassphrase(*passphrase)
    if err != nil {
        log.Fatal(err)
    }

    id := ksuid.New().String()
    _, err = database.Pool.Exec(context.Background(), `
        INSERT INTO tenants (id, name, magic_phrase_hash, max_streams)
        VALUES ($1, $2, $3, $4)
    `, id, *name, hash, *maxStreams)
    if err != nil {
        log.Fatal(err)
    }

    fmt.Printf("created tenant %s (%s) with max_streams=%d\n", id, *name, *maxStreams)
}
```

#### Companion Commands

For updating an existing tenant's passphrase or stream limit, keep it simple —
just use `psql` or add `--update-id` flag later. No need to over-engineer this
now.

#### Listing Tenants

Add a `--list` flag to the same binary:

```
go run ./cmd/create-tenant --list
```

Outputs all tenants (ID, name, max_streams, created_at). Doesn't show hashes.

### 9. Handler Migration: `db.DefaultTenantID` → Context

Every handler currently hardcodes `db.DefaultTenantID`. These all change to
read from context:

```go
// Before
streams, err := s.db.ListStreamsByTenant(r.Context(), db.DefaultTenantID, limit, offset)

// After
tenantID := TenantID(r.Context())
streams, err := s.db.ListStreamsByTenant(r.Context(), tenantID, limit, offset)
```

Affected handlers (all in `internal/api/`):

| File | Occurrences |
|------|-------------|
| `streams.go` | `createStream`, `patchStream`, `deleteStream` |
| `streams_read.go` | `listStreams`, `getStream` |
| `stream_ws.go` | `streamWS` |
| `global_ws.go` | patch handler inside WS message loop |

The `main.go` startup code that lists streams for the fallback manager keeps
using `db.DefaultTenantID` directly (it's server-side, not a user request).

### 9. Frontend Changes

#### Token Storage (`frontend/src/lib/auth.ts`)

```typescript
const TOKEN_KEY = "sdr_auth_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}
```

#### API Module Changes (`frontend/src/lib/api.ts`)

Add auth header to all fetch calls:

```typescript
function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}
```

Same pattern for `apiPost` and `apiDelete`.

New function:

```typescript
export async function authenticate(passphrase: string): Promise<string> {
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  if (!res.ok) throw new Error("Invalid passphrase");
  const { token } = await res.json();
  setToken(token);
  return token;
}
```

#### WebSocket Changes

Append token to WebSocket URL:

```typescript
// Before
const ws = new WebSocket(`${wsProtocol}//${host}/api/ws`);

// After
const token = getToken();
const ws = new WebSocket(`${wsProtocol}//${host}/api/ws?token=${token}`);
```

Both `streams-page.tsx` and `stream-player-page.tsx` need this.

#### Login Gate

New component: `frontend/src/components/login-gate.tsx`

Simple full-screen passphrase input. No username field. Just:

- A text input (type `password`) with placeholder "Enter passphrase"
- A submit button
- Error state for wrong passphrase

This wraps the entire app. If no token in localStorage → show gate. If token
exists → render children. On 401 from any API call → clear token, gate
reappears.

```tsx
function LoginGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(isAuthenticated());

  if (!authed) {
    return <PassphraseForm onSuccess={() => setAuthed(true)} />;
  }

  return <>{children}</>;
}
```

Wrap in `main.tsx` or the root layout:

```tsx
<LoginGate>
  <RouterProvider router={router} />
</LoginGate>
```

---

## Route Protection Summary

| Route | Auth Required |
|-------|--------------|
| `GET /health` | No |
| `POST /api/auth` | No |
| `GET /api/sources` | Yes |
| `GET /api/sources/map` | Yes |
| `GET /api/streams` | Yes |
| `GET /api/streams/{id}` | Yes |
| `POST /api/streams` | Yes |
| `PATCH /api/streams/{id}` | Yes |
| `DELETE /api/streams/{id}` | Yes |
| `GET /api/streams/{id}/ws` | Yes (via query param) |
| `GET /api/streams/{id}/logs` | Yes |
| `POST /api/streams/{id}/debug` | Yes |
| `GET /api/streams/{id}/fallbacks` | Yes |
| `GET /api/streams/{id}/fallbacks/ref-audio` | Yes |
| `GET /api/streams/{id}/fallbacks/{rank}/probe-audio` | Yes |
| `POST /api/streams/{id}/reprobe` | Yes |
| `POST /api/streams/{id}/capture` | Yes |
| `GET /api/ws` | Yes (via query param) |
| `GET /*` (frontend) | No (SPA serves static files) |

---

## Dependencies

### Go

| Package | Purpose |
|---------|---------|
| `github.com/golang-jwt/jwt/v5` | JWT signing and verification |
| `golang.org/x/crypto/bcrypt` | Passphrase hashing |

### Frontend

No new dependencies. Uses native `fetch`, `localStorage`, and existing React
patterns.

---

## Env Vars (New)

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `JWT_SECRET` | Yes | — | HMAC-SHA256 signing key. Min 32 chars recommended. |
| `JWT_EXPIRY` | No | `8760h` | Token lifetime (Go duration format). |
| `DEFAULT_PASSPHRASE` | First run | — | Passphrase for the default tenant. |

---

## Implementation Order

1. **`internal/auth` package** — `hash.go` + `jwt.go` with tests
2. **Config** — add `JWTSecret`, `JWTExpiry`, `DefaultPassphrase`
3. **Migration** — `012_tenant_max_streams.up.sql` (add `max_streams` column)
4. **Tenant model + DB queries** — `Tenant` struct, `ListTenants()`, `CreateTenant()`, `GetTenantByID()`
5. **Seed update** — bcrypt the passphrase, update `Seed()` signature
6. **Stream limit** — replace hardcoded `MaxStreamsPerTenant` with per-tenant `max_streams`
7. **Auth endpoint** — `POST /api/auth`
8. **Middleware** — `requireAuth` with header + query param support
9. **Router wiring** — group protected routes behind middleware
10. **Handler migration** — replace `db.DefaultTenantID` with context value
11. **Tenant creation CLI** — `cmd/create-tenant/main.go`
12. **Frontend `auth.ts`** — token storage helpers
13. **Frontend API changes** — auth headers on all requests, 401 handling
14. **Frontend WebSocket** — append token to WS URL
15. **Login gate component** — passphrase input UI
16. **Wire login gate** — wrap app root

---

## What This Doesn't Cover (And Doesn't Need To)

- **User accounts** — not needed. Tenants are the only identity.
- **Token refresh** — tokens last a year. Re-enter passphrase when expired.
- **Password reset** — operator sets `DEFAULT_PASSPHRASE` and restarts.
- **Rate limiting on auth endpoint** — nice-to-have, not critical for a
  low-traffic internal tool. Can add later with a simple in-memory counter.
- **Multi-tenant creation UI** — tenants are created via CLI (`cmd/create-tenant`).
  No self-service signup.
- **HTTPS** — assumed to be handled by reverse proxy (nginx, Caddy, etc.), not
  the Go server itself.
