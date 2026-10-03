package probe

import "math"

const (
	WeightInBandSNR        = 0.40
	WeightNoiseFloor       = 0.15
	WeightFrameDelivery    = 0.20
	WeightLatency          = 0.10
	WeightSlotAvailability = 0.05
	WeightSilenceAgreement = 0.10

	ExpectedFrameRate = 24.0
	MinScoreThreshold = 0.1
)

func ScoreCandidate(reference AudioSnapshot, candidate AudioSnapshot, latencyMs float64, slotUsers, slotMax int) (float64, ProbeMetrics) {
	snrNorm := snrScore(candidate.InBandSNRdB)
	noiseFloorNorm := noiseFloorScore(candidate.NoiseFloordB)
	frameDeliveryNorm := frameDeliveryScore(candidate.FrameDeliveryCV)
	latencyNorm := latencyScore(latencyMs)
	slotNorm := slotAvailabilityScore(slotUsers, slotMax)
	silenceAgree := silenceAgreement(reference.SilenceRatio, candidate.SilenceRatio)

	score := WeightInBandSNR*snrNorm +
		WeightNoiseFloor*noiseFloorNorm +
		WeightFrameDelivery*frameDeliveryNorm +
		WeightLatency*latencyNorm +
		WeightSlotAvailability*slotNorm +
		WeightSilenceAgreement*silenceAgree

	score = clamp01(score)

	metrics := ProbeMetrics{
		AudioRMSDB:       candidate.RMSDB,
		SilenceAgreement: silenceAgree,
		FrameRate:        candidate.FrameRate,
		FrameDeliveryCV:  candidate.FrameDeliveryCV,
		LatencyMs:        latencyMs,
		InBandSNRdB:      candidate.InBandSNRdB,
		NoiseFloordB:     candidate.NoiseFloordB,
		SlotAvailability: slotNorm,
	}

	return score, metrics
}

// snrScore normalizes in-band SNR to 0-1. 0 dB or below = 0, 30+ dB = 1.
func snrScore(snrdB float64) float64 {
	if snrdB <= 0 {
		return 0
	}
	return clamp01(snrdB / 30.0)
}

// noiseFloorScore normalizes the absolute noise floor (dBm).
// Lower is better: -110 dBm or below = 1.0, -70 dBm or above = 0.
func noiseFloorScore(floorDB float64) float64 {
	if floorDB <= -110 {
		return 1.0
	}
	if floorDB >= -70 {
		return 0.0
	}
	return clamp01((-70.0 - floorDB) / 40.0)
}

// frameDeliveryScore converts coefficient of variation to a score.
// CV of 0 = perfectly steady = 1.0. CV of 1.0+ = very jittery = 0.
func frameDeliveryScore(cv float64) float64 {
	if cv <= 0 {
		return 1.0
	}
	return clamp01(1.0 - cv)
}

func silenceAgreement(refRatio, candRatio float64) float64 {
	return clamp01(1.0 - math.Abs(candRatio-refRatio))
}

func slotAvailabilityScore(users, maxListeners int) float64 {
	if maxListeners <= 0 {
		return 0.5
	}
	return clamp01(1.0 - float64(users)/float64(maxListeners))
}

func latencyScore(ms float64) float64 {
	if ms <= 100 {
		return 1.0
	}
	if ms >= 5000 {
		return 0.0
	}
	return clamp01(1.0 - (ms-100)/(5000-100))
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
