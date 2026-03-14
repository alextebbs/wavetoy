package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/sammy/sdr-radio/internal/db"
)

type wsStreamMessage struct {
	Type  string             `json:"type"`
	Patch patchStreamRequest `json:"patch"`
}

const wsPacketTypeAudioPCM16 = 0x02

func (s *Server) streamWS(w http.ResponseWriter, r *http.Request) {
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
	if stream == nil || stream.TenantID != db.DefaultTenantID {
		writeError(w, http.StatusNotFound, "stream not found", "NOT_FOUND")
		return
	}
	if err := s.streamManager.EnsureRunning(r.Context(), *stream); err != nil {
		writeError(w, http.StatusBadGateway, "failed to connect to KiwiSDR source", "SOURCE_CONNECT_FAILED")
		return
	}

	conn, err := s.wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &streamWSClient{conn: conn}
	s.registerWSClient(streamID, client)
	defer s.unregisterWSClient(streamID, client)

	audioCh, unsubscribe, err := s.streamManager.Subscribe(streamID)
	if err != nil {
		_ = client.writeJSON(map[string]any{
			"type":  "error",
			"error": "stream is not active",
			"code":  "STREAM_NOT_ACTIVE",
		})
		return
	}
	defer unsubscribe()

	writeErr := make(chan struct{}, 1)
	go func() {
		for frame := range audioCh {
			packet := make([]byte, 1+len(frame))
			packet[0] = wsPacketTypeAudioPCM16
			copy(packet[1:], frame)
			if err := client.writeBinary(packet); err != nil {
				select {
				case writeErr <- struct{}{}:
				default:
				}
				return
			}
		}
		select {
		case writeErr <- struct{}{}:
		default:
		}
	}()

	client.writeJSON(map[string]any{
		"type":        "connected",
		"stream":      stream,
		"sample_rate": s.streamManager.SampleRate(streamID),
		"audio_type":  "pcm_s16le",
	})

	for {
		select {
		case <-writeErr:
			return
		default:
		}

		_, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg wsStreamMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			client.writeJSON(map[string]any{
				"type":  "error",
				"error": "invalid JSON payload",
				"code":  "VALIDATION",
			})
			continue
		}
		switch msg.Type {
		case "ping":
			client.writeJSON(map[string]any{"type": "pong"})
		case "patch":
			latest, err := s.db.GetStreamByID(r.Context(), streamID)
			if err != nil || latest == nil {
				client.writeJSON(map[string]any{
					"type":  "error",
					"error": "stream not found",
					"code":  "NOT_FOUND",
				})
				continue
			}
			updated, apiErr := s.applyPatchStream(r.Context(), latest, msg.Patch)
			if apiErr != nil {
				client.writeJSON(map[string]any{
					"type":  "error",
					"error": apiErr.Error,
					"code":  apiErr.Code,
				})
				continue
			}
			s.broadcastStreamEvent(streamID, map[string]any{
				"type":        "stream_updated",
				"stream":      updated,
				"sample_rate": s.streamManager.SampleRate(streamID),
			})
		default:
			client.writeJSON(map[string]any{
				"type":  "error",
				"error": "unsupported message type",
				"code":  "VALIDATION",
			})
		}
	}
}

func (s *Server) registerWSClient(streamID string, client *streamWSClient) {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	if _, ok := s.wsClients[streamID]; !ok {
		s.wsClients[streamID] = map[*streamWSClient]struct{}{}
	}
	s.wsClients[streamID][client] = struct{}{}
}

func (s *Server) unregisterWSClient(streamID string, client *streamWSClient) {
	s.wsMu.Lock()
	if clients, ok := s.wsClients[streamID]; ok {
		delete(clients, client)
		if len(clients) == 0 {
			delete(s.wsClients, streamID)
		}
	}
	s.wsMu.Unlock()
	_ = client.conn.Close()
}

func (s *Server) broadcastStreamEvent(streamID string, event map[string]any) {
	s.wsMu.RLock()
	clients := s.wsClients[streamID]
	copies := make([]*streamWSClient, 0, len(clients))
	for c := range clients {
		copies = append(copies, c)
	}
	s.wsMu.RUnlock()

	for _, c := range copies {
		_ = c.writeJSON(event)
	}
}

func (s *Server) closeWSClients(streamID string) {
	s.wsMu.RLock()
	clients := s.wsClients[streamID]
	copies := make([]*streamWSClient, 0, len(clients))
	for c := range clients {
		copies = append(copies, c)
	}
	s.wsMu.RUnlock()

	for _, c := range copies {
		_ = c.close()
	}
}

func (c *streamWSClient) writeJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(v)
}

func (c *streamWSClient) writeBinary(b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.BinaryMessage, b)
}

func (c *streamWSClient) close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.Close()
}
