package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/models"
)

type createStreamRequest struct {
	SourceID        string   `json:"source_id"`
	FrequencyKHz    float64  `json:"frequency_khz"`
	BandwidthLowHz  int      `json:"bandwidth_low_hz"`
	BandwidthHighHz int      `json:"bandwidth_high_hz"`
	Mode            string   `json:"mode"`
	Name            string   `json:"name"`
	AGCOn           *bool    `json:"agc_on"`
	AGCGainDB       *float64 `json:"agc_gain_db"`
	BufferMinutes   int      `json:"buffer_minutes"`
}

type patchStreamRequest struct {
	SourceID        *string  `json:"source_id"`
	FrequencyKHz    *float64 `json:"frequency_khz"`
	BandwidthLowHz  *int     `json:"bandwidth_low_hz"`
	BandwidthHighHz *int     `json:"bandwidth_high_hz"`
	Mode            *string  `json:"mode"`
	Name            *string  `json:"name"`
	AGCOn           *bool    `json:"agc_on"`
	AGCGainDB       *float64 `json:"agc_gain_db"`
	BufferMinutes   *int     `json:"buffer_minutes"`
}

type patchStreamError struct {
	Status int
	Error  string
	Code   string
}

func (s *Server) createStream(w http.ResponseWriter, r *http.Request) {
	var req createStreamRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body", "VALIDATION")
		return
	}

	if strings.TrimSpace(req.SourceID) == "" {
		writeError(w, http.StatusBadRequest, "source_id is required", "VALIDATION")
		return
	}
	if req.FrequencyKHz <= 0 {
		writeError(w, http.StatusBadRequest, "frequency_khz must be > 0", "VALIDATION")
		return
	}
	if req.BandwidthLowHz == 0 {
		req.BandwidthLowHz = -5000
	}
	if req.BandwidthHighHz == 0 {
		req.BandwidthHighHz = 5000
	}
	if req.Mode == "" {
		req.Mode = "am"
	}
	req.Mode = strings.ToLower(req.Mode)
	if req.Name == "" {
		req.Name = "SDR Stream"
	}
	if req.BufferMinutes <= 0 {
		req.BufferMinutes = 15
	}

	agcOn := true
	if req.AGCOn != nil {
		agcOn = *req.AGCOn
	}

	stream, err := s.db.CreateStream(r.Context(), db.CreateStreamParams{
		TenantID:        db.DefaultTenantID,
		SourceID:        req.SourceID,
		FrequencyKHz:    req.FrequencyKHz,
		BandwidthLowHz:  req.BandwidthLowHz,
		BandwidthHighHz: req.BandwidthHighHz,
		Mode:            req.Mode,
		Name:            req.Name,
		AGCOn:           agcOn,
		AGCGainDB:       req.AGCGainDB,
		BufferMinutes:   req.BufferMinutes,
	})
	if err != nil {
		switch {
		case errors.Is(err, db.ErrSourceNotFound):
			writeError(w, http.StatusNotFound, "source not found", "NOT_FOUND")
		case errors.Is(err, db.ErrSourceUnavailable):
			writeError(w, http.StatusConflict, "source is unavailable", "SOURCE_UNAVAILABLE")
		case errors.Is(err, db.ErrSourceAtCapacity):
			writeError(w, http.StatusConflict, "source is at max listeners", "SOURCE_AT_CAPACITY")
		default:
			writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		}
		return
	}

	if err := s.streamManager.EnsureRunning(r.Context(), *stream); err != nil {
		writeError(w, http.StatusBadGateway, "failed to connect to KiwiSDR source", "SOURCE_CONNECT_FAILED")
		return
	}

	writeJSON(w, http.StatusCreated, stream)
	s.BroadcastStreamCreated(stream)
}

func (s *Server) patchStream(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return
	}

	existing, err := s.db.GetStreamByID(r.Context(), streamID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	if existing == nil || existing.TenantID != db.DefaultTenantID {
		writeError(w, http.StatusNotFound, "stream not found", "NOT_FOUND")
		return
	}

	var req patchStreamRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body", "VALIDATION")
		return
	}

	stream, apiErr := s.applyPatchStream(r.Context(), existing, req, 0)
	if apiErr != nil {
		writeError(w, apiErr.Status, apiErr.Error, apiErr.Code)
		return
	}
	writeJSON(w, http.StatusOK, stream)
	s.broadcastStreamEvent(stream.ID, map[string]any{
		"type":        "stream_updated",
		"stream":      stream,
		"sample_rate": s.streamManager.SampleRate(stream.ID),
	})
}

