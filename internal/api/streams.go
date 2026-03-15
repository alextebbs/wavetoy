package api

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/fallback"
	"github.com/sammy/sdr-radio/internal/interpreter"
	"github.com/sammy/sdr-radio/internal/models"
	"github.com/sammy/sdr-radio/internal/streamlog"
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
	SourceID         *string              `json:"source_id"`
	FrequencyKHz     *float64             `json:"frequency_khz"`
	BandwidthLowHz   *int                 `json:"bandwidth_low_hz"`
	BandwidthHighHz  *int                 `json:"bandwidth_high_hz"`
	Mode             *string              `json:"mode"`
	Name             *string              `json:"name"`
	AGCOn            *bool                `json:"agc_on"`
	AGCGainDB        *float64             `json:"agc_gain_db"`
	BufferMinutes    *int                 `json:"buffer_minutes"`
	Filters          *models.FilterConfig  `json:"filters"`
	Interpreter      *interpreter.Config   `json:"interpreter"`
	AutoFallback     *bool                 `json:"auto_fallback"`
	AutoFallbackKind *string              `json:"auto_fallback_kind"`
	ViewLocked       *bool                `json:"view_locked"`
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
		req.BandwidthLowHz = -4900
	}
	if req.BandwidthHighHz == 0 {
		req.BandwidthHighHz = 4900
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
		TenantID:        TenantID(r.Context()),
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
		case errors.Is(err, db.ErrTenantAtCapacity):
			writeError(w, http.StatusConflict, "tenant stream limit reached", "TENANT_AT_CAPACITY")
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

	s.streamLog.Info(stream.ID, "created", fmt.Sprintf("source=%s freq=%.3fkHz mode=%s", stream.SourceID, stream.FrequencyKHz, stream.Mode))

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
	if existing == nil || existing.TenantID != TenantID(r.Context()) {
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
	if existing == nil || existing.TenantID != TenantID(r.Context()) {
		writeError(w, http.StatusNotFound, "stream not found", "NOT_FOUND")
		return
	}

	s.streamLog.Info(streamID, "deleted", "stream deleted by user")

	if err := s.streamManager.Remove(streamID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to stop stream runtime", "INTERNAL_ERROR")
		return
	}

	deleted, err := s.db.DeleteStream(r.Context(), streamID, TenantID(r.Context()))
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

func (s *Server) applyPatchStream(ctx context.Context, existing *models.Stream, req patchStreamRequest, baseVersion int64, patchBy ...string) (*models.Stream, *patchStreamError) {
	by := ""
	if len(patchBy) > 0 {
		by = patchBy[0]
	}
	updated := db.UpdateStreamParams{
		SourceID:         existing.SourceID,
		FrequencyKHz:     existing.FrequencyKHz,
		BandwidthLowHz:   existing.BandwidthLowHz,
		BandwidthHighHz:  existing.BandwidthHighHz,
		Mode:             existing.Mode,
		Name:             existing.Name,
		AGCOn:            existing.AGCOn,
		AGCGainDB:        existing.AGCGainDB,
		BufferMinutes:    existing.BufferMinutes,
		Filters:          existing.Filters,
		Interpreter:      existing.Interpreter,
		AutoFallback:     existing.AutoFallback,
		AutoFallbackKind: existing.AutoFallbackKind,
		ViewLocked:       existing.ViewLocked,
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
	if req.Filters != nil {
		updated.Filters = *req.Filters
		changed = true
	}
	if req.Interpreter != nil {
		updated.Interpreter = *req.Interpreter
		changed = true
	}
	if req.AutoFallback != nil {
		updated.AutoFallback = *req.AutoFallback
		changed = true
	}
	if req.AutoFallbackKind != nil {
		kind := strings.ToLower(strings.TrimSpace(*req.AutoFallbackKind))
		if kind != "auto" && kind != "manual" {
			return nil, &patchStreamError{Status: http.StatusBadRequest, Error: "auto_fallback_kind must be 'auto' or 'manual'", Code: "VALIDATION"}
		}
		updated.AutoFallbackKind = kind
		changed = true
	}
	if req.ViewLocked != nil {
		updated.ViewLocked = *req.ViewLocked
		changed = true
	}

	if !changed {
		return nil, &patchStreamError{Status: http.StatusBadRequest, Error: "no fields provided to update", Code: "VALIDATION"}
	}

	stream, err := s.db.UpdateStream(ctx, existing.ID, existing.TenantID, updated, baseVersion)
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

	if s.fallbackManager != nil {
		s.streamManager.SetAutoFallback(stream.ID, stream.AutoFallback)
		s.fallbackManager.OnStreamUpdated(*stream)
	}

	s.logPatchChanges(existing, stream, by)

	return stream, nil
}

func (s *Server) logPatchChanges(before *models.Stream, after *models.Stream, by string) {
	sid := before.ID
	byTag := ""
	if by != "" {
		byTag = " by=" + by
	}
	if before.FrequencyKHz != after.FrequencyKHz {
		s.streamLog.Wire(sid, streamlog.LevelInfo, "tune", "client", "kiwi",
			fmt.Sprintf("%.3f→%.3f kHz%s", before.FrequencyKHz, after.FrequencyKHz, byTag))
	}
	if before.Mode != after.Mode {
		s.streamLog.Wire(sid, streamlog.LevelInfo, "mode", "client", "kiwi",
			fmt.Sprintf("%s→%s%s", before.Mode, after.Mode, byTag))
	}
	if before.BandwidthLowHz != after.BandwidthLowHz || before.BandwidthHighHz != after.BandwidthHighHz {
		s.streamLog.Wire(sid, streamlog.LevelInfo, "bandwidth", "client", "kiwi",
			fmt.Sprintf("%d..%d→%d..%d Hz%s", before.BandwidthLowHz, before.BandwidthHighHz, after.BandwidthLowHz, after.BandwidthHighHz, byTag))
	}
	if before.AGCOn != after.AGCOn {
		s.streamLog.Wire(sid, streamlog.LevelInfo, "agc", "client", "kiwi",
			fmt.Sprintf("%v→%v%s", before.AGCOn, after.AGCOn, byTag))
	}
	if before.Name != after.Name {
		s.streamLog.Wire(sid, streamlog.LevelInfo, "rename", "client", "wavetoy",
			fmt.Sprintf("%s→%s%s", before.Name, after.Name, byTag))
	}
	if !filtersEqual(before.Filters, after.Filters) {
		desc := describeFilterChanges(before.Filters, after.Filters)
		s.streamLog.Wire(sid, streamlog.LevelInfo, "filters", "client", "wavetoy",
			fmt.Sprintf("%s%s", desc, byTag))
	}
	if !interpreterEqual(before.Interpreter, after.Interpreter) {
		s.streamLog.Wire(sid, streamlog.LevelInfo, "interpreter", "client", "wavetoy",
			fmt.Sprintf("type=%s enabled=%v%s", after.Interpreter.Type, after.Interpreter.Enabled, byTag))
	}
	if before.AutoFallback != after.AutoFallback {
		s.streamLog.Wire(sid, streamlog.LevelInfo, "auto_fallback", "client", "wavetoy",
			fmt.Sprintf("%v→%v%s", before.AutoFallback, after.AutoFallback, byTag))
	}
	if before.ViewLocked != after.ViewLocked {
		s.streamLog.Wire(sid, streamlog.LevelInfo, "view_locked", "client", "wavetoy",
			fmt.Sprintf("%v→%v%s", before.ViewLocked, after.ViewLocked, byTag))
	}
}

func filtersEqual(a, b models.FilterConfig) bool {
	aj, _ := json.Marshal(a)
	bj, _ := json.Marshal(b)
	return string(aj) == string(bj)
}

func describeFilterChanges(before, after models.FilterConfig) string {
	var parts []string

	type filterPair struct {
		name   string
		before enabledCfg
		after  enabledCfg
	}
	pairs := []filterPair{
		{"low_pass", wrapFilter(before.LowPass), wrapFilter(after.LowPass)},
		{"high_pass", wrapFilter(before.HighPass), wrapFilter(after.HighPass)},
		{"notch", wrapFilter(before.Notch), wrapFilter(after.Notch)},
		{"noise_gate", wrapFilter(before.NoiseGate), wrapFilter(after.NoiseGate)},
		{"soft_clipper", wrapFilter(before.SoftClipper), wrapFilter(after.SoftClipper)},
		{"noise_reducer", wrapFilter(before.NoiseReducer), wrapFilter(after.NoiseReducer)},
	}
	for _, p := range pairs {
		bOn, aOn := p.before.enabled, p.after.enabled
		bJSON, _ := json.Marshal(p.before.raw)
		aJSON, _ := json.Marshal(p.after.raw)
		bStr, aStr := string(bJSON), string(aJSON)

		if bStr == aStr {
			continue
		}
		if !bOn && aOn {
			parts = append(parts, p.name+" on"+filterParamSummary(p.name, p.after))
		} else if bOn && !aOn {
			parts = append(parts, p.name+" off")
		} else {
			parts = append(parts, p.name+filterParamDiff(p.name, p.before, p.after))
		}
	}
	if len(parts) == 0 {
		return "filters updated"
	}
	return strings.Join(parts, ", ")
}

type enabledCfg struct {
	enabled bool
	raw     any
}

func wrapFilter[T interface{ IsEnabled() bool }](f *T) enabledCfg {
	if f == nil {
		return enabledCfg{enabled: false, raw: nil}
	}
	return enabledCfg{enabled: (*f).IsEnabled(), raw: *f}
}

func filterParamSummary(name string, c enabledCfg) string {
	switch name {
	case "low_pass":
		if v, ok := c.raw.(models.LowPassConfig); ok {
			return fmt.Sprintf(" cutoff=%.0fHz", v.CutoffHz)
		}
	case "high_pass":
		if v, ok := c.raw.(models.HighPassConfig); ok {
			return fmt.Sprintf(" cutoff=%.0fHz", v.CutoffHz)
		}
	case "notch":
		if v, ok := c.raw.(models.NotchConfig); ok {
			return fmt.Sprintf(" center=%.0fHz q=%.1f", v.CenterHz, v.Q)
		}
	case "noise_gate":
		if v, ok := c.raw.(models.NoiseGateConfig); ok {
			return fmt.Sprintf(" thresh=%.0fdB", v.ThresholdDB)
		}
	case "soft_clipper":
		if v, ok := c.raw.(models.SoftClipperConfig); ok {
			return fmt.Sprintf(" drive=%.0fdB ceil=%.0fdB", v.DriveDB, v.CeilingDB)
		}
	case "noise_reducer":
		if v, ok := c.raw.(models.NoiseReducerConfig); ok {
			return fmt.Sprintf(" strength=%.1f floor=%.0fdB", v.Strength, v.FloorDB)
		}
	}
	return ""
}

func filterParamDiff(name string, before, after enabledCfg) string {
	switch name {
	case "low_pass":
		b, _ := before.raw.(models.LowPassConfig)
		a, _ := after.raw.(models.LowPassConfig)
		if b.CutoffHz != a.CutoffHz {
			return fmt.Sprintf(" cutoff %.0f→%.0fHz", b.CutoffHz, a.CutoffHz)
		}
	case "high_pass":
		b, _ := before.raw.(models.HighPassConfig)
		a, _ := after.raw.(models.HighPassConfig)
		if b.CutoffHz != a.CutoffHz {
			return fmt.Sprintf(" cutoff %.0f→%.0fHz", b.CutoffHz, a.CutoffHz)
		}
	case "notch":
		b, _ := before.raw.(models.NotchConfig)
		a, _ := after.raw.(models.NotchConfig)
		var diffs []string
		if b.CenterHz != a.CenterHz {
			diffs = append(diffs, fmt.Sprintf("center %.0f→%.0fHz", b.CenterHz, a.CenterHz))
		}
		if b.Q != a.Q {
			diffs = append(diffs, fmt.Sprintf("q %.1f→%.1f", b.Q, a.Q))
		}
		if len(diffs) > 0 {
			return " " + strings.Join(diffs, " ")
		}
	case "noise_gate":
		b, _ := before.raw.(models.NoiseGateConfig)
		a, _ := after.raw.(models.NoiseGateConfig)
		var diffs []string
		if b.ThresholdDB != a.ThresholdDB {
			diffs = append(diffs, fmt.Sprintf("thresh %.0f→%.0fdB", b.ThresholdDB, a.ThresholdDB))
		}
		if b.HoldMs != a.HoldMs {
			diffs = append(diffs, fmt.Sprintf("hold %.0f→%.0fms", b.HoldMs, a.HoldMs))
		}
		if b.AttackMs != a.AttackMs {
			diffs = append(diffs, fmt.Sprintf("attack %.0f→%.0fms", b.AttackMs, a.AttackMs))
		}
		if b.ReleaseMs != a.ReleaseMs {
			diffs = append(diffs, fmt.Sprintf("release %.0f→%.0fms", b.ReleaseMs, a.ReleaseMs))
		}
		if len(diffs) > 0 {
			return " " + strings.Join(diffs, " ")
		}
	case "soft_clipper":
		b, _ := before.raw.(models.SoftClipperConfig)
		a, _ := after.raw.(models.SoftClipperConfig)
		var diffs []string
		if b.DriveDB != a.DriveDB {
			diffs = append(diffs, fmt.Sprintf("drive %.0f→%.0fdB", b.DriveDB, a.DriveDB))
		}
		if b.CeilingDB != a.CeilingDB {
			diffs = append(diffs, fmt.Sprintf("ceil %.0f→%.0fdB", b.CeilingDB, a.CeilingDB))
		}
		if len(diffs) > 0 {
			return " " + strings.Join(diffs, " ")
		}
	case "noise_reducer":
		b, _ := before.raw.(models.NoiseReducerConfig)
		a, _ := after.raw.(models.NoiseReducerConfig)
		var diffs []string
		if b.Strength != a.Strength {
			diffs = append(diffs, fmt.Sprintf("strength %.1f→%.1f", b.Strength, a.Strength))
		}
		if b.FloorDB != a.FloorDB {
			diffs = append(diffs, fmt.Sprintf("floor %.0f→%.0fdB", b.FloorDB, a.FloorDB))
		}
		if len(diffs) > 0 {
			return " " + strings.Join(diffs, " ")
		}
	}
	return ""
}

func interpreterEqual(a, b interpreter.Config) bool {
	aj, _ := json.Marshal(a)
	bj, _ := json.Marshal(b)
	return string(aj) == string(bj)
}

func (s *Server) getStreamLogs(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return
	}

	levelStr := r.URL.Query().Get("level")
	minLevel := streamlog.LevelInfo
	switch levelStr {
	case "debug":
		minLevel = streamlog.LevelDebug
	case "warn":
		minLevel = streamlog.LevelWarn
	case "error":
		minLevel = streamlog.LevelError
	}

	limit := 200
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 2000 {
			limit = n
		}
	}

	entries := s.streamLog.Snapshot(streamID, minLevel, limit)
	writeJSON(w, http.StatusOK, map[string]any{
		"stream_id": streamID,
		"level":     s.streamLog.GetLevel(streamID),
		"count":     len(entries),
		"entries":   entries,
	})
}

func (s *Server) downloadStreamLogs(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return
	}

	level := s.streamLog.GetLevel(streamID)
	entries := s.streamLog.Snapshot(streamID, level, streamlog.DefaultBufferSize)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="logs-%s.json"`, streamID))
	_ = json.NewEncoder(w).Encode(map[string]any{
		"stream_id": streamID,
		"level":     level,
		"count":     len(entries),
		"entries":   entries,
	})
}

func (s *Server) setStreamDebug(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return
	}

	var req struct {
		Level string `json:"level"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body", "VALIDATION")
		return
	}

	var level streamlog.LogLevel
	switch req.Level {
	case "debug":
		level = streamlog.LevelDebug
	case "info":
		level = streamlog.LevelInfo
	case "warn":
		level = streamlog.LevelWarn
	case "error":
		level = streamlog.LevelError
	default:
		writeError(w, http.StatusBadRequest, "level must be one of: debug, info, warn, error", "VALIDATION")
		return
	}

	s.streamLog.SetLevel(streamID, level)
	s.streamLog.Info(streamID, "debug.level", fmt.Sprintf("log level set to %s", level))

	writeJSON(w, http.StatusOK, map[string]any{
		"stream_id": streamID,
		"level":     level,
	})
}

