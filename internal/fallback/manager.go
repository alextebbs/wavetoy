package fallback

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/models"
	"github.com/sammy/sdr-radio/internal/streamlog"
	srcsync "github.com/sammy/sdr-radio/internal/sync"
)

const (
	ProbeCycleInterval      = 5 * time.Minute
	MaxConcurrentProbes     = 3
	ReferenceSnapshotFrames = 72
	TopSuggestions          = 3
)

type SnapshotResult struct {
	Snapshot   AudioSnapshot
	RawPCM    []byte
	SampleRate int
}

type StreamReconfigurer interface {
	Reconfigure(ctx context.Context, stream models.Stream) error
	CollectSnapshot(ctx context.Context, streamID string, duration time.Duration, stream models.Stream) (SnapshotResult, error)
}

func (s SnapshotResult) HasAudio() bool {
	return len(s.RawPCM) > 0
}

type BroadcastFunc func(streamID string, event map[string]any)

type Manager struct {
	db            *db.DB
	log           *streamlog.Logger
	healthChecker *srcsync.HealthChecker
	reconfigurer  StreamReconfigurer
	broadcast     BroadcastFunc
	probeSem      chan struct{}

	mu       sync.RWMutex
	sessions map[string]*fallbackSession
}

type fallbackSession struct {
	streamID string
	manager  *Manager

	mu          sync.RWMutex
	suggestions []*FallbackSuggestion
	probeTotal  int
	probesDone  int

	cancel context.CancelFunc
	done   chan struct{}
}

func NewManager(database *db.DB, logger *streamlog.Logger, hc *srcsync.HealthChecker, reconfigurer StreamReconfigurer, broadcast BroadcastFunc) *Manager {
	return &Manager{
		db:            database,
		log:           logger,
		healthChecker: hc,
		reconfigurer:  reconfigurer,
		broadcast:     broadcast,
		probeSem:      make(chan struct{}, MaxConcurrentProbes),
		sessions:      make(map[string]*fallbackSession),
	}
}

func (m *Manager) Enable(ctx context.Context, streamID string) {
	m.mu.Lock()
	if _, exists := m.sessions[streamID]; exists {
		m.mu.Unlock()
		return
	}

	sessionCtx, cancel := context.WithCancel(context.Background())
	session := &fallbackSession{
		streamID: streamID,
		manager:  m,
		cancel:   cancel,
		done:     make(chan struct{}),
	}
	m.sessions[streamID] = session
	m.mu.Unlock()

	m.log.Info(streamID, "fb.enable", "fallback probing enabled")
	go session.run(sessionCtx)
}

func (m *Manager) Disable(ctx context.Context, streamID string) {
	m.mu.Lock()
	session, exists := m.sessions[streamID]
	if exists {
		delete(m.sessions, streamID)
	}
	m.mu.Unlock()

	if !exists {
		return
	}

	session.cancel()
	<-session.done

	m.log.Info(streamID, "fb.disable", "periodic fallback probing disabled (suggestions preserved)")
}

func (m *Manager) Reprobe(ctx context.Context, streamID string) {
	m.mu.RLock()
	session, exists := m.sessions[streamID]
	m.mu.RUnlock()

	if err := m.db.DeleteFallbackSuggestions(ctx, streamID); err != nil {
		m.log.Warn(streamID, "fb.reprobe", fmt.Sprintf("delete suggestions failed: %v", err))
	}

	m.broadcastSuggestions(streamID, nil)

	if exists {
		session.cancel()
		<-session.done
	}

	stream, err := m.db.GetStreamByID(ctx, streamID)
	if err != nil || stream == nil {
		m.log.Warn(streamID, "fb.reprobe", fmt.Sprintf("cannot load stream: %v", err))
		return
	}

	periodic := stream.AutoFallback

	m.mu.Lock()
	sessionCtx, cancel := context.WithCancel(context.Background())
	newSession := &fallbackSession{
		streamID: streamID,
		manager:  m,
		cancel:   cancel,
		done:     make(chan struct{}),
	}
	m.sessions[streamID] = newSession
	m.mu.Unlock()

	if periodic {
		m.log.Info(streamID, "fb.reprobe", "starting periodic probe cycle")
		go newSession.run(sessionCtx)
	} else {
		m.log.Info(streamID, "fb.reprobe", "running one-shot probe cycle")
		go newSession.runOnce(sessionCtx)
	}
}

