package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/models"
)

func (s *Server) listFavorites(w http.ResponseWriter, r *http.Request) {
	tenantID := TenantID(r.Context())
	ids, err := s.db.ListFavoriteSourceIDs(r.Context(), tenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list favorites", "INTERNAL")
		return
	}
	if ids == nil {
		ids = []string{}
	}
	writeJSON(w, http.StatusOK, ids)
}

func (s *Server) listFavoriteSources(w http.ResponseWriter, r *http.Request) {
	tenantID := TenantID(r.Context())
	sources, err := s.db.ListFavoriteSources(r.Context(), tenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list favorite sources", "INTERNAL")
		return
	}
	if sources == nil {
		sources = []models.Source{}
	}
	writeJSON(w, http.StatusOK, sources)
}

func (s *Server) addFavorite(w http.ResponseWriter, r *http.Request) {
	tenantID := TenantID(r.Context())
	sourceID := chi.URLParam(r, "sourceId")
	if sourceID == "" {
		writeError(w, http.StatusBadRequest, "missing source id", "BAD_REQUEST")
		return
	}
	if err := s.db.AddFavoriteSource(r.Context(), tenantID, sourceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to add favorite", "INTERNAL")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) removeFavorite(w http.ResponseWriter, r *http.Request) {
	tenantID := TenantID(r.Context())
	sourceID := chi.URLParam(r, "sourceId")
	if sourceID == "" {
		writeError(w, http.StatusBadRequest, "missing source id", "BAD_REQUEST")
		return
	}
	if err := s.db.RemoveFavoriteSource(r.Context(), tenantID, sourceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove favorite", "INTERNAL")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
