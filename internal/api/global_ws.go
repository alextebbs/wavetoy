package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/sammy/sdr-radio/internal/db"
)

func (s *Server) globalWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &streamWSClient{conn: conn}

	_, firstPayload, firstErr := conn.ReadMessage()
	if firstErr != nil {
		_ = conn.Close()
		return
	}
	var firstMsg wsStreamMessage
	if err := json.Unmarshal(firstPayload, &firstMsg); err != nil {
		_ = client.writeJSON(map[string]any{
			"type":  "error",
			"error": "invalid JSON payload",
			"code":  "VALIDATION",
		})
		_ = conn.Close()
		return
	}
	if firstMsg.Type == "hello" {
		client.sessionID = firstMsg.SessionID
		client.color = firstMsg.Color
	}
	if client.sessionID == "" {
		client.sessionID = fmt.Sprintf("anon-%d", time.Now().UnixNano())
	}
	if client.color == "" {
		client.color = "#888888"
	}
	client.joinedAt = time.Now()

	// Deduplicate: close any stale connection with the same session ID
	s.evictStaleSession(client)

	defer func() {
		topics := s.registry.unsubscribeAll(client)
		for _, topic := range topics {
			if strings.HasPrefix(topic, "stream:") {
				s.registry.broadcast(topic, map[string]any{
					"type": "peer_left",
					"peer": map[string]string{"session_id": client.sessionID},
				})
			}
		}
		_ = conn.Close()
	}()

	// Handle resume: if the hello contained resume data, auto-subscribe
	// to those topics and only send state if the version has changed.
	resumeTopics := make([]string, 0)
	if firstMsg.Type == "hello" && firstMsg.Resume != nil {
		for topic, rv := range firstMsg.Resume {
			resumeTopics = append(resumeTopics, topic)
			s.registry.subscribe(client, topic)

			if strings.HasPrefix(topic, "stream:") {
				streamID := strings.TrimPrefix(topic, "stream:")
				stream, err := s.db.GetStreamByID(r.Context(), streamID)
				if err != nil || stream == nil {
					continue
				}
				if err := s.streamManager.EnsureRunning(r.Context(), *stream); err != nil {
					log.Printf("[WS] failed to ensure stream running for topic %s: %v", topic, err)
				}

				s.registry.broadcastExcluding(topic, client, map[string]any{
					"type": "peer_joined",
					"peer": map[string]string{
						"session_id": client.sessionID,
						"color":      client.color,
					},
				})

				if stream.Version != rv.Version {
					peers := s.registry.peers(topic)
					peerList := make([]map[string]string, 0, len(peers))
					for _, p := range peers {
						peerList = append(peerList, map[string]string{
							"session_id": p.sessionID,
							"color":      p.color,
						})
					}
					_ = client.writeJSON(map[string]any{
						"type":          "connected",
						"stream":        stream,
						"sample_rate":   s.streamManager.SampleRate(streamID),
						"audio_type":    "pcm_s16le",
						"peers":         peerList,
						"max_freq_khz":  s.streamManager.MaxFreqKHz(streamID),
					})
				} else {
					peers := s.registry.peers(topic)
					peerList := make([]map[string]string, 0, len(peers))
					for _, p := range peers {
						peerList = append(peerList, map[string]string{
							"session_id": p.sessionID,
							"color":      p.color,
						})
					}
					_ = client.writeJSON(map[string]any{
						"type":  "connected",
						"peers": peerList,
					})
				}

				s.startAudioPumpForClient(streamID, client)
			}
		}
	}

	_ = client.writeJSON(map[string]any{
		"type":          "connected",
		"subscriptions": resumeTopics,
	})

	if firstMsg.Type != "hello" {
		s.handleGlobalWSMessage(r, client, firstMsg)
	}

	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg wsStreamMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			_ = client.writeJSON(map[string]any{
				"type":  "error",
				"error": "invalid JSON payload",
				"code":  "VALIDATION",
			})
			continue
		}
		s.handleGlobalWSMessage(r, client, msg)
	}
}

