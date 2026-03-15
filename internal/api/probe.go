package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/kiwi"
)

type probeRequest struct {
	StreamID string `json:"stream_id"`
}

func (s *Server) probeSource(w http.ResponseWriter, r *http.Request) {
	sourceID := chi.URLParam(r, "id")
	if sourceID == "" {
		writeError(w, http.StatusBadRequest, "source id is required", "VALIDATION")
		return
	}

	var req probeRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}

	source, err := s.db.GetSourceByID(r.Context(), sourceID)
	if err != nil {
		writeError(w, http.StatusNotFound, "source not found", "NOT_FOUND")
		return
	}

	freqKHz := 10000.0
	mode := "am"

	if req.StreamID != "" {
		stream, err := s.db.GetStreamByID(r.Context(), req.StreamID)
		if err == nil {
			freqKHz = stream.FrequencyKHz
			mode = stream.Mode
		}
	}

	result := kiwi.QuickProbe(r.Context(), source.ID, source.Host, source.Port, source.UseTLS, freqKHz, mode)
	writeJSON(w, http.StatusOK, result)
}
