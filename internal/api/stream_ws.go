package api

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/sammy/sdr-radio/internal/kiwi"
	"github.com/sammy/sdr-radio/internal/models"
	"github.com/sammy/sdr-radio/internal/streamlog"
)

type wsStreamMessage struct {
	Type      string             `json:"type"`
	Version   int64              `json:"version,omitempty"`
	Patch     patchStreamRequest `json:"patch"`
	SessionID string             `json:"session_id,omitempty"`
	Color     string             `json:"color,omitempty"`
	Topics    []string           `json:"topics,omitempty"`
	Field     string             `json:"field,omitempty"`
	Resume    map[string]struct {
		Version int64 `json:"version"`
	} `json:"resume,omitempty"`
	WFZoom      *int     `json:"zoom,omitempty"`
	WFCenterKHz *float64 `json:"center_khz,omitempty"`
	WFSpeed     *int     `json:"speed,omitempty"`
	ViewStartKHz *float64 `json:"start_khz,omitempty"`
	ViewEndKHz   *float64 `json:"end_khz,omitempty"`
	SourceID     string   `json:"source_id,omitempty"`
}

const (
	wsPacketTypeWaterfall = 0x01
	wsPacketTypeAudioPCM16 = 0x02
)

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
	if stream == nil || stream.TenantID != TenantID(r.Context()) {
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

	s.registerWSClient(streamID, client)
	s.streamLog.Wire(streamID, streamlog.LevelInfo, "ws.connect", "client", "wavetoy", fmt.Sprintf("session=%s", client.sessionID[:min(8, len(client.sessionID))]))
	defer func() {
		s.unregisterWSClient(streamID, client)
		s.streamLog.Wire(streamID, streamlog.LevelInfo, "ws.disconnect", "client", "wavetoy", fmt.Sprintf("session=%s", client.sessionID[:min(8, len(client.sessionID))]))
		s.broadcastStreamEvent(streamID, map[string]any{
			"type": "peer_left",
			"peer": map[string]string{"session_id": client.sessionID},
		})
	}()

	s.broadcastStreamEventExcluding(streamID, client, map[string]any{
		"type": "peer_joined",
		"peer": map[string]string{
			"session_id": client.sessionID,
			"color":      client.color,
		},
	})

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

	wfCh, wfUnsub, wfErr := s.streamManager.SubscribeWaterfall(streamID)
	if wfErr == nil {
		defer wfUnsub()
		go func() {
			for frame := range wfCh {
				packet := buildWFPacket(frame)
				if err := client.writeBinary(packet); err != nil {
					return
				}
			}
		}()
	} else {
		s.streamLog.Warn(streamID, "pump.wf.unavailable", fmt.Sprintf("err=%v", wfErr))
	}

	// Start structured log pump
	s.startLogPumpForClient(streamID, client)

	stream, _ = s.db.GetStreamByID(r.Context(), streamID)
	_ = client.writeJSON(map[string]any{
		"type":          "connected",
		"stream":        stream,
		"sample_rate":   s.streamManager.SampleRate(streamID),
		"audio_type":    "pcm_s16le",
		"peers":         s.getPeers(streamID),
		"max_freq_khz":  s.streamManager.MaxFreqKHz(streamID),
	})

	if firstMsg.Type != "hello" {
		s.handleWSMessage(r, streamID, client, firstMsg)
	}

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
			_ = client.writeJSON(map[string]any{
				"type":  "error",
				"error": "invalid JSON payload",
				"code":  "VALIDATION",
			})
			continue
		}
		s.handleWSMessage(r, streamID, client, msg)
	}
}