func (m *Manager) GetSuggestions(ctx context.Context, streamID string) ([]*FallbackSuggestion, error) {
	rows, err := m.db.ListFallbackSuggestions(ctx, streamID)
	if err != nil {
		return nil, err
	}

	var srcLat, srcLon float64
	var hasSrcCoords bool
	stream, err := m.db.GetStreamByID(ctx, streamID)
	if err == nil && stream != nil {
		src, err := m.db.GetSourceByID(ctx, stream.SourceID)
		if err == nil && src != nil && src.Latitude != nil && src.Longitude != nil {
			srcLat, srcLon = *src.Latitude, *src.Longitude
			hasSrcCoords = true
		}
	}

	var suggestions []*FallbackSuggestion
	for _, r := range rows {
		var pm ProbeMetrics
		if len(r.ProbeMetrics) > 0 {
			_ = json.Unmarshal(r.ProbeMetrics, &pm)
		}
		var bearing float64
		if hasSrcCoords {
			candidateSrc, err := m.db.GetSourceByID(ctx, r.SourceID)
			if err == nil && candidateSrc != nil && candidateSrc.Latitude != nil && candidateSrc.Longitude != nil {
				bearing = BearingDeg(srcLat, srcLon, *candidateSrc.Latitude, *candidateSrc.Longitude)
			}
		}
		suggestions = append(suggestions, &FallbackSuggestion{
			StreamID:     r.StreamID,
			SourceID:     r.SourceID,
			SourceName:   r.SourceName,
			SourceHost:   r.SourceHost,
			SourcePort:   r.SourcePort,
			Rank:         r.Rank,
			Score:        r.Score,
			DistanceKm:   r.DistanceKm,
			BearingDeg:   bearing,
			LastProbed:   r.LastProbed,
			ProbeMetrics: pm,
		})
	}
	return suggestions, nil
}

func (m *Manager) OnStreamUpdated(stream models.Stream, sourceChanged bool) {
	m.mu.RLock()
	_, exists := m.sessions[stream.ID]
	m.mu.RUnlock()

	if !exists {
		if stream.AutoFallback {
			m.Enable(context.Background(), stream.ID)
		}
		return
	}

	if !stream.AutoFallback {
		m.Disable(context.Background(), stream.ID)
		return
	}

	if sourceChanged {
		m.Reprobe(context.Background(), stream.ID)
	}
}

func (m *Manager) IsEnabled(streamID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, exists := m.sessions[streamID]
	return exists
}

func (m *Manager) HandleDegraded(streamID, reason string) {
	m.mu.RLock()
	session, exists := m.sessions[streamID]
	m.mu.RUnlock()

	if !exists {
		return
	}

	session.mu.RLock()
	suggestions := session.suggestions
	session.mu.RUnlock()

	if len(suggestions) == 0 {
		m.log.Warn(streamID, "quality.degraded", fmt.Sprintf("reason=%s but no fallback suggestions available", reason))
		return
	}

	top := suggestions[0]
	m.log.Warn(streamID, "fb.failover", fmt.Sprintf("reason=%s target=%s score=%.2f", reason, top.SourceID, top.Score))

	stream, err := m.db.GetStreamByID(context.Background(), streamID)
	if err != nil || stream == nil {
		m.log.Error(streamID, "fb.failover", fmt.Sprintf("cannot load stream: %v", err))
		return
	}

	prevSourceID := stream.SourceID
	stream.SourceID = top.SourceID
	if err := m.reconfigurer.Reconfigure(context.Background(), *stream); err != nil {
		m.log.Error(streamID, "fb.failover", fmt.Sprintf("reconfigure failed: %v", err))
		return
	}

	m.log.Info(streamID, "source.switch", fmt.Sprintf("%s → %s (auto, reason=%s)", prevSourceID, top.SourceID, reason))
	m.broadcastSwitch(streamID, prevSourceID, top.SourceID, reason)
	m.ClearSuggestions(streamID)
}

// NotifySwitch is called after a manual source switch to clear stale suggestions.
func (m *Manager) NotifySwitch(ctx context.Context, streamID, fromSourceID, toSourceID string) {
	m.log.Info(streamID, "source.switch", fmt.Sprintf("%s → %s (manual)", fromSourceID, toSourceID))
	m.broadcastSwitch(streamID, fromSourceID, toSourceID, "manual")
	m.ClearSuggestions(streamID)
}

// ClearSuggestions removes in-memory suggestions and broadcasts an empty list.
func (m *Manager) ClearSuggestions(streamID string) {
	m.mu.RLock()
	session, exists := m.sessions[streamID]
	m.mu.RUnlock()
	if exists {
		session.mu.Lock()
		session.suggestions = nil
		session.mu.Unlock()
	}
	m.broadcastSuggestions(streamID, nil)
}