func (s *Server) getStreamFallbacks(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return
	}

	stream, err := s.db.GetStreamByID(r.Context(), streamID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	if stream == nil {
		writeError(w, http.StatusNotFound, "stream not found", "NOT_FOUND")
		return
	}

	if s.fallbackManager == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"stream_id":     streamID,
			"auto_fallback": stream.AutoFallback,
			"suggestions":   []any{},
		})
		return
	}

	suggestions, err := s.fallbackManager.GetSuggestions(r.Context(), streamID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	if suggestions == nil {
		suggestions = make([]*fallback.FallbackSuggestion, 0)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"stream_id":          streamID,
		"auto_fallback":      stream.AutoFallback,
		"auto_fallback_kind": stream.AutoFallbackKind,
		"suggestions":        suggestions,
	})
}

func (s *Server) reprobeStream(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return
	}

	stream, err := s.db.GetStreamByID(r.Context(), streamID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	if stream == nil {
		writeError(w, http.StatusNotFound, "stream not found", "NOT_FOUND")
		return
	}

	if !stream.AutoFallback {
		writeError(w, http.StatusBadRequest, "auto_fallback is not enabled on this stream", "VALIDATION")
		return
	}

	if s.fallbackManager == nil {
		writeError(w, http.StatusServiceUnavailable, "fallback manager not available", "INTERNAL_ERROR")
		return
	}

	s.fallbackManager.Reprobe(r.Context(), streamID)

	writeJSON(w, http.StatusAccepted, map[string]any{
		"stream_id": streamID,
		"status":    "reprobe_started",
	})
}