func (s *Server) handleWSMessage(r *http.Request, streamID string, client *streamWSClient, msg wsStreamMessage) {
	switch msg.Type {
	case "ping":
		_ = client.writeJSON(map[string]any{"type": "pong"})
	case "hello":
		// Already handled on connect
	case "focus":
		s.broadcastStreamEventExcluding(streamID, client, map[string]any{
			"type":       "peer_focus",
			"session_id": client.sessionID,
			"field":      msg.Field,
		})
	case "wf_config":
		zoom := 0
		if msg.WFZoom != nil {
			zoom = *msg.WFZoom
		}
		centerKHz := 15000.0
		if msg.WFCenterKHz != nil {
			centerKHz = *msg.WFCenterKHz
		}
		speed := 4
		if msg.WFSpeed != nil {
			speed = *msg.WFSpeed
		}
		if err := s.streamManager.ReconfigureWaterfall(streamID, zoom, centerKHz, speed); err != nil {
			s.streamLog.Warn(streamID, "wf.config.fail", fmt.Sprintf("err=%v", err))
		}
		if msg.ViewStartKHz != nil && msg.ViewEndKHz != nil {
			if err := s.db.UpdateStreamView(r.Context(), streamID, *msg.ViewStartKHz, *msg.ViewEndKHz); err != nil {
				s.streamLog.Warn(streamID, "wf.view.persist_fail", fmt.Sprintf("err=%v", err))
			}
			evt := map[string]any{
				"type":      "wf_view_changed",
				"start_khz": *msg.ViewStartKHz,
				"end_khz":   *msg.ViewEndKHz,
				"changed_by": map[string]string{
					"session_id": client.sessionID,
					"color":      client.color,
				},
			}
			if msg.WFZoom != nil {
				evt["zoom"] = *msg.WFZoom
			}
			if msg.WFCenterKHz != nil {
				evt["center_khz"] = *msg.WFCenterKHz
			}
			s.broadcastStreamEventExcluding(streamID, client, evt)
		}
	case "patch":
		latest, err := s.db.GetStreamByID(r.Context(), streamID)
		if err != nil || latest == nil {
			_ = client.writeJSON(map[string]any{
				"type":  "error",
				"error": "stream not found",
				"code":  "NOT_FOUND",
			})
			return
		}

		changedFields := collectChangedFields(latest, msg.Patch)
		updated, apiErr := s.applyPatchStream(r.Context(), latest, msg.Patch, msg.Version, client.sessionID[:min(8, len(client.sessionID))])
		if apiErr != nil {
			s.streamLog.Wire(streamID, streamlog.LevelWarn, "ws.error", "wavetoy", "client", fmt.Sprintf("%s: %s", apiErr.Code, apiErr.Error))
			resp := map[string]any{
				"type":  "error",
				"error": apiErr.Error,
				"code":  apiErr.Code,
			}
			if apiErr.Code == "CONFLICT" {
				resp["current_version"] = latest.Version
				resp["stream"] = latest
			}
			_ = client.writeJSON(resp)
			return
		}
		s.broadcastStreamEvent(streamID, map[string]any{
			"type":        "stream_updated",
			"stream":      updated,
			"sample_rate": s.streamManager.SampleRate(streamID),
			"changed_by": map[string]string{
				"session_id": client.sessionID,
				"color":      client.color,
			},
			"changed_fields": changedFields,
		})
	default:
		_ = client.writeJSON(map[string]any{
			"type":  "error",
			"error": "unsupported message type",
			"code":  "VALIDATION",
		})
	}
}

