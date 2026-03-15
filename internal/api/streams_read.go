package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

func (s *Server) listStreams(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit <= 0 {
		limit = 50
	}

	streams, err := s.db.ListStreamsByTenant(r.Context(), TenantID(r.Context()), limit, offset)
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
	if stream == nil || stream.TenantID != TenantID(r.Context()) {
		writeError(w, http.StatusNotFound, "stream not found", "NOT_FOUND")
		return
	}
	writeJSON(w, http.StatusOK, stream)
}