func (s *Server) getStreamRefAudio(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	audio, sampleRate, err := s.db.GetStreamRefAudio(r.Context(), streamID)
	if err != nil {
		writeError(w, http.StatusNotFound, "stream not found", "NOT_FOUND")
		return
	}
	if len(audio) == 0 {
		writeError(w, http.StatusNotFound, "no reference audio available (run a probe cycle first)", "NOT_FOUND")
		return
	}

	stream, _ := s.db.GetStreamByID(r.Context(), streamID)
	filename := fmt.Sprintf("%s-ref.wav", streamID[:8])
	if stream != nil {
		filename = fmt.Sprintf("%s-ref.wav", stream.SourceID[:8])
	}
	serveWAV(w, audio, sampleRate, filename)
}

func (s *Server) getFallbackProbeAudio(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	rankStr := chi.URLParam(r, "rank")
	rank, err := strconv.Atoi(rankStr)
	if err != nil || rank < 1 || rank > 10 {
		writeError(w, http.StatusBadRequest, "rank must be 1-10", "VALIDATION")
		return
	}
	probe, err := s.db.GetFallbackProbeAudio(r.Context(), streamID, rank)
	if err != nil {
		writeError(w, http.StatusNotFound, "fallback suggestion not found", "NOT_FOUND")
		return
	}
	if len(probe.Audio) == 0 {
		writeError(w, http.StatusNotFound, "no probe audio available for this suggestion", "NOT_FOUND")
		return
	}

	filename := fmt.Sprintf("%s-%s.wav", probe.SourceID[:8], probe.LastProbed.UTC().Format("20060102-150405"))
	serveWAV(w, probe.Audio, probe.SampleRate, filename)
}

