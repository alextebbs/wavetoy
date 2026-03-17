package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/models"
)

func (s *Server) listSourceNotes(w http.ResponseWriter, r *http.Request) {
	tenantID := TenantID(r.Context())
	notes, err := s.db.ListSourceNotes(r.Context(), tenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list notes", "INTERNAL")
		return
	}
	if notes == nil {
		notes = []models.SourceNote{}
	}
	writeJSON(w, http.StatusOK, notes)
}

func (s *Server) getSourceNote(w http.ResponseWriter, r *http.Request) {
	tenantID := TenantID(r.Context())
	sourceID := chi.URLParam(r, "id")
	if sourceID == "" {
		writeError(w, http.StatusBadRequest, "missing source id", "BAD_REQUEST")
		return
	}
	note, err := s.db.GetSourceNote(r.Context(), tenantID, sourceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get note", "INTERNAL")
		return
	}
	if note == nil {
		writeJSON(w, http.StatusOK, map[string]string{"content": ""})
		return
	}
	writeJSON(w, http.StatusOK, note)
}

func (s *Server) putSourceNote(w http.ResponseWriter, r *http.Request) {
	tenantID := TenantID(r.Context())
	sourceID := chi.URLParam(r, "id")
	if sourceID == "" {
		writeError(w, http.StatusBadRequest, "missing source id", "BAD_REQUEST")
		return
	}

	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body", "BAD_REQUEST")
		return
	}

	content := strings.TrimSpace(body.Content)
	if content == "" {
		if err := s.db.DeleteSourceNote(r.Context(), tenantID, sourceID); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to delete note", "INTERNAL")
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	note, err := s.db.UpsertSourceNote(r.Context(), tenantID, sourceID, content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save note", "INTERNAL")
		return
	}
	writeJSON(w, http.StatusOK, note)
}

func (s *Server) deleteSourceNote(w http.ResponseWriter, r *http.Request) {
	tenantID := TenantID(r.Context())
	sourceID := chi.URLParam(r, "id")
	if sourceID == "" {
		writeError(w, http.StatusBadRequest, "missing source id", "BAD_REQUEST")
		return
	}
	if err := s.db.DeleteSourceNote(r.Context(), tenantID, sourceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete note", "INTERNAL")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
