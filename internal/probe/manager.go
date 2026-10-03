package probe

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

func sourceLabel(s models.Source) string {
	loc := ""
	if s.Location != nil && *s.Location != "" {
		loc = *s.Location
	}
	hostPort := s.Host
	if s.Port != 0 && s.Port != 8073 {
		hostPort = fmt.Sprintf("%s:%d", s.Host, s.Port)
	}
	if loc != "" {
		return fmt.Sprintf("%s [%s]", hostPort, loc)
	}
	return hostPort
}

const (
	ProbeCycleInterval      = 10 * time.Minute
	MaxConcurrentProbes     = 12
	ReferenceSnapshotFrames = 72
	TopSuggestions          = 3
	EMAAlpha                = 0.3
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

// BlacklistFunc returns the blacklisted source IDs for a stream.
type BlacklistFunc func(streamID string) map[string]time.Time

// BlacklistSourceFunc blacklists a source for a stream.
type BlacklistSourceFunc func(streamID, sourceID string)

type Manager struct {
	db              *db.DB
	log             *streamlog.Logger
	healthChecker   *srcsync.HealthChecker
	reconfigurer    StreamReconfigurer
	broadcast       BroadcastFunc
	probeSem        chan struct{}
	getBlacklist    BlacklistFunc
	blacklistSource BlacklistSourceFunc

	mu       sync.RWMutex
	sessions map[string]*probeSession
}

type probeSession struct {
	streamID string
	manager  *Manager

	mu          sync.RWMutex
	suggestions []*Suggestion
	lockedIn    map[string]bool // source IDs of top suggestions from last cycle
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
		sessions:      make(map[string]*probeSession),
	}
}

// SetGetBlacklist sets the function used to retrieve blacklisted sources from the quality monitor.
func (m *Manager) SetGetBlacklist(fn BlacklistFunc) {
	m.getBlacklist = fn
}

// SetBlacklistSource sets the function used to blacklist a source after a switch.
func (m *Manager) SetBlacklistSource(fn BlacklistSourceFunc) {
	m.blacklistSource = fn
}

func (m *Manager) Enable(ctx context.Context, streamID string) {
	m.mu.Lock()
	if _, exists := m.sessions[streamID]; exists {
		m.mu.Unlock()
		return
	}

	sessionCtx, cancel := context.WithCancel(context.Background())
	session := &probeSession{
		streamID: streamID,
		manager:  m,
		cancel:   cancel,
		done:     make(chan struct{}),
		lockedIn: make(map[string]bool),
	}
	m.sessions[streamID] = session
	m.mu.Unlock()

	m.log.Info(streamID, "fb.enable", "probe cycle enabled")
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

	m.log.Info(streamID, "fb.disable", "probe cycle disabled (suggestions preserved)")
}

