package quality

import (
	"sync"
	"testing"
	"time"

	"github.com/sammy/sdr-radio/internal/snr"
	"github.com/sammy/sdr-radio/internal/streamlog"
)

type testHarness struct {
	mu           sync.Mutex
	health       HealthSnapshot
	reasons      []string
	wfFrame      *snr.WFFrameData
	suggSNR      float64
	suggSNROK    bool
}

func newHarness() *testHarness {
	return &testHarness{}
}

func (h *testHarness) getHealth() HealthSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.health
}

func (h *testHarness) setHealth(hs HealthSnapshot) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.health = hs
}

func (h *testHarness) onDegraded(streamID, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.reasons = append(h.reasons, reason)
}

func (h *testHarness) getReasons() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	cp := make([]string, len(h.reasons))
	copy(cp, h.reasons)
	return cp
}

func (h *testHarness) getWFFrame() *snr.WFFrameData {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.wfFrame
}

func (h *testHarness) getSuggSNR() (float64, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.suggSNR, h.suggSNROK
}

func newTestMonitor(h *testHarness) *Monitor {
	log := streamlog.New()
	return NewMonitor(
		"test-stream",
		log,
		h.onDegraded,
		h.getHealth,
		h.getWFFrame,
		h.getSuggSNR,
		snr.BandConfig{CenterKHz: 14000, PassbandLoHz: -4900, PassbandHiHz: 4900},
		func(sourceID string) bool { return false },
	)
}

func TestEvaluateReactive_ErrorState(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	h.setHealth(HealthSnapshot{InErrorState: true})

	m.mu.Lock()
	reason := m.evaluateReactive(h.getHealth(), time.Now())
	m.mu.Unlock()

	if reason != "stream_error" {
		t.Errorf("expected stream_error, got %q", reason)
	}
}

func TestEvaluateReactive_TooBusy(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	h.setHealth(HealthSnapshot{TooBusy: true})

	m.mu.Lock()
	reason := m.evaluateReactive(h.getHealth(), time.Now())
	m.mu.Unlock()

	if reason != "too_busy" {
		t.Errorf("expected too_busy, got %q", reason)
	}
}

func TestEvaluateReactive_ReconnectChurn(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	h.setHealth(HealthSnapshot{ReconnectChurn: true})

	m.mu.Lock()
	reason := m.evaluateReactive(h.getHealth(), time.Now())
	m.mu.Unlock()

	if reason != "reconnect_churn" {
		t.Errorf("expected reconnect_churn, got %q", reason)
	}
}

func TestEvaluateReactive_AllDataStale(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	h.setHealth(HealthSnapshot{AudioStale: true, WFStale: true})

	m.mu.Lock()
	reason := m.evaluateReactive(h.getHealth(), time.Now())
	m.mu.Unlock()

	if reason != "all_data_stale" {
		t.Errorf("expected all_data_stale, got %q", reason)
	}
}

func TestEvaluateReactive_AudioStaleProlonged(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	now := time.Now()
	h.setHealth(HealthSnapshot{AudioStale: true})

	// First tick: records the stale start time, no trigger yet
	m.mu.Lock()
	reason := m.evaluateReactive(h.getHealth(), now)
	m.mu.Unlock()
	if reason != "" {
		t.Errorf("first tick should not trigger, got %q", reason)
	}

	// 31 seconds later: should trigger audio_stale_prolonged
	m.mu.Lock()
	reason = m.evaluateReactive(h.getHealth(), now.Add(31*time.Second))
	m.mu.Unlock()
	if reason != "audio_stale_prolonged" {
		t.Errorf("expected audio_stale_prolonged after 31s, got %q", reason)
	}
}

func TestEvaluateReactive_WFStaleProlonged(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	now := time.Now()
	h.setHealth(HealthSnapshot{WFStale: true})

	m.mu.Lock()
	reason := m.evaluateReactive(h.getHealth(), now)
	m.mu.Unlock()
	if reason != "" {
		t.Errorf("first tick should not trigger, got %q", reason)
	}

	m.mu.Lock()
	reason = m.evaluateReactive(h.getHealth(), now.Add(31*time.Second))
	m.mu.Unlock()
	if reason != "wf_stale_prolonged" {
		t.Errorf("expected wf_stale_prolonged, got %q", reason)
	}
}

