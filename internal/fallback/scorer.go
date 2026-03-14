package fallback

import "math"

const (
	WeightSilenceAgreement     = 0.30
	WeightSpectralSimilarity   = 0.25
	WeightRMSSimilarity        = 0.15
	WeightNoiseFloorSimilarity = 0.10
	WeightFrameRate            = 0.10
	WeightLatency              = 0.10

	ExpectedFrameRate = 24.0
	MinScoreThreshold = 0.1
)

func ScoreCandidate(reference AudioSnapshot, candidate AudioSnapshot, latencyMs float64) (float64, ProbeMetrics) {
	rmsSim := rmsSimilarity(reference.RMSDB, candidate.RMSDB)
	floorSim := noiseFloorSimilarity(reference.FloorRMSDB, candidate.FloorRMSDB)
	silenceAgree := silenceAgreement(reference.SilenceRatio, candidate.SilenceRatio)
	spectralSim := spectralSimilarity(reference.WFBinsInBand, candidate.WFBinsInBand)
	frameRateNorm := clamp01(candidate.FrameRate / ExpectedFrameRate)
	latencyNorm := latencyScore(latencyMs)

	score := WeightSilenceAgreement*silenceAgree +
		WeightSpectralSimilarity*spectralSim +
		WeightRMSSimilarity*rmsSim +
		WeightNoiseFloorSimilarity*floorSim +
		WeightFrameRate*frameRateNorm +
		WeightLatency*latencyNorm

	metrics := ProbeMetrics{
		AudioRMSDB:           candidate.RMSDB,
		RMSSimilarity:        rmsSim,
		SilenceAgreement:     silenceAgree,
		SpectralSimilarity:   spectralSim,
		NoiseFloorSimilarity: floorSim,
		FrameRate:            candidate.FrameRate,
		LatencyMs:            latencyMs,
	}

	return score, metrics
}

func rmsSimilarity(refDB, candDB float64) float64 {
	delta := math.Abs(candDB - refDB)
	return clamp01(1.0 - delta/30.0)
}

func noiseFloorSimilarity(refDB, candDB float64) float64 {
	delta := math.Abs(candDB - refDB)
	return clamp01(1.0 - delta/20.0)
}

func silenceAgreement(refRatio, candRatio float64) float64 {
	return clamp01(1.0 - math.Abs(candRatio-refRatio))
}

func spectralSimilarity(refBins, candBins []float64) float64 {
	if len(refBins) == 0 || len(candBins) == 0 {
		return 0.5
	}

	n := len(refBins)
	if len(candBins) < n {
		n = len(candBins)
	}

	var dotProduct, magRef, magCand float64
	for i := 0; i < n; i++ {
		dotProduct += refBins[i] * candBins[i]
		magRef += refBins[i] * refBins[i]
		magCand += candBins[i] * candBins[i]
	}

	denom := math.Sqrt(magRef) * math.Sqrt(magCand)
	if denom < 1e-12 {
		return 1.0
	}

	cos := dotProduct / denom
	return clamp01(cos)
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