func (m *Manager) Reprobe(ctx context.Context, streamID string) {
	m.mu.RLock()
	session, exists := m.sessions[streamID]
	m.mu.RUnlock()

	if err := m.db.DeleteProbeSuggestions(ctx, streamID); err != nil {
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

	periodic := stream.AutoProbe

	m.mu.Lock()
	sessionCtx, cancel := context.WithCancel(context.Background())
	newSession := &probeSession{
		streamID: streamID,
		manager:  m,
		cancel:   cancel,
		done:     make(chan struct{}),
		lockedIn: make(map[string]bool),
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

func (m *Manager) GetSuggestions(ctx context.Context, streamID string) ([]*Suggestion, error) {
	rows, err := m.db.ListProbeSuggestions(ctx, streamID)
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

	var suggestions []*Suggestion
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
		suggestions = append(suggestions, &Suggestion{
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

func (m *Manager) OnStreamUpdated(stream models.Stream, sourceChanged bool, tuningChanged bool) {
	m.mu.RLock()
	_, exists := m.sessions[stream.ID]
	m.mu.RUnlock()

	if !exists {
		if stream.AutoProbe || stream.QualityFallback {
			m.Enable(context.Background(), stream.ID)
		}
		return
	}

	if !stream.AutoProbe && !stream.QualityFallback {
		m.Disable(context.Background(), stream.ID)
		return
	}

	if sourceChanged || tuningChanged {
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
		m.log.Warn(streamID, "quality.degraded", fmt.Sprintf("reason=%s but no probe suggestions available", reason))
		return
	}

	// Get blacklist to skip recently-abandoned sources
	var blacklist map[string]time.Time
	if m.getBlacklist != nil {
		blacklist = m.getBlacklist(streamID)
	}

	// Find the best non-blacklisted suggestion (sorted by EMA)
	var top *Suggestion
	for _, s := range suggestions {
		if blacklist != nil {
			if expiry, ok := blacklist[s.SourceID]; ok && time.Now().Before(expiry) {
				m.log.Debug(streamID, "fb.failover", fmt.Sprintf("skipping blacklisted source=%s", s.SourceID))
				continue
			}
		}
		top = s
		break
	}

	if top == nil {
		m.log.Warn(streamID, "quality.degraded", fmt.Sprintf("reason=%s but all suggestions blacklisted", reason))
		return
	}

	m.log.Warn(streamID, "fb.failover", fmt.Sprintf("reason=%s target=%s score=%.2f score_ema=%.2f", reason, top.SourceID, top.Score, top.ScoreEMA))

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

	// Blacklist the old source so we don't switch back immediately
	if m.blacklistSource != nil {
		m.blacklistSource(streamID, prevSourceID)
	}

	m.ClearSuggestions(streamID)

	// Trigger a fresh probe cycle with the new source as reference
	go m.Reprobe(context.Background(), streamID)
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

func (m *Manager) broadcastSuggestions(streamID string, suggestions []*Suggestion) {
	if m.broadcast == nil {
		return
	}
	m.broadcast(streamID, map[string]any{
		"type":        "suggestions_updated",
		"stream_id":   streamID,
		"suggestions": suggestions,
	})
}

func (m *Manager) broadcastProbeProgress(streamID string, total, probed int) {
	if m.broadcast == nil {
		return
	}
	m.broadcast(streamID, map[string]any{
		"type":              "probing_started",
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
		"type":           "source_switched",
		"stream_id":      streamID,
		"from_source_id": fromSourceID,
		"to_source_id":   toSourceID,
		"reason":         reason,
		"reason_detail":  reasonDetail(reason),
	}
	src, err := m.db.GetSourceByID(context.Background(), fromSourceID)
	if err == nil && src != nil {
		payload["from_source_host"] = src.Host
		payload["from_source_port"] = src.Port
	}
	toSrc, err := m.db.GetSourceByID(context.Background(), toSourceID)
	if err == nil && toSrc != nil {
		payload["to_source_host"] = toSrc.Host
		payload["to_source_port"] = toSrc.Port
		payload["to_source_name"] = toSrc.Name
	}
	m.broadcast(streamID, payload)
}

func reasonDetail(reason string) string {
	switch reason {
	case "reconnect_churn":
		return "Source kept disconnecting repeatedly. Switched to a more stable source."
	case "too_busy":
		return "Source reported it was too busy to serve data."
	case "audio_stale_prolonged":
		return "No audio data received for over 30 seconds."
	case "wf_stale_prolonged":
		return "No waterfall data received for over 30 seconds."
	case "all_data_stale":
		return "Both audio and waterfall data stopped arriving."
	case "signal_degraded":
		return "In-band signal quality dropped significantly. A better source was found."
	case "better_source_available":
		return "A consistently better source was discovered during probing."
	case "stream_error":
		return "Stream entered error state after too many failed reconnects."
	default:
		return "Source quality degraded. Automatically switched to a better alternative."
	}
}

func (s *probeSession) run(ctx context.Context) {
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

func (s *probeSession) runOnce(ctx context.Context) {
	defer close(s.done)
	s.runCycle(ctx)
}

func (s *probeSession) runCycle(ctx context.Context) {
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

	var blacklist map[string]time.Time
	if s.manager.getBlacklist != nil {
		blacklist = s.manager.getBlacklist(s.streamID)
	}

	s.mu.RLock()
	lockedIn := s.lockedIn
	s.mu.RUnlock()

	// Build the full sorted candidate list once
	allCandidates, err := BuildSortedCandidates(
		ctx, s.manager.db, *currentSource, currentSource.ID,
		blacklist, lockedIn,
	)
	if err != nil {
		s.manager.log.Error(s.streamID, "fb.discover", fmt.Sprintf("failed: %v", err))
		return
	}

	s.manager.log.Info(s.streamID, "fb.discover", fmt.Sprintf(
		"%d sources available (excl blacklisted), finding %d verified candidates",
		len(allCandidates), DefaultMaxCandidates))

	// Iterate through the sorted list in batches, verifying via /status + QuickProbe
	var verified []CandidateSource
	cursor := 0
	batchNum := 0

	for len(verified) < DefaultMaxCandidates && cursor < len(allCandidates) {
		needed := DefaultMaxCandidates - len(verified)
		end := cursor + needed
		if end > len(allCandidates) {
			end = len(allCandidates)
		}
		batch := allCandidates[cursor:end]
		cursor = end
		batchNum++

		passed, failed := VerifyBatch(ctx, s.manager.db, s.manager.healthChecker, batch, stream.FrequencyKHz, stream.Mode)

		for _, f := range failed {
			label := f.SourceID
			for _, c := range batch {
				if c.Source.ID == f.SourceID {
					label = sourceLabel(c.Source)
					break
				}
			}
			s.manager.log.Warn(s.streamID, "fb.quick", fmt.Sprintf(
				"source=%s (%s) failed: %s", f.SourceID, label, f.Error))
			if s.manager.blacklistSource != nil {
				s.manager.blacklistSource(s.streamID, f.SourceID)
			}
		}

		verified = append(verified, passed...)

		s.manager.log.Info(s.streamID, "fb.discover", fmt.Sprintf(
			"batch %d: %d/%d verified, have %d total",
			batchNum, len(passed), len(batch), len(verified)))
	}

	if len(verified) > DefaultMaxCandidates {
		verified = verified[:DefaultMaxCandidates]
	}

	healthyCandidates := verified

	if len(healthyCandidates) == 0 {
		s.manager.log.Info(s.streamID, "fb.cycle", "no verified candidates found")
		return
	}

	s.manager.log.Info(s.streamID, "fb.probe", fmt.Sprintf("%d verified candidates, starting parallel probes", len(healthyCandidates)))

	s.mu.Lock()
	s.probeTotal = len(healthyCandidates)
	s.probesDone = 0
	s.mu.Unlock()

	s.manager.broadcastProbeProgress(s.streamID, len(healthyCandidates), 0)

	type scoredResult struct {
		suggestion Suggestion
		rawPCM     []byte
		sampleRate int
	}

	type probeOutput struct {
		idx    int
		result ProbeResult
	}

	// Launch reference snapshot and all probes concurrently — the snapshot
	// listens on the already-connected stream while probes dial out to
	// different servers, so there is no resource conflict.
	type snapshotOutput struct {
		result  SnapshotResult
		err     error
	}
	snapshotCh := make(chan snapshotOutput, 1)
	go func() {
		s.manager.log.Info(s.streamID, "fb.snapshot", "capturing reference snapshot")
		res, err := s.manager.reconfigurer.CollectSnapshot(ctx, s.streamID, ProbeAnalysisWindow, *stream)
		snapshotCh <- snapshotOutput{result: res, err: err}
	}()

	resultCh := make(chan probeOutput, len(healthyCandidates))
	for i, candidate := range healthyCandidates {
		select {
		case <-ctx.Done():
			return
		case s.manager.probeSem <- struct{}{}:
		}

		go func(idx int, cand CandidateSource) {
			defer func() { <-s.manager.probeSem }()
			s.manager.log.Info(s.streamID, "fb.probe", fmt.Sprintf("source=%s (%s) %d/%d",
				cand.Source.ID, sourceLabel(cand.Source), idx+1, len(healthyCandidates)))
			pr := ProbeSource(ctx, cand, *stream)
			resultCh <- probeOutput{idx: idx, result: pr}
		}(i, candidate)
	}

	// Collect probe results
	var probeResults []probeOutput
	for range healthyCandidates {
		select {
		case <-ctx.Done():
			return
		case po := <-resultCh:
			probeResults = append(probeResults, po)

			s.mu.Lock()
			s.probesDone++
			done := s.probesDone
			s.mu.Unlock()

			s.manager.broadcastProbeProgress(s.streamID, len(healthyCandidates), done)
		}
	}

	// Wait for reference snapshot to finish
	snapOut := <-snapshotCh
	refSnapshot := snapOut.result.Snapshot
	if snapOut.err != nil {
		s.manager.log.Warn(s.streamID, "fb.snapshot", fmt.Sprintf("reference failed: %v (using neutral defaults)", snapOut.err))
		refSnapshot = AudioSnapshot{
			RMSDB:        -40,
			PeakRMSDB:    -30,
			FloorRMSDB:   -55,
			SilenceRatio: 0.5,
			FrameRate:    24.0,
		}
	} else {
		s.manager.log.Debug(s.streamID, "fb.snapshot", fmt.Sprintf(
			"rms=%.1fdB silence=%.2f frame_rate=%.1f pcm=%dB snr=%.1fdB",
			refSnapshot.RMSDB, refSnapshot.SilenceRatio, refSnapshot.FrameRate,
			len(snapOut.result.RawPCM), refSnapshot.InBandSNRdB))

		if len(snapOut.result.RawPCM) > 0 {
			if err := s.manager.db.UpdateStreamRefAudio(ctx, s.streamID, snapOut.result.RawPCM, snapOut.result.SampleRate); err != nil {
				s.manager.log.Warn(s.streamID, "fb.snapshot", fmt.Sprintf("persist ref audio failed: %v", err))
			}
		}
	}

	// Load existing suggestions for EMA blending
	existingRows, _ := s.manager.db.ListProbeSuggestions(ctx, s.streamID)
	existingEMA := make(map[string]float64)
	for _, row := range existingRows {
		if row.ScoreEMA > 0 {
			existingEMA[row.SourceID] = row.ScoreEMA
		}
	}

	var results []scoredResult
	for _, po := range probeResults {
		pr := po.result
		cand := healthyCandidates[po.idx]

		if !pr.Connected {
			s.manager.log.Warn(s.streamID, "fb.probe", fmt.Sprintf("source=%s (%s) failed: %v", cand.Source.ID, sourceLabel(cand.Source), pr.Error))
			continue
		}

		score, metrics := ScoreCandidate(refSnapshot, pr.Snapshot, pr.LatencyMs, pr.SlotUsers, pr.SlotMax)

		if score < MinScoreThreshold {
			s.manager.log.Debug(s.streamID, "fb.probe", fmt.Sprintf("source=%s score=%.3f (too low)", cand.Source.ID, score))
			continue
		}

		// EMA blending
		scoreEMA := score
		if oldEMA, ok := existingEMA[pr.SourceID]; ok {
			scoreEMA = EMAAlpha*score + (1-EMAAlpha)*oldEMA
		}

		s.manager.log.Info(s.streamID, "fb.probe", fmt.Sprintf(
			"source=%s (%s) score=%.3f ema=%.3f snr=%.1fdB floor=%.1fdB delivery_cv=%.2f latency=%.0fms slots=%d/%d silence_agree=%.2f",
			cand.Source.ID, sourceLabel(cand.Source), score, scoreEMA,
			metrics.InBandSNRdB, metrics.NoiseFloordB, metrics.FrameDeliveryCV,
			metrics.LatencyMs, pr.SlotUsers, pr.SlotMax,
			metrics.SilenceAgreement))

		if pr.Snapshot.SNRError != "" {
			s.manager.log.Warn(s.streamID, "fb.probe", fmt.Sprintf(
				"source=%s snr failed (wf_frames=%d): %s",
				cand.Source.ID, pr.Snapshot.WFFrameCount, pr.Snapshot.SNRError))
		}

		results = append(results, scoredResult{
			suggestion: Suggestion{
				StreamID:     s.streamID,
				SourceID:     pr.SourceID,
				SourceName:   pr.SourceName,
				SourceHost:   pr.SourceHost,
				SourcePort:   pr.SourcePort,
				DistanceKm:   pr.DistanceKm,
				BearingDeg:   pr.BearingDeg,
				Score:        score,
				ScoreEMA:     scoreEMA,
				InBandSNRdB:  metrics.InBandSNRdB,
				LastProbed:   time.Now(),
				ProbeMetrics: metrics,
			},
			rawPCM:     pr.RawPCM,
			sampleRate: pr.SampleRate,
		})
	}

	// Sort by EMA score (best first)
	sort.Slice(results, func(i, j int) bool {
		return results[i].suggestion.ScoreEMA > results[j].suggestion.ScoreEMA
	})

	// Blacklist sources that didn't make the top 3 cut
	if len(results) > TopSuggestions {
		for _, r := range results[TopSuggestions:] {
			if s.manager.blacklistSource != nil {
				s.manager.blacklistSource(s.streamID, r.suggestion.SourceID)
			}
		}
		results = results[:TopSuggestions]
	}

	// Lock in the top sources for priority in the next cycle
	newLockedIn := make(map[string]bool, len(results))
	for _, r := range results {
		newLockedIn[r.suggestion.SourceID] = true
	}

	suggestions := make([]*Suggestion, len(results))
	dbRows := make([]db.ProbeSuggestionRow, len(results))
	for i := range results {
		results[i].suggestion.Rank = i + 1
		suggestions[i] = &results[i].suggestion

		metricsJSON, _ := json.Marshal(results[i].suggestion.ProbeMetrics)
		dbRows[i] = db.ProbeSuggestionRow{
			StreamID:        s.streamID,
			SourceID:        results[i].suggestion.SourceID,
			Rank:            i + 1,
			Score:           results[i].suggestion.Score,
			ScoreEMA:        results[i].suggestion.ScoreEMA,
			InBandSNRdB:     results[i].suggestion.InBandSNRdB,
			DistanceKm:      results[i].suggestion.DistanceKm,
			ProbeMetrics:    metricsJSON,
			LastProbed:      results[i].suggestion.LastProbed,
			ProbeAudio:      results[i].rawPCM,
			ProbeSampleRate: results[i].sampleRate,
		}
	}

	if err := s.manager.db.UpsertProbeSuggestions(ctx, s.streamID, dbRows); err != nil {
		s.manager.log.Error(s.streamID, "fb.cycle", fmt.Sprintf("persist suggestions failed: %v", err))
	}

	s.mu.Lock()
	s.suggestions = suggestions
	s.lockedIn = newLockedIn
	s.mu.Unlock()

	s.manager.broadcastSuggestions(s.streamID, suggestions)

	var summaryLines string
	for _, sg := range suggestions {
		hostPort := sg.SourceHost
		if sg.SourcePort != 0 && sg.SourcePort != 8073 {
			hostPort = fmt.Sprintf("%s:%d", sg.SourceHost, sg.SourcePort)
		}
		delta := sg.InBandSNRdB - refSnapshot.InBandSNRdB
		sign := "+"
		if delta < 0 {
			sign = ""
		}
		summaryLines += fmt.Sprintf("\n  #%d %s score=%.3f snr=%.1fdB (%s%.1f vs current) dist=%.0fkm",
			sg.Rank, hostPort, sg.ScoreEMA, sg.InBandSNRdB, sign, delta, sg.DistanceKm)
	}
	s.manager.log.Info(s.streamID, "fb.cycle", fmt.Sprintf(
		"complete — %d suggestions (current snr=%.1fdB):%s",
		len(suggestions), refSnapshot.InBandSNRdB, summaryLines))
}