func TestEvaluateReactive_StaleResets(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	now := time.Now()

	// Audio stale starts
	h.setHealth(HealthSnapshot{AudioStale: true})
	m.mu.Lock()
	m.evaluateReactive(h.getHealth(), now)
	m.mu.Unlock()

	// Audio recovers
	h.setHealth(HealthSnapshot{AudioStale: false})
	m.mu.Lock()
	m.evaluateReactive(h.getHealth(), now.Add(10*time.Second))
	m.mu.Unlock()

	// Audio stale again — timer should reset
	h.setHealth(HealthSnapshot{AudioStale: true})
	m.mu.Lock()
	reason := m.evaluateReactive(h.getHealth(), now.Add(20*time.Second))
	m.mu.Unlock()
	if reason != "" {
		t.Errorf("should not trigger yet after reset, got %q", reason)
	}

	// 25s after re-stale — still under threshold
	m.mu.Lock()
	reason = m.evaluateReactive(h.getHealth(), now.Add(45*time.Second))
	m.mu.Unlock()
	if reason != "" {
		t.Errorf("25s after re-stale should not trigger, got %q", reason)
	}

	// 31s after re-stale — should trigger
	m.mu.Lock()
	reason = m.evaluateReactive(h.getHealth(), now.Add(51*time.Second))
	m.mu.Unlock()
	if reason != "audio_stale_prolonged" {
		t.Errorf("expected audio_stale_prolonged, got %q", reason)
	}
}

func TestEvaluateReactive_PriorityOrder(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	// Error state takes priority over everything
	h.setHealth(HealthSnapshot{
		InErrorState:   true,
		TooBusy:        true,
		ReconnectChurn: true,
		AudioStale:     true,
		WFStale:        true,
	})

	m.mu.Lock()
	reason := m.evaluateReactive(h.getHealth(), time.Now())
	m.mu.Unlock()

	if reason != "stream_error" {
		t.Errorf("error state should have highest priority, got %q", reason)
	}
}

func TestEvaluateReactive_Healthy(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	h.setHealth(HealthSnapshot{})

	m.mu.Lock()
	reason := m.evaluateReactive(h.getHealth(), time.Now())
	m.mu.Unlock()

	if reason != "" {
		t.Errorf("healthy stream should not trigger, got %q", reason)
	}
}

func TestEvaluateProactive_NotReady(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	// SNR not ready → no proactive triggers
	m.mu.Lock()
	reason := m.evaluateProactive(time.Now())
	m.mu.Unlock()

	if reason != "" {
		t.Errorf("should not trigger without SNR baseline, got %q", reason)
	}
}

func TestEvaluateProactive_BetterSourceAvailable(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	m.mu.Lock()
	m.snrReady = true
	m.snrBaseline = 20.0
	m.snrFilled = 3
	m.snrSamples[0] = 20.0
	m.snrSamples[1] = 20.0
	m.snrSamples[2] = 20.0
	m.snrIdx = 3
	m.betterCycles = 2
	m.mu.Unlock()

	m.mu.Lock()
	reason := m.evaluateProactive(time.Now())
	m.mu.Unlock()

	if reason != "better_source_available" {
		t.Errorf("expected better_source_available, got %q", reason)
	}
}

func TestEvaluateProactive_BetterSourceNotEnoughCycles(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	m.mu.Lock()
	m.snrReady = true
	m.snrBaseline = 20.0
	m.snrFilled = 3
	m.snrIdx = 3
	m.betterCycles = 1 // needs 2
	m.mu.Unlock()

	m.mu.Lock()
	reason := m.evaluateProactive(time.Now())
	m.mu.Unlock()

	if reason != "" {
		t.Errorf("should not trigger with only 1 cycle, got %q", reason)
	}
}

func TestComputeCooldown_Default(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	m.mu.Lock()
	cd := m.computeCooldown(time.Now())
	m.mu.Unlock()

	if cd != defaultCooldown {
		t.Errorf("expected %v, got %v", defaultCooldown, cd)
	}
}

func TestComputeCooldown_Escalated(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	now := time.Now()
	m.mu.Lock()
	m.switchTimes = []time.Time{
		now.Add(-1 * time.Minute),
		now,
	}
	cd := m.computeCooldown(now)
	m.mu.Unlock()

	if cd != escalatedCooldown {
		t.Errorf("expected %v, got %v", escalatedCooldown, cd)
	}
}

