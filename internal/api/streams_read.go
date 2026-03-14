package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/db"
)

func (s *Server) listStreams(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit <= 0 {
		limit = 50
	}

	streams, err := s.db.ListStreamsByTenant(r.Context(), db.DefaultTenantID, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	writeJSON(w, http.StatusOK, streams)
}

func (s *Server) getStream(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	stream, err := s.db.GetStreamByID(r.Context(), streamID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	if stream == nil || stream.TenantID != db.DefaultTenantID {
		writeError(w, http.StatusNotFound, "stream not found", "NOT_FOUND")
		return
	}
	writeJSON(w, http.StatusOK, stream)
}
