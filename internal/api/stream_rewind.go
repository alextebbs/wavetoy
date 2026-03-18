package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/chunkring"
)

func (s *Server) streamRewind(w http.ResponseWriter, r *http.Request) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return
	}

	cr := s.streamManager.ChunkRing(streamID)
	if cr == nil {
		writeError(w, http.StatusNotFound, "stream not active", "NOT_FOUND")
		return
	}

	avail := cr.Available()
	sr := 12000
	if len(avail) > 0 {
		// Get sample rate from the stream manager
		sr = s.streamManager.SampleRate(streamID)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"stream_id":   streamID,
		"sample_rate": sr,
		"chunks":      avail,
	})
}

func (s *Server) streamRewindChunkAudio(w http.ResponseWriter, r *http.Request) {
	cr, chunk, ok := s.resolveRewindChunk(w, r)
	if !ok {
		return
	}
	_ = cr

	w.Header().Set("Content-Type", "audio/wav")
	if chunk.Complete {
		w.Header().Set("Cache-Control", "public, max-age=3600, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("X-Chunk-StartedAt", chunk.StartedAt.Format("2006-01-02T15:04:05.000Z"))
	w.Header().Set("X-Chunk-Complete", fmt.Sprintf("%t", chunk.Complete))

	if err := chunkring.SerializeAudioWAV(w, chunk); err != nil {
		return // Client likely disconnected; headers already sent.
	}
}

func (s *Server) streamRewindChunkWF(w http.ResponseWriter, r *http.Request) {
	cr, chunk, ok := s.resolveRewindChunk(w, r)
	if !ok {
		return
	}
	_ = cr

	w.Header().Set("Content-Type", "application/octet-stream")
	if chunk.Complete {
		w.Header().Set("Cache-Control", "public, max-age=3600, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("X-Chunk-StartedAt", chunk.StartedAt.Format("2006-01-02T15:04:05.000Z"))
	w.Header().Set("X-Chunk-Complete", fmt.Sprintf("%t", chunk.Complete))

	if err := chunkring.SerializeWF(w, chunk); err != nil {
		return
	}
}

func (s *Server) streamRewindChunkEvents(w http.ResponseWriter, r *http.Request) {
	cr, chunk, ok := s.resolveRewindChunk(w, r)
	if !ok {
		return
	}
	_ = cr

	w.Header().Set("Content-Type", "application/x-ndjson")
	if chunk.Complete {
		w.Header().Set("Cache-Control", "public, max-age=3600, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("X-Chunk-StartedAt", chunk.StartedAt.Format("2006-01-02T15:04:05.000Z"))
	w.Header().Set("X-Chunk-Complete", fmt.Sprintf("%t", chunk.Complete))

	if err := chunkring.SerializeEvents(w, chunk); err != nil {
		return
	}
}

// resolveRewindChunk extracts the stream and chunk started_at timestamp from
// the request, looks up the chunk, and writes an error response if anything
// fails. Returns the ChunkRing, the resolved Chunk, and whether the lookup
// succeeded.
func (s *Server) resolveRewindChunk(w http.ResponseWriter, r *http.Request) (*chunkring.ChunkRing, *chunkring.Chunk, bool) {
	streamID := chi.URLParam(r, "id")
	if strings.TrimSpace(streamID) == "" {
		writeError(w, http.StatusBadRequest, "stream id is required", "VALIDATION")
		return nil, nil, false
	}

	startedAtStr := chi.URLParam(r, "started_at")
	if decoded, err := url.PathUnescape(startedAtStr); err == nil {
		startedAtStr = decoded
	}
	slog.Debug("resolveRewindChunk", "started_at_raw", startedAtStr)
	t, err := time.Parse(time.RFC3339Nano, startedAtStr)
	if err != nil {
		slog.Warn("resolveRewindChunk: parse failed", "raw", startedAtStr, "err", err)
		writeError(w, http.StatusBadRequest, "invalid started_at timestamp", "VALIDATION")
		return nil, nil, false
	}

	cr := s.streamManager.ChunkRing(streamID)
	if cr == nil {
		writeError(w, http.StatusNotFound, "stream not active", "NOT_FOUND")
		return nil, nil, false
	}

	// Check if it's the in-progress chunk
	current := cr.GetCurrent()
	if current != nil && current.StartedAt.Truncate(time.Millisecond).Equal(t.Truncate(time.Millisecond)) {
		return cr, current, true
	}

	chunk := cr.GetChunkByTime(t)
	if chunk == nil {
		writeError(w, http.StatusNotFound, "chunk not found or evicted", "NOT_FOUND")
		return nil, nil, false
	}
	return cr, chunk, true
}
