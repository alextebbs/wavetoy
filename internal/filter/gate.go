package filter

import "math"

// NoiseGate silences audio when the signal level drops below a threshold.
// Uses per-sample envelope smoothing with attack/release/hold to avoid
// clicky transitions.
type NoiseGate struct {
	thresholdLin float64
	holdSamples  int
	attackCoeff  float64
	releaseCoeff float64

	envelope    float64
	holdCounter int
}

func NewNoiseGate(thresholdDB, holdMs, attackMs, releaseMs float64, sampleRate int) *NoiseGate {
	sr := float64(sampleRate)

	if attackMs <= 0 {
		attackMs = 5
	}
	if releaseMs <= 0 {
		releaseMs = 50
	}

	return &NoiseGate{
		thresholdLin: math.Pow(10, thresholdDB/20.0),
		holdSamples:  int(holdMs / 1000.0 * sr),
		attackCoeff:  1.0 - math.Exp(-1.0/(attackMs/1000.0*sr)),
		releaseCoeff: 1.0 - math.Exp(-1.0/(releaseMs/1000.0*sr)),
	}
}

func (ng *NoiseGate) Process(samples []float64) {
	for i, s := range samples {
		var target float64
		if math.Abs(s) > ng.thresholdLin {
			target = 1.0
			ng.holdCounter = ng.holdSamples
		} else if ng.holdCounter > 0 {
			target = 1.0
			ng.holdCounter--
		}

		if target > ng.envelope {
			ng.envelope += ng.attackCoeff * (target - ng.envelope)
		} else {
			ng.envelope += ng.releaseCoeff * (target - ng.envelope)
		}

		samples[i] = s * ng.envelope
	}
}

func (ng *NoiseGate) Reset() {
	ng.envelope = 0
	ng.holdCounter = 0
}
