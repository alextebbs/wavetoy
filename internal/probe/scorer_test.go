package probe

import (
	"math"
	"testing"
)

func TestSnrScore(t *testing.T) {
	tests := []struct {
		snrdB    float64
		expected float64
	}{
		{-10, 0},
		{0, 0},
		{15, 0.5},
		{30, 1.0},
		{50, 1.0},
	}
	for _, tt := range tests {
		got := snrScore(tt.snrdB)
		if math.Abs(got-tt.expected) > 0.001 {
			t.Errorf("snrScore(%.1f) = %.3f, want %.3f", tt.snrdB, got, tt.expected)
		}
	}
}

func TestNoiseFloorScore(t *testing.T) {
	tests := []struct {
		floorDB  float64
		expected float64
	}{
		{-120, 1.0},
		{-110, 1.0},
		{-90, 0.5},
		{-70, 0.0},
		{-60, 0.0},
	}
	for _, tt := range tests {
		got := noiseFloorScore(tt.floorDB)
		if math.Abs(got-tt.expected) > 0.001 {
			t.Errorf("noiseFloorScore(%.1f) = %.3f, want %.3f", tt.floorDB, got, tt.expected)
		}
	}
}

func TestFrameDeliveryScore(t *testing.T) {
	tests := []struct {
		cv       float64
		expected float64
	}{
		{0, 1.0},
		{0.5, 0.5},
		{1.0, 0.0},
		{2.0, 0.0},
	}
	for _, tt := range tests {
		got := frameDeliveryScore(tt.cv)
		if math.Abs(got-tt.expected) > 0.001 {
			t.Errorf("frameDeliveryScore(%.1f) = %.3f, want %.3f", tt.cv, got, tt.expected)
		}
	}
}

func TestLatencyScore(t *testing.T) {
	tests := []struct {
		ms       float64
		expected float64
	}{
		{50, 1.0},
		{100, 1.0},
		{5000, 0.0},
		{10000, 0.0},
		{2550, 0.5},
	}
	for _, tt := range tests {
		got := latencyScore(tt.ms)
		if math.Abs(got-tt.expected) > 0.01 {
			t.Errorf("latencyScore(%.0f) = %.3f, want %.3f", tt.ms, got, tt.expected)
		}
	}
}

func TestSlotAvailabilityScore(t *testing.T) {
	tests := []struct {
		users, maxL int
		expected     float64
	}{
		{0, 4, 1.0},
		{2, 4, 0.5},
		{4, 4, 0.0},
		{0, 0, 0.5}, // unknown capacity
	}
	for _, tt := range tests {
		got := slotAvailabilityScore(tt.users, tt.maxL)
		if math.Abs(got-tt.expected) > 0.001 {
			t.Errorf("slotAvailabilityScore(%d, %d) = %.3f, want %.3f", tt.users, tt.maxL, got, tt.expected)
		}
	}
}

func TestSilenceAgreement(t *testing.T) {
	tests := []struct {
		ref, cand float64
		expected  float64
	}{
		{0.5, 0.5, 1.0},
		{0.0, 1.0, 0.0},
		{0.3, 0.7, 0.6},
	}
	for _, tt := range tests {
		got := silenceAgreement(tt.ref, tt.cand)
		if math.Abs(got-tt.expected) > 0.001 {
			t.Errorf("silenceAgreement(%.1f, %.1f) = %.3f, want %.3f", tt.ref, tt.cand, got, tt.expected)
		}
	}
}

func TestScoreCandidate_WeightsSumToOne(t *testing.T) {
	total := WeightInBandSNR + WeightNoiseFloor + WeightFrameDelivery +
		WeightLatency + WeightSlotAvailability + WeightSilenceAgreement
	if math.Abs(total-1.0) > 0.001 {
		t.Errorf("weights sum to %.3f, should be 1.0", total)
	}
}

func TestScoreCandidate_PerfectCandidate(t *testing.T) {
	ref := AudioSnapshot{SilenceRatio: 0.0}
	cand := AudioSnapshot{
		InBandSNRdB:    30,
		NoiseFloordB:   -110,
		FrameDeliveryCV: 0,
		SilenceRatio:   0.0,
	}

	score, _ := ScoreCandidate(ref, cand, 50, 0, 4)
	expected := WeightInBandSNR*1 + WeightNoiseFloor*1 + WeightFrameDelivery*1 +
		WeightLatency*1 + WeightSlotAvailability*1 + WeightSilenceAgreement*1

	if math.Abs(score-expected) > 0.01 {
		t.Errorf("perfect candidate score = %.3f, want ~%.3f", score, expected)
	}
}

func TestScoreCandidate_TerribleCandidate(t *testing.T) {
	ref := AudioSnapshot{SilenceRatio: 0.0}
	cand := AudioSnapshot{
		InBandSNRdB:    -5,
		NoiseFloordB:   -60,
		FrameDeliveryCV: 2.0,
		SilenceRatio:   1.0,
	}

	score, _ := ScoreCandidate(ref, cand, 10000, 4, 4)
	if score > 0.2 {
		t.Errorf("terrible candidate score = %.3f, should be very low", score)
	}
}

func TestScoreCandidate_MetricsReturned(t *testing.T) {
	ref := AudioSnapshot{SilenceRatio: 0.5}
	cand := AudioSnapshot{
		RMSDB:          -30,
		InBandSNRdB:    20,
		NoiseFloordB:   -45,
		FrameRate:      24.0,
		FrameDeliveryCV: 0.1,
		SilenceRatio:   0.3,
	}

	_, metrics := ScoreCandidate(ref, cand, 300, 2, 8)

	if metrics.AudioRMSDB != -30 {
		t.Errorf("metrics.AudioRMSDB = %.1f, want -30", metrics.AudioRMSDB)
	}
	if metrics.InBandSNRdB != 20 {
		t.Errorf("metrics.InBandSNRdB = %.1f, want 20", metrics.InBandSNRdB)
	}
	if metrics.NoiseFloordB != -45 {
		t.Errorf("metrics.NoiseFloordB = %.1f, want -45", metrics.NoiseFloordB)
	}
	if metrics.LatencyMs != 300 {
		t.Errorf("metrics.LatencyMs = %.1f, want 300", metrics.LatencyMs)
	}
	if metrics.FrameDeliveryCV != 0.1 {
		t.Errorf("metrics.FrameDeliveryCV = %.2f, want 0.1", metrics.FrameDeliveryCV)
	}
}

func TestClamp01(t *testing.T) {
	if clamp01(-0.5) != 0 {
		t.Error("clamp01(-0.5) should be 0")
	}
	if clamp01(1.5) != 1 {
		t.Error("clamp01(1.5) should be 1")
	}
	if clamp01(0.5) != 0.5 {
		t.Error("clamp01(0.5) should be 0.5")
	}
}
