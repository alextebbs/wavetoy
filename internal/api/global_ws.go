package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/sammy/sdr-radio/internal/streamlog"
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

	s.evictStaleSession(client)

	defer func() {
		topics := s.registry.unsubscribeAll(client)
		for _, topic := range topics {
			if strings.HasPrefix(topic, "stream:") {
				streamID := strings.TrimPrefix(topic, "stream:")
				s.streamLog.Wire(streamID, streamlog.LevelInfo, "ws.disconnect", "client", "wavetoy", fmt.Sprintf("session=%s", client.sessionID[:min(8, len(client.sessionID))]))
				s.registry.broadcast(topic, map[string]any{
					"type": "peer_left",
					"peer": map[string]string{"session_id": client.sessionID},
				})
			}
		}
		_ = conn.Close()
	}()

	resumeTopics := make([]string, 0)
	if firstMsg.Type == "hello" && firstMsg.Resume != nil {
		for topic, rv := range firstMsg.Resume {
			resumeTopics = append(resumeTopics, topic)
			s.registry.subscribe(client, topic)

			if strings.HasPrefix(topic, "stream:") {
				streamID := strings.TrimPrefix(topic, "stream:")
				s.streamLog.Wire(streamID, streamlog.LevelInfo, "ws.resume", "client", "wavetoy", fmt.Sprintf("session=%s", client.sessionID[:min(8, len(client.sessionID))]))

				s.startLogPumpForClient(streamID, client)

				stream, err := s.db.GetStreamByID(r.Context(), streamID)
				if err != nil || stream == nil {
					continue
				}
				if err := s.streamManager.EnsureRunning(r.Context(), *stream); err != nil {
					s.streamLog.Warn(streamID, "stream.ensure_running.fail", fmt.Sprintf("err=%v", err))
				}

				if fresh, err := s.db.GetStreamByID(r.Context(), streamID); err == nil && fresh != nil {
					stream = fresh
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
			log.Printf("[WS] read error session=%s: %v", client.sessionID[:min(8, len(client.sessionID))], err)
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
				s.streamLog.Wire(streamID, streamlog.LevelInfo, "ws.connect", "client", "wavetoy", fmt.Sprintf("session=%s", client.sessionID[:min(8, len(client.sessionID))]))

				s.startLogPumpForClient(streamID, client)

				stream, err := s.db.GetStreamByID(r.Context(), streamID)
				if err != nil || stream == nil || stream.TenantID != TenantID(r.Context()) {
					_ = client.writeJSON(map[string]any{
						"type":  "error",
						"error": "stream not found for topic " + topic,
						"code":  "NOT_FOUND",
					})
					continue
				}

				if err := s.streamManager.EnsureRunning(r.Context(), *stream); err != nil {
					s.streamLog.Warn(streamID, "stream.ensure_running.fail", fmt.Sprintf("err=%v", err))
				}

				if fresh, err := s.db.GetStreamByID(r.Context(), streamID); err == nil && fresh != nil {
					stream = fresh
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
				streamID := strings.TrimPrefix(topic, "stream:")
				s.streamLog.Wire(streamID, streamlog.LevelInfo, "ws.disconnect", "client", "wavetoy", fmt.Sprintf("session=%s (unsubscribe)", client.sessionID[:min(8, len(client.sessionID))]))
				s.registry.broadcast(topic, map[string]any{
					"type": "peer_left",
					"peer": map[string]string{"session_id": client.sessionID},
				})
			}
		}

	case "patch":
		streamID := s.findStreamTopicForClient(client)
		if streamID == "" {
			log.Printf("[WS] patch rejected: session=%s has no stream subscription", client.sessionID[:min(8, len(client.sessionID))])
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

	case "switch_fallback":
		streamID := s.findStreamTopicForClient(client)
		if streamID == "" {
			_ = client.writeJSON(map[string]any{
				"type":  "error",
				"error": "not subscribed to any stream topic",
				"code":  "VALIDATION",
			})
			return
		}
		if msg.SourceID == "" {
			_ = client.writeJSON(map[string]any{
				"type":  "error",
				"error": "source_id is required",
				"code":  "VALIDATION",
			})
			return
		}
		s.handleSwitchFallback(r, streamID, msg.SourceID, client)

	case "reprobe_fallbacks":
		streamID := s.findStreamTopicForClient(client)
		if streamID == "" {
			_ = client.writeJSON(map[string]any{
				"type":  "error",
				"error": "not subscribed to any stream topic",
				"code":  "VALIDATION",
			})
			return
		}
		if s.fallbackManager != nil {
			s.fallbackManager.Reprobe(r.Context(), streamID)
		}

	default:
		_ = client.writeJSON(map[string]any{
			"type":  "error",
			"error": "unsupported message type",
			"code":  "VALIDATION",
		})
	}
}

func (s *Server) handleSwitchFallback(r *http.Request, streamID, sourceID string, client *streamWSClient) {
	existing, err := s.db.GetStreamByID(r.Context(), streamID)
	if err != nil || existing == nil {
		_ = client.writeJSON(map[string]any{
			"type":  "error",
			"error": "stream not found",
			"code":  "NOT_FOUND",
		})
		return
	}

	prevSourceID := existing.SourceID

	patchReq := patchStreamRequest{SourceID: &sourceID}
	stream, apiErr := s.applyPatchStream(r.Context(), existing, patchReq, 0, client.sessionID[:min(8, len(client.sessionID))])
	if apiErr != nil {
		_ = client.writeJSON(map[string]any{
			"type":  "error",
			"error": apiErr.Error,
			"code":  apiErr.Code,
		})
		return
	}

	s.broadcastStreamEvent(stream.ID, map[string]any{
		"type":        "stream_updated",
		"stream":      stream,
		"sample_rate": s.streamManager.SampleRate(stream.ID),
	})

	if s.fallbackManager != nil && stream.AutoFallback && prevSourceID != sourceID {
		go s.fallbackManager.NotifySwitch(r.Context(), streamID, prevSourceID, sourceID)
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
	sid := client.sessionID[:min(8, len(client.sessionID))]

	audioCh, unsubscribe, err := s.streamManager.Subscribe(streamID)
	if err != nil {
		s.streamLog.Wire(streamID, streamlog.LevelWarn, "pump.audio.fail", "wavetoy", "client",
			fmt.Sprintf("session=%s err=%v", sid, err))
		return
	}
	s.streamLog.Debug(streamID, "pump.audio.start", fmt.Sprintf("session=%s", sid))
	client.lastWriteAt.Store(time.Now().UnixMilli())

	go func() {
		defer unsubscribe()
		defer s.streamLog.Debug(streamID, "pump.audio.stop", fmt.Sprintf("session=%s", sid))

		watchdog := time.NewTicker(10 * time.Second)
		defer watchdog.Stop()

		for {
			select {
			case frame, ok := <-audioCh:
				if !ok {
					s.streamLog.Debug(streamID, "pump.audio.chan_closed", fmt.Sprintf("session=%s", sid))
					return
				}
				packet := make([]byte, 1+len(frame))
				packet[0] = wsPacketTypeAudioPCM16
				copy(packet[1:], frame)
				if err := client.writeBinary(packet); err != nil {
					s.streamLog.Wire(streamID, streamlog.LevelError, "pump.audio.write_err", "wavetoy", "client",
						fmt.Sprintf("session=%s err=%v", sid, err))
					return
				}
			case <-watchdog.C:
				lastMs := client.lastWriteAt.Load()
				if lastMs > 0 {
					staleSec := float64(time.Now().UnixMilli()-lastMs) / 1000.0
					if staleSec > 5 {
						s.streamLog.Wire(streamID, streamlog.LevelWarn, "pump.stale", "wavetoy", "client",
							fmt.Sprintf("session=%s last_write=%.1fs_ago", sid, staleSec))
					}
				}
			}
		}
	}()

	s.startWaterfallPumpForClient(streamID, client)
}

func (s *Server) startWaterfallPumpForClient(streamID string, client *streamWSClient) {
	sid := client.sessionID[:min(8, len(client.sessionID))]

	wfCh, unsubscribe, err := s.streamManager.SubscribeWaterfall(streamID)
	if err != nil {
		s.streamLog.Wire(streamID, streamlog.LevelWarn, "pump.wf.fail", "wavetoy", "client",
			fmt.Sprintf("session=%s err=%v", sid, err))
		return
	}
	s.streamLog.Debug(streamID, "pump.wf.start", fmt.Sprintf("session=%s", sid))

	go func() {
		defer unsubscribe()
		defer s.streamLog.Debug(streamID, "pump.wf.stop", fmt.Sprintf("session=%s", sid))
		for frame := range wfCh {
			packet := buildWFPacket(frame)
			if err := client.writeBinary(packet); err != nil {
				s.streamLog.Wire(streamID, streamlog.LevelError, "pump.wf.write_err", "wavetoy", "client",
					fmt.Sprintf("session=%s err=%v", sid, err))
				return
			}
		}
	}()
}

func (s *Server) startLogPumpForClient(streamID string, client *streamWSClient) {
	sid := client.sessionID[:min(8, len(client.sessionID))]
	// Send log history first
	history := s.streamLog.Snapshot(streamID, s.streamLog.GetLevel(streamID), 2000)
	if len(history) > 0 {
		entries := make([]map[string]any, len(history))
		for i, e := range history {
			entries[i] = entryToWSPayload(e)
			entries[i]["type"] = "stream_log_entry"
		}
		_ = client.writeJSON(map[string]any{
			"type":    "stream_log_history",
			"entries": entries,
		})
	}

	// Subscribe for live updates
	logCh, unsubscribe, err := s.streamLog.Subscribe(streamID)
	if err != nil {
		return
	}

	go func() {
		defer unsubscribe()
		for entry := range logCh {
			payload := entryToWSPayload(entry)
			if err := client.writeJSON(payload); err != nil {
				s.streamLog.Wire(streamID, streamlog.LevelError, "pump.log.write_err", "wavetoy", "client",
					fmt.Sprintf("session=%s err=%v", sid, err))
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
		log.Printf("[WS] evicting stale session=%s (joined %s ago)", c.sessionID[:min(8, len(c.sessionID))], time.Since(c.joinedAt).Round(time.Millisecond))
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
