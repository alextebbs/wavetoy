package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/sammy/sdr-radio/internal/auth"
)

type ctxKey string

const tenantIDKey ctxKey = "tenant_id"

func TenantID(ctx context.Context) string {
	if v, ok := ctx.Value(tenantIDKey).(string); ok {
		return v
	}
	return ""
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var raw string
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			raw = strings.TrimPrefix(h, "Bearer ")
		}
		if raw == "" {
			raw = r.URL.Query().Get("token")
		}
		if raw == "" {
			writeError(w, http.StatusUnauthorized, "missing token", "UNAUTHORIZED")
			return
		}

		claims, err := auth.VerifyToken(raw, s.jwtSecret)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid token", "UNAUTHORIZED")
			return
		}

		ctx := context.WithValue(r.Context(), tenantIDKey, claims.TenantID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
