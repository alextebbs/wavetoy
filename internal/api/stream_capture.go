package api

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/capture"
	"github.com/sammy/sdr-radio/internal/streammgr"
)

func (s *Server) captureStream(w http.ResponseWriter, r *http.Request) {
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

	snap, err := s.streamManager.CaptureAudio(streamID)
	if err != nil {
		if err == streammgr.ErrStreamNotActive {
			writeError(w, http.StatusConflict, "stream is not active", "STREAM_NOT_ACTIVE")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}

	if len(snap.Audio) == 0 {
		writeError(w, http.StatusConflict, "ring buffer is empty, no audio captured yet", "BUFFER_EMPTY")
		return
	}

	label := strings.ReplaceAll(stream.Name, " ", "-")
	if label == "" {
		label = streamID
	}
	filename := fmt.Sprintf("%s-%s-%s-ringbuffer.wav",
		label,
		snap.StartTime.Format("20060102-150405"),
		snap.EndTime.Format("20060102-150405"),
	)
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))

	if err := capture.WriteWAV(w, snap); err != nil {
		log.Printf("[CAPTURE] WAV write error stream=%s: %v", streamID, err)
	}
}
