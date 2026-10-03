package api

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/db"
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

func (s *Server) getSourceStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing source id", "BAD_REQUEST")
		return
	}
	raw, err := s.healthChecker.CheckSource(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(raw))
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

func (s *Server) getSourceSNRHistory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing source id", "BAD_REQUEST")
		return
	}

	now := time.Now()
	from := now.Add(-24 * time.Hour)
	to := now

	if v := r.URL.Query().Get("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			from = t
		}
	}
	if v := r.URL.Query().Get("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			to = t
		}
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

	readings, err := s.db.ListSNRReadings(r.Context(), id, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}
	if readings == nil {
		readings = []db.SNRReading{}
	}

	var stats *snrStats
	if len(readings) > 0 {
		s := computeSNRStats(readings)
		stats = &s
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"source_id":   source.ID,
		"source_name": source.Name,
		"readings":    readings,
		"ema":         source.SNRDBM,
		"stats":       stats,
	})
}

type snrStats struct {
	Avg    float64 `json:"avg"`
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	Stddev float64 `json:"stddev"`
	Count  int     `json:"count"`
}

func computeSNRStats(readings []db.SNRReading) snrStats {
	n := len(readings)
	if n == 0 {
		return snrStats{}
	}
	min := readings[0].SNRDBM
	max := readings[0].SNRDBM
	sum := 0.0
	for _, r := range readings {
		sum += r.SNRDBM
		if r.SNRDBM < min {
			min = r.SNRDBM
		}
		if r.SNRDBM > max {
			max = r.SNRDBM
		}
	}
	avg := sum / float64(n)
	variance := 0.0
	for _, r := range readings {
		d := r.SNRDBM - avg
		variance += d * d
	}
	variance /= float64(n)
	return snrStats{
		Avg:    math.Round(avg*10) / 10,
		Min:    min,
		Max:    max,
		Stddev: math.Round(math.Sqrt(variance)*10) / 10,
		Count:  n,
	}
}