func TestComputeCooldown_Max(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	now := time.Now()
	m.mu.Lock()
	m.switchTimes = []time.Time{
		now.Add(-10 * time.Minute),
		now.Add(-5 * time.Minute),
		now,
	}
	cd := m.computeCooldown(now)
	m.mu.Unlock()

	if cd != maxCooldown {
		t.Errorf("expected %v, got %v", maxCooldown, cd)
	}
}

func TestBlacklist_AddAndPrune(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	m.BlacklistSource("src-A")
	m.BlacklistSource("src-B")

	bl := m.Blacklist()
	if len(bl) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(bl))
	}

	if time.Until(bl["src-A"]) > 31*time.Minute || time.Until(bl["src-A"]) < 29*time.Minute {
		t.Errorf("blacklist duration wrong for src-A: %v", time.Until(bl["src-A"]))
	}

	if time.Until(bl["src-B"]) > 31*time.Minute || time.Until(bl["src-B"]) < 29*time.Minute {
		t.Errorf("blacklist duration wrong for src-B: %v", time.Until(bl["src-B"]))
	}
}

func TestResetBaseline(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	m.mu.Lock()
	m.snrReady = true
	m.snrBaseline = 25.0
	m.snrFilled = 12
	m.snrIdx = 12
	m.betterCycles = 3
	m.mu.Unlock()

	m.ResetBaseline()

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.snrReady {
		t.Error("snrReady should be false after reset")
	}
	if m.snrFilled != 0 {
		t.Error("snrFilled should be 0 after reset")
	}
	if m.betterCycles != 0 {
		t.Error("betterCycles should be 0 after reset")
	}
}

func TestNotifyProbeComplete_IncrementsBetterCycles(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	// Set up: SNR ready, current SNR is 10, suggestion is 30 (advantage = 20 ≥ 15)
	m.mu.Lock()
	m.snrReady = true
	m.snrBaseline = 10.0
	m.snrFilled = 3
	m.snrSamples[0] = 10.0
	m.snrSamples[1] = 10.0
	m.snrSamples[2] = 10.0
	m.snrIdx = 3
	m.mu.Unlock()

	h.mu.Lock()
	h.suggSNR = 30.0
	h.suggSNROK = true
	h.mu.Unlock()

	m.NotifyProbeComplete()

	m.mu.Lock()
	cycles := m.betterCycles
	m.mu.Unlock()

	if cycles != 1 {
		t.Errorf("expected betterCycles=1, got %d", cycles)
	}

	m.NotifyProbeComplete()

	m.mu.Lock()
	cycles = m.betterCycles
	m.mu.Unlock()

	if cycles != 2 {
		t.Errorf("expected betterCycles=2, got %d", cycles)
	}
}

func TestNotifyProbeComplete_ResetWhenNotBetter(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	m.mu.Lock()
	m.snrReady = true
	m.snrFilled = 3
	m.snrSamples[0] = 10.0
	m.snrSamples[1] = 10.0
	m.snrSamples[2] = 10.0
	m.snrIdx = 3
	m.betterCycles = 1
	m.mu.Unlock()

	h.mu.Lock()
	h.suggSNR = 12.0 // only 2 dB better, below threshold
	h.suggSNROK = true
	h.mu.Unlock()

	m.NotifyProbeComplete()

	m.mu.Lock()
	cycles := m.betterCycles
	m.mu.Unlock()

	if cycles != 0 {
		t.Errorf("expected betterCycles=0 (reset), got %d", cycles)
	}
}

func TestTick_CooldownPreventsAction(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	// Put the monitor in cooldown
	m.mu.Lock()
	m.cooldownUntil = time.Now().Add(10 * time.Minute)
	m.mu.Unlock()

	// Health is bad — but cooldown should prevent trigger
	h.setHealth(HealthSnapshot{InErrorState: true})

	m.tick()

	reasons := h.getReasons()
	if len(reasons) != 0 {
		t.Errorf("should not trigger during cooldown, got %v", reasons)
	}
}

func TestStartStop(t *testing.T) {
	h := newHarness()
	m := newTestMonitor(h)

	m.Start()
	time.Sleep(50 * time.Millisecond)
	m.Stop()
	// Should not hang or panic
}