func (s *Server) handleGlobalWSMessage(r *http.Request, client *streamWSClient, msg wsStreamMessage) {
	switch msg.Type {
	case "ping":
		_ = client.writeJSON(map[string]any{"type": "pong"})

	case "hello":
		// Already handled

	case "subscribe":
		for _, topic := range msg.Topics {
			topic = strings.TrimSpace(topic)
			if topic == "" {
				continue
			}
			s.registry.subscribe(client, topic)

			if strings.HasPrefix(topic, "stream:") {
				streamID := strings.TrimPrefix(topic, "stream:")
				stream, err := s.db.GetStreamByID(r.Context(), streamID)
				if err != nil || stream == nil || stream.TenantID != db.DefaultTenantID {
					_ = client.writeJSON(map[string]any{
						"type":  "error",
						"error": "stream not found for topic " + topic,
						"code":  "NOT_FOUND",
					})
					continue
				}

				if err := s.streamManager.EnsureRunning(r.Context(), *stream); err != nil {
					log.Printf("[WS] failed to ensure stream running for topic %s: %v", topic, err)
				}

				s.registry.broadcastExcluding(topic, client, map[string]any{
					"type": "peer_joined",
					"peer": map[string]string{
						"session_id": client.sessionID,
						"color":      client.color,
					},
				})

				peers := s.registry.peers(topic)
				peerList := make([]map[string]string, 0, len(peers))
				for _, p := range peers {
					peerList = append(peerList, map[string]string{
						"session_id": p.sessionID,
						"color":      p.color,
					})
				}

				_ = client.writeJSON(map[string]any{
					"type":          "connected",
					"stream":        stream,
					"sample_rate":   s.streamManager.SampleRate(streamID),
					"audio_type":    "pcm_s16le",
					"peers":         peerList,
					"max_freq_khz":  s.streamManager.MaxFreqKHz(streamID),
				})

				s.startAudioPumpForClient(streamID, client)
			}
		}

	case "unsubscribe":
		for _, topic := range msg.Topics {
			topic = strings.TrimSpace(topic)
			s.registry.unsubscribe(client, topic)
			if strings.HasPrefix(topic, "stream:") {
				s.registry.broadcast(topic, map[string]any{
					"type": "peer_left",
					"peer": map[string]string{"session_id": client.sessionID},
				})
			}
		}

	case "patch":
		// Find the stream topic this client is subscribed to
		streamID := s.findStreamTopicForClient(client)
		if streamID == "" {
			_ = client.writeJSON(map[string]any{
				"type":  "error",
				"error": "not subscribed to any stream topic",
				"code":  "VALIDATION",
			})
			return
		}
		s.handleWSMessage(r, streamID, client, msg)

	case "wf_config":
		streamID := s.findStreamTopicForClient(client)
		if streamID == "" {
			return
		}
		s.handleWSMessage(r, streamID, client, msg)

	case "focus":
		streamID := s.findStreamTopicForClient(client)
		if streamID == "" {
			return
		}
		topic := "stream:" + streamID
		s.registry.broadcastExcluding(topic, client, map[string]any{
			"type":       "peer_focus",
			"session_id": client.sessionID,
			"field":      msg.Field,
		})

	default:
		_ = client.writeJSON(map[string]any{
			"type":  "error",
			"error": "unsupported message type",
			"code":  "VALIDATION",
		})
	}
}

func (s *Server) findStreamTopicForClient(client *streamWSClient) string {
	s.registry.mu.RLock()
	defer s.registry.mu.RUnlock()
	for topic, clients := range s.registry.topics {
		if strings.HasPrefix(topic, "stream:") {
			if _, ok := clients[client]; ok {
				return strings.TrimPrefix(topic, "stream:")
			}
		}
	}
	return ""
}

func (s *Server) startAudioPumpForClient(streamID string, client *streamWSClient) {
	audioCh, unsubscribe, err := s.streamManager.Subscribe(streamID)
	if err != nil {
		return
	}

	go func() {
		defer unsubscribe()
		for frame := range audioCh {
			packet := make([]byte, 1+len(frame))
			packet[0] = wsPacketTypeAudioPCM16
			copy(packet[1:], frame)
			if err := client.writeBinary(packet); err != nil {
				return
			}
		}
	}()

	s.startWaterfallPumpForClient(streamID, client)
}

func (s *Server) startWaterfallPumpForClient(streamID string, client *streamWSClient) {
	wfCh, unsubscribe, err := s.streamManager.SubscribeWaterfall(streamID)
	if err != nil {
		return
	}

	go func() {
		defer unsubscribe()
		for frame := range wfCh {
			packet := buildWFPacket(frame)
			if err := client.writeBinary(packet); err != nil {
				return
			}
		}
	}()
}

func (s *Server) evictStaleSession(newClient *streamWSClient) {
	s.registry.mu.RLock()
	var stale []*streamWSClient
	for _, clients := range s.registry.topics {
		for c := range clients {
			if c != newClient && c.sessionID == newClient.sessionID {
				stale = append(stale, c)
			}
		}
	}
	s.registry.mu.RUnlock()

	for _, c := range stale {
		_ = c.close()
	}
}

// BroadcastSourceUpdated is called by the health checker to notify subscribers.
func (s *Server) BroadcastSourceUpdated(source any) {
	s.registry.broadcast("sources", map[string]any{
		"type":   "source_updated",
		"source": source,
	})
}

// BroadcastStreamCreated notifies clients subscribed to the "streams" topic.
func (s *Server) BroadcastStreamCreated(stream any) {
	s.registry.broadcast("streams", map[string]any{
		"type":   "stream_created",
		"stream": stream,
	})
}

// BroadcastStreamDeleted notifies clients subscribed to the "streams" topic.
func (s *Server) BroadcastStreamDeleted(streamID string) {
	s.registry.broadcast("streams", map[string]any{
		"type":      "stream_deleted",
		"stream_id": streamID,
	})
}