func collectChangedFields(existing *models.Stream, patch patchStreamRequest) []string {
	var fields []string
	if patch.SourceID != nil && *patch.SourceID != existing.SourceID {
		fields = append(fields, "source_id")
	}
	if patch.FrequencyKHz != nil && *patch.FrequencyKHz != existing.FrequencyKHz {
		fields = append(fields, "frequency_khz")
	}
	if patch.Mode != nil && strings.ToLower(*patch.Mode) != existing.Mode {
		fields = append(fields, "mode")
	}
	if patch.BandwidthLowHz != nil && *patch.BandwidthLowHz != existing.BandwidthLowHz {
		fields = append(fields, "bandwidth_low_hz")
	}
	if patch.BandwidthHighHz != nil && *patch.BandwidthHighHz != existing.BandwidthHighHz {
		fields = append(fields, "bandwidth_high_hz")
	}
	if patch.Name != nil && *patch.Name != existing.Name {
		fields = append(fields, "name")
	}
	if patch.AGCOn != nil && *patch.AGCOn != existing.AGCOn {
		fields = append(fields, "agc_on")
	}
	if patch.AGCGainDB != nil {
		fields = append(fields, "agc_gain_db")
	}
	if patch.BufferMinutes != nil && *patch.BufferMinutes != existing.BufferMinutes {
		fields = append(fields, "buffer_minutes")
	}
	if patch.Filters != nil {
		fields = append(fields, "filters")
	}
	if patch.Interpreter != nil {
		fields = append(fields, "interpreter")
	}
	if patch.ViewLocked != nil && *patch.ViewLocked != existing.ViewLocked {
		fields = append(fields, "view_locked")
	}
	return fields
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

func (s *Server) BroadcastToStream(streamID string, event map[string]any) {
	s.broadcastStreamEvent(streamID, event)
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

	s.registry.broadcast("stream:"+streamID, event)

	if event["type"] == "stream_updated" {
		s.registry.broadcast("streams", event)
	}
}

func (s *Server) broadcastStreamEventExcluding(streamID string, exclude *streamWSClient, event map[string]any) {
	s.wsMu.RLock()
	clients := s.wsClients[streamID]
	copies := make([]*streamWSClient, 0, len(clients))
	for c := range clients {
		if c != exclude {
			copies = append(copies, c)
		}
	}
	s.wsMu.RUnlock()
	for _, c := range copies {
		_ = c.writeJSON(event)
	}

	s.registry.broadcastExcluding("stream:"+streamID, exclude, event)
}

func (s *Server) getPeers(streamID string) []map[string]string {
	seen := make(map[string]struct{})
	var peers []map[string]string

	s.wsMu.RLock()
	for c := range s.wsClients[streamID] {
		if _, dup := seen[c.sessionID]; !dup {
			seen[c.sessionID] = struct{}{}
			peers = append(peers, map[string]string{
				"session_id": c.sessionID,
				"color":      c.color,
			})
		}
	}
	s.wsMu.RUnlock()

	for _, c := range s.registry.peers("stream:" + streamID) {
		if _, dup := seen[c.sessionID]; !dup {
			seen[c.sessionID] = struct{}{}
			peers = append(peers, map[string]string{
				"session_id": c.sessionID,
				"color":      c.color,
			})
		}
	}
	return peers
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

const wsWriteTimeout = 5 * time.Second

func (c *streamWSClient) writeJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	start := time.Now()
	err := c.conn.WriteJSON(v)
	elapsed := time.Since(start)
	if err == nil {
		c.lastWriteAt.Store(time.Now().UnixMilli())
		_ = c.conn.SetWriteDeadline(time.Time{})
	}
	if elapsed > 500*time.Millisecond {
		log.Printf("[WS] SLOW writeJSON session=%s elapsed=%s err=%v", c.sessionID[:min(8, len(c.sessionID))], elapsed, err)
	}
	return err
}

func (c *streamWSClient) writeBinary(b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	start := time.Now()
	err := c.conn.WriteMessage(websocket.BinaryMessage, b)
	elapsed := time.Since(start)
	if err == nil {
		c.lastWriteAt.Store(time.Now().UnixMilli())
		_ = c.conn.SetWriteDeadline(time.Time{})
	}
	if elapsed > 500*time.Millisecond {
		log.Printf("[WS] SLOW writeBinary session=%s elapsed=%s len=%d err=%v", c.sessionID[:min(8, len(c.sessionID))], elapsed, len(b), err)
	}
	return err
}

func (c *streamWSClient) close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.Close()
}

// buildWFPacket encodes a waterfall frame for the browser:
// [0x01][xbin u32 LE][zoom u16 LE][flags u16 LE][bins...]
func buildWFPacket(frame kiwi.WFFrame) []byte {
	packet := make([]byte, 1+4+2+2+len(frame.Bins))
	packet[0] = wsPacketTypeWaterfall
	binary.LittleEndian.PutUint32(packet[1:5], frame.XBin)
	binary.LittleEndian.PutUint16(packet[5:7], frame.Zoom)
	binary.LittleEndian.PutUint16(packet[7:9], frame.Flags)
	copy(packet[9:], frame.Bins)
	return packet
}

func entryToWSPayload(e streamlog.Entry) map[string]any {
	m := map[string]any{
		"type":   "stream_log",
		"t":      e.Time.UnixMilli(),
		"level":  string(e.Level),
		"action": e.Action,
	}
	if e.From != "" {
		m["from"] = e.From
	}
	if e.To != "" {
		m["to"] = e.To
	}
	if e.Message != "" {
		m["msg"] = e.Message
	}
	return m
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
