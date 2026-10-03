package quality

import (
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/sammy/sdr-radio/internal/snr"
	"github.com/sammy/sdr-radio/internal/streamlog"
)

// HealthSnapshot is the data the monitor reads each tick.
type HealthSnapshot struct {
	AudioStale     bool
	WFStale        bool
	TooBusy        bool
	ReconnectChurn bool
	Reconnecting   bool
	InErrorState   bool
	ConnectionAge  time.Duration
}

// DegradedFunc is called when the monitor decides the stream is degraded.
type DegradedFunc func(streamID, reason string)

// WFFrameFunc returns the most recent waterfall frame for SNR sampling.
type WFFrameFunc func() *snr.WFFrameData

// HealthFunc returns the current health snapshot for the stream.
type HealthFunc func() HealthSnapshot

// SuggestionSNR returns the best probe suggestion's in-band SNR.
// Returns (snr, true) if a suggestion exists, or (0, false) if none.
type SuggestionSNRFunc func() (float64, bool)

const (
	tickInterval      = 5 * time.Second
	snrSampleInterval = 10 * time.Second
	snrWindowSize     = 12 // 2 minutes at 10s intervals
	staleThreshold    = 30 * time.Second

	snrDegradationDB  = 15.0
	snrDegradationDur = 60 * time.Second
	snrAdvantageDB    = 15.0
	snrAdvantageMinCycles = 2

	defaultCooldown   = 60 * time.Second
	escalatedCooldown = 5 * time.Minute
	maxCooldown       = 15 * time.Minute

	blacklistDuration = 30 * time.Minute

	escalateWindow2 = 5 * time.Minute
	escalateWindow3 = 15 * time.Minute
)

type Monitor struct {
	streamID       string
	log            *streamlog.Logger
	onDegraded     DegradedFunc
	getHealth      HealthFunc
	getWFFrame     WFFrameFunc
	getSuggSNR     SuggestionSNRFunc
	bandConfig     snr.BandConfig
	isFavorite     func(sourceID string) bool

	mu             sync.Mutex
	snrSamples     [snrWindowSize]float64
	snrIdx         int
	snrFilled      int
	snrBaseline    float64
	snrReady       bool
	snrDegradedAt  time.Time

	betterCycles   int

	blacklist      map[string]time.Time
	switchTimes    []time.Time
	cooldownUntil  time.Time

	audioStaleAt   time.Time
	wfStaleAt      time.Time

	lastSNRSample  time.Time

	stopCh         chan struct{}
	done           chan struct{}
}

func NewMonitor(
	streamID string,
	log *streamlog.Logger,
	onDegraded DegradedFunc,
	getHealth HealthFunc,
	getWFFrame WFFrameFunc,
	getSuggSNR SuggestionSNRFunc,
	bandConfig snr.BandConfig,
	isFavorite func(sourceID string) bool,
) *Monitor {
	return &Monitor{
		streamID:   streamID,
		log:        log,
		onDegraded: onDegraded,
		getHealth:  getHealth,
		getWFFrame: getWFFrame,
		getSuggSNR: getSuggSNR,
		bandConfig: bandConfig,
		isFavorite: isFavorite,
		blacklist:  make(map[string]time.Time),
		stopCh:     make(chan struct{}),
		done:       make(chan struct{}),
	}
}

func (m *Monitor) Start() {
	go m.run()
}

func (m *Monitor) Stop() {
	close(m.stopCh)
	<-m.done
}

// Blacklist returns the blacklisted source IDs (for filtering in HandleDegraded).
func (m *Monitor) Blacklist() map[string]time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneBlacklist()
	cp := make(map[string]time.Time, len(m.blacklist))
	for k, v := range m.blacklist {
		cp[k] = v
	}
	return cp
}

// BlacklistSource adds a source to the blacklist after a switch.
func (m *Monitor) BlacklistSource(sourceID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.blacklist[sourceID] = time.Now().Add(blacklistDuration)
}

// ResetBaseline clears the SNR baseline (called on tuning changes).
func (m *Monitor) ResetBaseline() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.snrReady = false
	m.snrFilled = 0
	m.snrIdx = 0
	m.snrDegradedAt = time.Time{}
	m.betterCycles = 0
}

// UpdateBandConfig updates the band configuration when tuning changes.
func (m *Monitor) UpdateBandConfig(bc snr.BandConfig) {
	m.mu.Lock()
	m.bandConfig = bc
	m.mu.Unlock()
	m.ResetBaseline()
}

// NotifyProbeComplete is called after a probe cycle completes.
// It checks for the "better_source_available" condition.
func (m *Monitor) NotifyProbeComplete() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.snrReady {
		return
	}

	suggSNR, ok := m.getSuggSNR()
	if !ok {
		m.betterCycles = 0
		return
	}

	currentSNR := m.currentSNR()
	if suggSNR-currentSNR >= snrAdvantageDB {
		m.betterCycles++
	} else {
		m.betterCycles = 0
	}
}

func (m *Monitor) run() {
	defer close(m.done)

	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	m.log.Info(m.streamID, "quality.start", "quality monitor started")

	for {
		select {
		case <-m.stopCh:
			m.log.Info(m.streamID, "quality.stop", "quality monitor stopped")
			return
		case <-ticker.C:
			m.tick()
		}
	}
}