func serveWAV(w http.ResponseWriter, pcm []byte, sampleRate int, filename string) {
	if sampleRate <= 0 {
		sampleRate = 12000
	}
	channels := 1
	bitsPerSample := 16
	byteRate := sampleRate * channels * bitsPerSample / 8
	blockAlign := channels * bitsPerSample / 8
	dataSize := len(pcm)

	header := make([]byte, 44)
	copy(header[0:4], "RIFF")
	binary.LittleEndian.PutUint32(header[4:8], uint32(36+dataSize))
	copy(header[8:12], "WAVE")
	copy(header[12:16], "fmt ")
	binary.LittleEndian.PutUint32(header[16:20], 16)
	binary.LittleEndian.PutUint16(header[20:22], 1) // PCM
	binary.LittleEndian.PutUint16(header[22:24], uint16(channels))
	binary.LittleEndian.PutUint32(header[24:28], uint32(sampleRate))
	binary.LittleEndian.PutUint32(header[28:32], uint32(byteRate))
	binary.LittleEndian.PutUint16(header[32:34], uint16(blockAlign))
	binary.LittleEndian.PutUint16(header[34:36], uint16(bitsPerSample))
	copy(header[36:40], "data")
	binary.LittleEndian.PutUint32(header[40:44], uint32(dataSize))

	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Content-Length", strconv.Itoa(44+dataSize))
	w.WriteHeader(http.StatusOK)
	w.Write(header)
	w.Write(pcm)
}
