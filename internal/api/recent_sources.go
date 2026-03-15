package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/db"
)

func (s *Server) listRecentSources(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	if streamID == "" {
		writeError(w, http.StatusBadRequest, "missing stream id", "BAD_REQUEST")
		return
	}
	results, err := s.db.ListRecentSources(r.Context(), streamID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list recent sources", "INTERNAL")
		return
	}
	if results == nil {
		results = []db.RecentSource{}
	}
	writeJSON(w, http.StatusOK, results)
}