func (m *Monitor) tick() {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()

	if now.Before(m.cooldownUntil) {
		return
	}

	// Sample SNR periodically
	if now.Sub(m.lastSNRSample) >= snrSampleInterval {
		m.sampleSNR()
		m.lastSNRSample = now
	}

	h := m.getHealth()

	// Reactive triggers
	if reason := m.evaluateReactive(h, now); reason != "" {
		m.trigger(reason, now)
		return
	}

	// Proactive triggers
	if reason := m.evaluateProactive(now); reason != "" {
		m.trigger(reason, now)
		return
	}
}

func (m *Monitor) evaluateReactive(h HealthSnapshot, now time.Time) string {
	if h.InErrorState {
		return "stream_error"
	}

	if h.TooBusy {
		return "too_busy"
	}

	if h.ReconnectChurn {
		return "reconnect_churn"
	}

	if h.AudioStale && h.WFStale {
		if m.audioStaleAt.IsZero() {
			m.audioStaleAt = now
		}
		if m.wfStaleAt.IsZero() {
			m.wfStaleAt = now
		}
		return "all_data_stale"
	}

	if h.AudioStale {
		if m.audioStaleAt.IsZero() {
			m.audioStaleAt = now
		} else if now.Sub(m.audioStaleAt) >= staleThreshold {
			return "audio_stale_prolonged"
		}
	} else {
		m.audioStaleAt = time.Time{}
	}

	if h.WFStale {
		if m.wfStaleAt.IsZero() {
			m.wfStaleAt = now
		} else if now.Sub(m.wfStaleAt) >= staleThreshold {
			return "wf_stale_prolonged"
		}
	} else {
		m.wfStaleAt = time.Time{}
	}

	return ""
}

func (m *Monitor) evaluateProactive(now time.Time) string {
	if !m.snrReady {
		return ""
	}

	currentSNR := m.currentSNR()

	// Check sustained SNR drop
	if m.snrBaseline-currentSNR >= snrDegradationDB {
		if m.snrDegradedAt.IsZero() {
			m.snrDegradedAt = now
		} else if now.Sub(m.snrDegradedAt) >= snrDegradationDur {
			// Only trigger if a probe suggestion has better SNR
			if suggSNR, ok := m.getSuggSNR(); ok && suggSNR-currentSNR >= 10.0 {
				return "signal_degraded"
			}
			m.log.Debug(m.streamID, "quality.snr", "signal degraded but no better source available")
		}
	} else {
		m.snrDegradedAt = time.Time{}
	}

	// Check if a probe candidate has been consistently better
	if m.betterCycles >= snrAdvantageMinCycles {
		return "better_source_available"
	}

	return ""
}

func (m *Monitor) trigger(reason string, now time.Time) {
	m.log.Warn(m.streamID, "quality.degraded", fmt.Sprintf("reason=%s", reason))

	m.switchTimes = append(m.switchTimes, now)
	m.cooldownUntil = now.Add(m.computeCooldown(now))

	// Reset proactive tracking after a trigger
	m.snrDegradedAt = time.Time{}
	m.betterCycles = 0

	m.onDegraded(m.streamID, reason)
}

func (m *Monitor) computeCooldown(now time.Time) time.Duration {
	recent := 0
	for _, t := range m.switchTimes {
		if now.Sub(t) < escalateWindow3 {
			recent++
		}
	}

	recentShort := 0
	for _, t := range m.switchTimes {
		if now.Sub(t) < escalateWindow2 {
			recentShort++
		}
	}

	if recent >= 3 {
		return maxCooldown
	}
	if recentShort >= 2 {
		return escalatedCooldown
	}
	return defaultCooldown
}

func (m *Monitor) sampleSNR() {
	frame := m.getWFFrame()
	if frame == nil {
		return
	}

	result, err := snr.FromWFFrame(*frame, m.bandConfig)
	if err != nil {
		return
	}

	m.snrSamples[m.snrIdx%snrWindowSize] = result.InBandSNRdB
	m.snrIdx++
	if m.snrFilled < snrWindowSize {
		m.snrFilled++
	}

	if m.snrFilled >= snrWindowSize && !m.snrReady {
		m.snrReady = true
		m.snrBaseline = m.medianSNR()
		m.log.Info(m.streamID, "quality.snr.baseline", fmt.Sprintf("established=%.1f dB", m.snrBaseline))
	}
}

func (m *Monitor) currentSNR() float64 {
	if m.snrFilled == 0 {
		return 0
	}
	// Use median of last 3 samples for stability
	n := 3
	if m.snrFilled < n {
		n = m.snrFilled
	}
	vals := make([]float64, n)
	for i := 0; i < n; i++ {
		idx := (m.snrIdx - 1 - i + snrWindowSize*100) % snrWindowSize
		vals[i] = m.snrSamples[idx]
	}
	sort.Float64s(vals)
	return vals[len(vals)/2]
}

func (m *Monitor) medianSNR() float64 {
	n := m.snrFilled
	if n == 0 {
		return 0
	}
	vals := make([]float64, n)
	for i := 0; i < n; i++ {
		vals[i] = m.snrSamples[i]
	}
	sort.Float64s(vals)
	return vals[n/2]
}

func (m *Monitor) pruneBlacklist() {
	now := time.Now()
	for k, expiry := range m.blacklist {
		if now.After(expiry) {
			delete(m.blacklist, k)
		}
	}
}

