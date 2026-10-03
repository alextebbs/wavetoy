package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/chunkring"
	"github.com/sammy/sdr-radio/internal/db"
)

const activityThresholdDB = 6.0

type rewindChunkJSON struct {
	StartedAt   int64    `json:"started_at"`
	EndedAt     int64    `json:"ended_at"`
	Complete    bool     `json:"complete"`
	AudioBytes  int      `json:"audio_bytes"`
	WFFrames    int      `json:"wf_frames"`
	Events      int      `json:"events"`
	Source      string   `json:"source"`
	SourceID    string   `json:"source_id,omitempty"`
	StreamState int      `json:"stream_state"`
	HealthFlags int      `json:"health_flags"`
	InBandSNRdB *float64 `json:"in_band_snr_db,omitempty"`
	HasActivity *bool    `json:"has_activity,omitempty"`
}

func (s *Server) streamManifest(w http.ResponseWriter, r *http.Request) {
	if isMinefield(r) {
		s.minefieldManifest(w, r)
		return
	}
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return
	}

	fromStr := chi.URLParam(r, "from")
	toStr := chi.URLParam(r, "to")
	fromTS, err := strconv.ParseInt(fromStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid 'from' timestamp — use unix seconds", "VALIDATION")
		return
	}
	toTS, err := strconv.ParseInt(toStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid 'to' timestamp — use unix seconds", "VALIDATION")
		return
	}
	if toTS <= fromTS {
		writeError(w, http.StatusBadRequest, "'to' must be after 'from'", "VALIDATION")
		return
	}

	cr := s.streamManager.ChunkRing(streamID)
	if cr == nil {
		writeError(w, http.StatusNotFound, "stream not active", "NOT_FOUND")
		return
	}

	sr := s.streamManager.SampleRate(streamID)
	if sr <= 0 {
		sr = 12000
	}

	fromTime := time.Unix(fromTS, 0)
	toTime := time.Unix(toTS, 0)
	chunkDurS := int(cr.ChunkDuration().Seconds())

	ringChunks := cr.Available()
	ringSet := make(map[int64]bool, len(ringChunks))

	var chunks []rewindChunkJSON
	for _, rc := range ringChunks {
		ts := rc.StartedAt.Unix()
		if ts < fromTS || ts >= toTS {
			if rc.EndedAt == nil || rc.EndedAt.Unix() <= fromTS {
				continue
			}
		}
		ringSet[ts] = true

		var endedAt int64
		if rc.EndedAt != nil {
			endedAt = rc.EndedAt.Unix()
		} else {
			endedAt = rc.StartedAt.Add(cr.ChunkDuration()).Unix()
		}

		cj := rewindChunkJSON{
			StartedAt:   ts,
			EndedAt:     endedAt,
			Complete:    rc.Complete,
			AudioBytes:  rc.AudioBytes,
			WFFrames:    rc.WFFrames,
			Events:      rc.Events,
			Source:      "ring",
			SourceID:    rc.SourceID,
			StreamState: int(rc.State),
			HealthFlags: int(rc.Health),
			InBandSNRdB: rc.InBandSNRdB,
		}
		if rc.InBandSNRdB != nil {
			active := *rc.InBandSNRdB >= activityThresholdDB
			cj.HasActivity = &active
		}
		chunks = append(chunks, cj)
	}

	s3c := s.streamManager.S3Client()
	if s3c != nil {
		s3Chunks, err := s.db.ListOffloadedChunks(r.Context(), streamID, fromTime, toTime)
		if err != nil {
			slog.Warn("manifest: s3 chunk lookup failed", "stream", streamID, "err", err)
		} else {
			for _, sc := range s3Chunks {
				ts := sc.StartedAt.Unix()
				if ringSet[ts] {
					continue
				}
				wfFrames := sc.WFFrames
				if wfFrames == 0 && chunkDurS > 0 {
					wfFrames = chunkDurS * 8
				}
			cj := rewindChunkJSON{
				StartedAt:   ts,
				EndedAt:     sc.EndedAt.Unix(),
				Complete:    true,
				AudioBytes:  sc.AudioBytes,
				WFFrames:    wfFrames,
				Events:      sc.Events,
				Source:      "s3",
				StreamState: sc.StreamState,
				HealthFlags: sc.HealthFlags,
				InBandSNRdB: sc.InBandSNRdB,
			}
			if sc.InBandSNRdB != nil {
				active := *sc.InBandSNRdB >= activityThresholdDB
				cj.HasActivity = &active
			}
			chunks = append(chunks, cj)
			}
		}
	}

	resp := map[string]any{
		"stream_id":        streamID,
		"sample_rate":      sr,
		"chunk_duration_s": chunkDurS,
		"chunks":           chunks,
	}

	if s.streamManager.S3Client() != nil {
		stats, err := s.db.OffloadedChunkStats(r.Context(), streamID)
		if err != nil {
			slog.Warn("manifest: s3 stats failed", "stream", streamID, "err", err)
		} else if stats != nil {
			resp["s3_history"] = map[string]any{
				"count":  stats.Count,
				"oldest": stats.Oldest.Unix(),
				"newest": stats.Newest.Unix(),
			}
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) streamChunkSummary(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return
	}

	daysStr := r.URL.Query().Get("days")
	days := 30
	if daysStr != "" {
		d, err := strconv.Atoi(daysStr)
		if err == nil && d > 0 && d <= 30 {
			days = d
		}
	}

	now := time.Now().UTC()
	from := now.AddDate(0, 0, -days)

	buckets, err := s.db.ChunkSummaryByHour(r.Context(), streamID, from, now)
	if err != nil {
		slog.Warn("chunk-summary: db query failed", "stream", streamID, "err", err)
		writeError(w, http.StatusInternalServerError, "failed to query chunk summary", "INTERNAL_ERROR")
		return
	}

	// Merge ring-buffer chunks for the current partial day.
	cr := s.streamManager.ChunkRing(streamID)
	if cr != nil {
		ringChunks := cr.Available()
		ringByHour := make(map[string]map[int][2]int) // date -> hour -> [count, wfFrames]
		for _, rc := range ringChunks {
			t := rc.StartedAt.UTC()
			dateKey := t.Format("2006-01-02")
			hour := t.Hour()
			if ringByHour[dateKey] == nil {
				ringByHour[dateKey] = make(map[int][2]int)
			}
			v := ringByHour[dateKey][hour]
			v[0]++
			v[1] += rc.WFFrames
			ringByHour[dateKey][hour] = v
		}

		// Merge ring data into existing buckets or create new ones.
		dayIdx := make(map[string]int, len(buckets))
		for i, b := range buckets {
			dayIdx[b.Date] = i
		}

		s3Set := make(map[string]map[int]bool)
		for _, b := range buckets {
			s3Set[b.Date] = make(map[int]bool)
			for _, h := range b.Hours {
				s3Set[b.Date][h.Hour] = true
			}
		}

		for dateKey, hours := range ringByHour {
			idx, exists := dayIdx[dateKey]
			if !exists {
				buckets = append(buckets, db.DayBucket{Date: dateKey})
				idx = len(buckets) - 1
				dayIdx[dateKey] = idx
			}
			for hour, counts := range hours {
				if s3Set[dateKey] != nil && s3Set[dateKey][hour] {
					continue
				}
				buckets[idx].ChunkCount += counts[0]
				buckets[idx].WFFrames += counts[1]
				buckets[idx].Hours = append(buckets[idx].Hours, db.HourBucket{
					Hour:       hour,
					ChunkCount: counts[0],
					WFFrames:   counts[1],
				})
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"stream_id": streamID,
		"days":      buckets,
	})
}

func (s *Server) streamRewindChunkAudio(w http.ResponseWriter, r *http.Request) {
	if isMinefield(r) {
		s.minefieldAudio(w, r)
		return
	}
	streamID, ts, ok := s.parseRewindParams(w, r)
	if !ok {
		return
	}

	cr := s.streamManager.ChunkRing(streamID)
	if cr != nil {
		if chunk := s.findRingChunk(cr, ts); chunk != nil {
			w.Header().Set("Content-Type", "audio/wav")
			s.setChunkCacheHeaders(w, chunk)
			chunkring.SerializeAudioWAV(w, chunk)
			return
		}
	}

	s.proxyS3Object(w, r, streamID, ts, "audio.wav", "audio/wav")
}

func (s *Server) streamRewindChunkWF(w http.ResponseWriter, r *http.Request) {
	if isMinefield(r) {
		s.minefieldWF(w, r)
		return
	}
	streamID, ts, ok := s.parseRewindParams(w, r)
	if !ok {
		return
	}

	cr := s.streamManager.ChunkRing(streamID)
	if cr != nil {
		if chunk := s.findRingChunk(cr, ts); chunk != nil {
			w.Header().Set("Content-Type", "application/octet-stream")
			s.setChunkCacheHeaders(w, chunk)
			chunkring.SerializeWF(w, chunk)
			return
		}
	}

	s.proxyS3Object(w, r, streamID, ts, "wf.bin", "application/octet-stream")
}

func (s *Server) streamRewindChunkEvents(w http.ResponseWriter, r *http.Request) {
	if isMinefield(r) {
		s.minefieldEvents(w, r)
		return
	}
	streamID, ts, ok := s.parseRewindParams(w, r)
	if !ok {
		return
	}

	cr := s.streamManager.ChunkRing(streamID)
	if cr != nil {
		if chunk := s.findRingChunk(cr, ts); chunk != nil {
			w.Header().Set("Content-Type", "application/x-ndjson")
			s.setChunkCacheHeaders(w, chunk)
			chunkring.SerializeEvents(w, chunk)
			return
		}
	}

	s.proxyS3Object(w, r, streamID, ts, "events.jsonl", "application/x-ndjson")
}

func (s *Server) parseRewindParams(w http.ResponseWriter, r *http.Request) (string, int64, bool) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return "", 0, false
	}

	tsStr := chi.URLParam(r, "ts")
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid timestamp — use unix seconds", "VALIDATION")
		return "", 0, false
	}

	return streamID, ts, true
}