func (m *Manager) broadcastSuggestions(streamID string, suggestions []*FallbackSuggestion) {
	if m.broadcast == nil {
		return
	}
	m.broadcast(streamID, map[string]any{
		"type":        "fallback_updated",
		"stream_id":   streamID,
		"suggestions": suggestions,
	})
}

func (m *Manager) broadcastProbeProgress(streamID string, total, probed int) {
	if m.broadcast == nil {
		return
	}
	m.broadcast(streamID, map[string]any{
		"type":              "fallback_probing",
		"stream_id":         streamID,
		"candidates_total":  total,
		"candidates_probed": probed,
	})
}

func (m *Manager) broadcastSwitch(streamID, fromSourceID, toSourceID, reason string) {
	if m.broadcast == nil {
		return
	}
	payload := map[string]any{
		"type":           "fallback_switch",
		"stream_id":      streamID,
		"from_source_id": fromSourceID,
		"to_source_id":   toSourceID,
		"reason":         reason,
	}
	src, err := m.db.GetSourceByID(context.Background(), fromSourceID)
	if err == nil && src != nil {
		payload["from_source_host"] = src.Host
		payload["from_source_port"] = src.Port
	}
	m.broadcast(streamID, payload)
}

func (s *fallbackSession) run(ctx context.Context) {
	defer close(s.done)

	s.runCycle(ctx)

	ticker := time.NewTicker(ProbeCycleInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runCycle(ctx)
		}
	}
}

func (s *fallbackSession) runOnce(ctx context.Context) {
	defer close(s.done)
	s.runCycle(ctx)
}

