package api

import (
	"encoding/json"
	"net/http"

	"github.com/sammy/sdr-radio/internal/auth"
)

func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Passphrase string `json:"passphrase"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}
	if req.Passphrase == "" {
		writeError(w, http.StatusBadRequest, "passphrase is required", "BAD_REQUEST")
		return
	}

	tenants, err := s.db.ListTenants(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error", "INTERNAL_ERROR")
		return
	}

	for _, t := range tenants {
		if auth.CheckPassphrase(req.Passphrase, t.MagicPhraseHash) {
			token, err := auth.SignToken(t.ID, s.jwtSecret, s.jwtExpiry)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal error", "INTERNAL_ERROR")
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"token": token})
			return
		}
	}

	writeError(w, http.StatusUnauthorized, "invalid passphrase", "UNAUTHORIZED")
}
