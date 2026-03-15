package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type mapSourcesResponse struct {
	IncludedSources any `json:"included_sources"`
	Counts          any `json:"counts"`
}

func (s *Server) listSources(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit <= 0 {
		limit = 20
	}

	sources, err := s.db.ListSources(r.Context(), limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	writeJSON(w, http.StatusOK, sources)
}

func (s *Server) getSource(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing source id", "BAD_REQUEST")
		return
	}
	source, err := s.db.GetSourceByID(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	if source == nil {
		writeError(w, http.StatusNotFound, "source not found", "NOT_FOUND")
		return
	}
	writeJSON(w, http.StatusOK, source)
}

func (s *Server) listMapSources(w http.ResponseWriter, r *http.Request) {
	sources, counts, err := s.db.ListMapSources(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"included_sources": sources,
		"counts":           counts,
	})
}