func (s *fallbackSession) runCycle(ctx context.Context) {
	stream, err := s.manager.db.GetStreamByID(ctx, s.streamID)
	if err != nil || stream == nil {
		s.manager.log.Error(s.streamID, "fb.cycle", fmt.Sprintf("cannot load stream: %v", err))
		return
	}

	currentSource, err := s.manager.db.GetSourceByID(ctx, stream.SourceID)
	if err != nil || currentSource == nil {
		s.manager.log.Error(s.streamID, "fb.cycle", fmt.Sprintf("cannot load source=%s: %v", stream.SourceID, err))
		return
	}

	candidates, err := DiscoverCandidates(ctx, s.manager.db, *currentSource, currentSource.ID, DefaultMaxCandidates, DefaultMaxRadiusKm)
	if err != nil {
		s.manager.log.Error(s.streamID, "fb.discover", fmt.Sprintf("failed: %v", err))
		return
	}

	if len(candidates) == 0 {
		s.manager.log.Info(s.streamID, "fb.discover", "no candidates found")
		return
	}

	s.manager.log.Info(s.streamID, "fb.discover", fmt.Sprintf("found %d candidates", len(candidates)))

	candidateIDs := make([]string, len(candidates))
	for i, c := range candidates {
		candidateIDs[i] = c.Source.ID
	}
	if err := s.manager.healthChecker.RunForSources(ctx, candidateIDs); err != nil {
		s.manager.log.Warn(s.streamID, "fb.cycle", fmt.Sprintf("health check failed: %v", err))
	}

	var healthyCandidates []CandidateSource
	for _, c := range candidates {
		src, err := s.manager.db.GetSourceByID(ctx, c.Source.ID)
		if err != nil || src == nil {
			continue
		}
		if !src.Available || src.Users >= src.MaxListeners || !src.AntConnected {
			continue
		}
		c.Source = *src
		healthyCandidates = append(healthyCandidates, c)
	}

	if len(healthyCandidates) == 0 {
		s.manager.log.Info(s.streamID, "fb.cycle", "no healthy candidates after status check")
		return
	}

	s.manager.log.Info(s.streamID, "fb.probe", fmt.Sprintf("%d healthy candidates, starting probes", len(healthyCandidates)))

	s.mu.Lock()
	s.probeTotal = len(healthyCandidates)
	s.probesDone = 0
	s.mu.Unlock()

	s.manager.broadcastProbeProgress(s.streamID, len(healthyCandidates), 0)

	s.manager.log.Info(s.streamID, "fb.snapshot", "capturing reference snapshot")
	refResult, err := s.manager.reconfigurer.CollectSnapshot(ctx, s.streamID, ProbeAnalysisWindow, *stream)
	refSnapshot := refResult.Snapshot
	if err != nil {
		s.manager.log.Warn(s.streamID, "fb.snapshot", fmt.Sprintf("reference failed: %v (using neutral defaults)", err))
		refSnapshot = AudioSnapshot{
			RMSDB:        -40,
			PeakRMSDB:    -30,
			FloorRMSDB:   -55,
			SilenceRatio: 0.5,
			FrameRate:    24.0,
		}
	} else {
		s.manager.log.Debug(s.streamID, "fb.snapshot", fmt.Sprintf(
			"rms=%.1fdB silence=%.2f frame_rate=%.1f pcm=%dB wf_bins=%d",
			refSnapshot.RMSDB, refSnapshot.SilenceRatio, refSnapshot.FrameRate, len(refResult.RawPCM), len(refSnapshot.WFBinsInBand)))

		if len(refResult.RawPCM) > 0 {
			if err := s.manager.db.UpdateStreamRefAudio(ctx, s.streamID, refResult.RawPCM, refResult.SampleRate); err != nil {
				s.manager.log.Warn(s.streamID, "fb.snapshot", fmt.Sprintf("persist ref audio failed: %v", err))
			}
		}
	}

	type scoredResult struct {
		suggestion FallbackSuggestion
		rawPCM     []byte
		sampleRate int
	}

	var results []scoredResult

	for i, candidate := range healthyCandidates {
		select {
		case <-ctx.Done():
			return
		default:
		}

		select {
		case s.manager.probeSem <- struct{}{}:
		case <-ctx.Done():
			return
		}

		s.manager.log.Info(s.streamID, "fb.probe", fmt.Sprintf("source=%s (%s) %d/%d",
			candidate.Source.ID, candidate.Source.Name, i+1, len(healthyCandidates)))

		probeResult := ProbeSource(ctx, candidate, *stream)
		<-s.manager.probeSem

		s.mu.Lock()
		s.probesDone = i + 1
		s.mu.Unlock()

		s.manager.broadcastProbeProgress(s.streamID, len(healthyCandidates), i+1)

		if !probeResult.Connected {
			s.manager.log.Warn(s.streamID, "fb.probe", fmt.Sprintf("source=%s failed: %v", candidate.Source.ID, probeResult.Error))
			continue
		}

		score, metrics := ScoreCandidate(refSnapshot, probeResult.Snapshot, probeResult.LatencyMs)

		if score < MinScoreThreshold {
			s.manager.log.Debug(s.streamID, "fb.probe", fmt.Sprintf("source=%s score=%.3f (too low)", candidate.Source.ID, score))
			continue
		}

		s.manager.log.Info(s.streamID, "fb.probe", fmt.Sprintf("source=%s score=%.3f rms_sim=%.2f silence_agree=%.2f spectral=%.2f",
			candidate.Source.ID, score, metrics.RMSSimilarity, metrics.SilenceAgreement, metrics.SpectralSimilarity))

		results = append(results, scoredResult{
			suggestion: FallbackSuggestion{
				StreamID:     s.streamID,
				SourceID:     probeResult.SourceID,
				SourceName:   probeResult.SourceName,
				SourceHost:   probeResult.SourceHost,
				SourcePort:   probeResult.SourcePort,
				DistanceKm:   probeResult.DistanceKm,
				BearingDeg:   probeResult.BearingDeg,
				Score:        score,
				LastProbed:   time.Now(),
				ProbeMetrics: metrics,
			},
			rawPCM:     probeResult.RawPCM,
			sampleRate: probeResult.SampleRate,
		})
	}

	sort.Slice(results, func(i, j int) bool {
		return results[i].suggestion.Score > results[j].suggestion.Score
	})

	if len(results) > TopSuggestions {
		results = results[:TopSuggestions]
	}

	suggestions := make([]*FallbackSuggestion, len(results))
	dbRows := make([]db.FallbackSuggestionRow, len(results))
	for i := range results {
		results[i].suggestion.Rank = i + 1
		suggestions[i] = &results[i].suggestion

		metricsJSON, _ := json.Marshal(results[i].suggestion.ProbeMetrics)
		dbRows[i] = db.FallbackSuggestionRow{
			StreamID:        s.streamID,
			SourceID:        results[i].suggestion.SourceID,
			Rank:            i + 1,
			Score:           results[i].suggestion.Score,
			DistanceKm:      results[i].suggestion.DistanceKm,
			ProbeMetrics:    metricsJSON,
			LastProbed:      results[i].suggestion.LastProbed,
			ProbeAudio:      results[i].rawPCM,
			ProbeSampleRate: results[i].sampleRate,
		}
	}

	if err := s.manager.db.UpsertFallbackSuggestions(ctx, s.streamID, dbRows); err != nil {
		s.manager.log.Error(s.streamID, "fb.cycle", fmt.Sprintf("persist suggestions failed: %v", err))
	}

	s.mu.Lock()
	s.suggestions = suggestions
	s.mu.Unlock()

	s.manager.broadcastSuggestions(s.streamID, suggestions)

	s.manager.log.Info(s.streamID, "fb.cycle", fmt.Sprintf("complete, %d suggestions", len(suggestions)))
}