func (s *Server) findRingChunk(cr *chunkring.ChunkRing, ts int64) *chunkring.Chunk {
	t := time.Unix(ts, 0)

	current := cr.GetCurrent()
	if current != nil && current.StartedAt.Unix() == ts {
		return current
	}

	return cr.GetChunkByTime(t)
}

func (s *Server) setChunkCacheHeaders(w http.ResponseWriter, chunk *chunkring.Chunk) {
	if chunk.Complete {
		w.Header().Set("Cache-Control", "public, max-age=3600, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("X-Chunk-StartedAt", fmt.Sprintf("%d", chunk.StartedAt.Unix()))
	w.Header().Set("X-Chunk-Complete", fmt.Sprintf("%t", chunk.Complete))
}

func (s *Server) proxyS3Object(w http.ResponseWriter, r *http.Request, streamID string, ts int64, filename, contentType string) {
	t0 := time.Now()

	s3c := s.streamManager.S3Client()
	if s3c == nil {
		writeError(w, http.StatusNotFound, "chunk not found", "NOT_FOUND")
		return
	}

	row, err := s.db.GetOffloadedChunkByTime(r.Context(), streamID, time.Unix(ts, 0))
	if err != nil {
		slog.Warn("rewind: s3 lookup failed", "stream", streamID, "ts", ts, "err", err)
		writeError(w, http.StatusInternalServerError, "storage lookup failed", "INTERNAL_ERROR")
		return
	}
	if row == nil {
		writeError(w, http.StatusNotFound, "chunk not found", "NOT_FOUND")
		return
	}

	key := fmt.Sprintf("%s/streams/%s/%d/%s", s3c.Prefix(), streamID, row.StartedAt.Unix(), filename)
	presigned, err := s3c.PreSignGet(r.Context(), key, time.Hour)
	if err != nil {
		slog.Warn("rewind: s3 presign failed", "key", key, "err", err)
		writeError(w, http.StatusBadGateway, "failed to generate storage URL", "STORAGE_ERROR")
		return
	}

	slog.Info("rewind: s3 presign",
		"stream", streamID,
		"ts", ts,
		"file", filename,
		"total_ms", time.Since(t0).Milliseconds(),
	)

	writeJSON(w, http.StatusOK, map[string]string{"url": presigned})
}