func (s *Server) deleteStream(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return
	}

	existing, err := s.db.GetStreamByID(r.Context(), streamID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	if existing == nil || existing.TenantID != db.DefaultTenantID {
		writeError(w, http.StatusNotFound, "stream not found", "NOT_FOUND")
		return
	}

	if err := s.streamManager.Remove(streamID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to stop stream runtime", "INTERNAL_ERROR")
		return
	}

	deleted, err := s.db.DeleteStream(r.Context(), streamID, db.DefaultTenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "stream not found", "NOT_FOUND")
		return
	}

	s.broadcastStreamEvent(streamID, map[string]any{
		"type":      "stream_deleted",
		"stream_id": streamID,
	})
	s.BroadcastStreamDeleted(streamID)
	s.closeWSClients(streamID)
	s.registry.closeAll("stream:" + streamID)
	writeJSON(w, http.StatusOK, map[string]any{
		"id":      streamID,
		"deleted": true,
	})
}

func (s *Server) applyPatchStream(ctx context.Context, existing *models.Stream, req patchStreamRequest, baseVersion int64) (*models.Stream, *patchStreamError) {
	updated := db.UpdateStreamParams{
		SourceID:        existing.SourceID,
		FrequencyKHz:    existing.FrequencyKHz,
		BandwidthLowHz:  existing.BandwidthLowHz,
		BandwidthHighHz: existing.BandwidthHighHz,
		Mode:            existing.Mode,
		Name:            existing.Name,
		AGCOn:           existing.AGCOn,
		AGCGainDB:       existing.AGCGainDB,
		BufferMinutes:   existing.BufferMinutes,
	}

	changed := false
	if req.SourceID != nil {
		v := strings.TrimSpace(*req.SourceID)
		if v == "" {
			return nil, &patchStreamError{Status: http.StatusBadRequest, Error: "source_id cannot be empty", Code: "VALIDATION"}
		}
		updated.SourceID = v
		changed = true
	}
	if req.FrequencyKHz != nil {
		if *req.FrequencyKHz <= 0 {
			return nil, &patchStreamError{Status: http.StatusBadRequest, Error: "frequency_khz must be > 0", Code: "VALIDATION"}
		}
		updated.FrequencyKHz = *req.FrequencyKHz
		changed = true
	}
	if req.BandwidthLowHz != nil {
		updated.BandwidthLowHz = *req.BandwidthLowHz
		changed = true
	}
	if req.BandwidthHighHz != nil {
		updated.BandwidthHighHz = *req.BandwidthHighHz
		changed = true
	}
	if req.Mode != nil {
		mode := strings.ToLower(strings.TrimSpace(*req.Mode))
		if mode == "" {
			return nil, &patchStreamError{Status: http.StatusBadRequest, Error: "mode cannot be empty", Code: "VALIDATION"}
		}
		updated.Mode = mode
		changed = true
	}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			return nil, &patchStreamError{Status: http.StatusBadRequest, Error: "name cannot be empty", Code: "VALIDATION"}
		}
		updated.Name = name
		changed = true
	}
	if req.AGCOn != nil {
		updated.AGCOn = *req.AGCOn
		changed = true
	}
	if req.AGCGainDB != nil {
		updated.AGCGainDB = req.AGCGainDB
		changed = true
	}
	if req.BufferMinutes != nil {
		if *req.BufferMinutes <= 0 {
			return nil, &patchStreamError{Status: http.StatusBadRequest, Error: "buffer_minutes must be > 0", Code: "VALIDATION"}
		}
		updated.BufferMinutes = *req.BufferMinutes
		changed = true
	}

	if !changed {
		return nil, &patchStreamError{Status: http.StatusBadRequest, Error: "no fields provided to update", Code: "VALIDATION"}
	}

	stream, err := s.db.UpdateStream(ctx, existing.ID, db.DefaultTenantID, updated, baseVersion)
	if err != nil {
		switch {
		case errors.Is(err, db.ErrVersionConflict):
			return nil, &patchStreamError{Status: http.StatusConflict, Error: "patch based on stale version", Code: "CONFLICT"}
		case errors.Is(err, db.ErrSourceNotFound):
			return nil, &patchStreamError{Status: http.StatusNotFound, Error: "source not found", Code: "NOT_FOUND"}
		case errors.Is(err, db.ErrSourceUnavailable):
			return nil, &patchStreamError{Status: http.StatusConflict, Error: "source is unavailable", Code: "SOURCE_UNAVAILABLE"}
		case errors.Is(err, db.ErrSourceAtCapacity):
			return nil, &patchStreamError{Status: http.StatusConflict, Error: "source is at max listeners", Code: "SOURCE_AT_CAPACITY"}
		default:
			return nil, &patchStreamError{Status: http.StatusInternalServerError, Error: err.Error(), Code: "INTERNAL_ERROR"}
		}
	}
	if stream == nil {
		return nil, &patchStreamError{Status: http.StatusNotFound, Error: "stream not found", Code: "NOT_FOUND"}
	}

	if err := s.streamManager.Reconfigure(ctx, *stream); err != nil {
		return nil, &patchStreamError{Status: http.StatusBadGateway, Error: "failed to reconfigure KiwiSDR source", Code: "SOURCE_CONNECT_FAILED"}
	}
	return stream, nil
}
