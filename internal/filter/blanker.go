package filter

import "math"

// NoiseBlanker detects and suppresses impulse noise (clicks, pops, static
// crashes, ignition noise) by comparing instantaneous magnitude against a
// moving average. When a spike exceeds the threshold ratio, the output is
// blanked (replaced with silence) for a short gate period.
//
// A delay line ensures the blanking starts slightly before the impulse
// arrives at the output, preventing the leading edge of the click from
// leaking through.
type NoiseBlanker struct {
	threshold float64 // ratio multiplier (higher = less sensitive)

	delayBuf  []float64
	magBuf    []float64
	dPtr      int
	mPtr      int
	magSum    float64
	blankCount int

	delaySamples int
	gateSamples  int
	magSamples   int
}

func NewNoiseBlanker(threshold float64, sampleRate int) *NoiseBlanker {
	// threshold: 0–100 sensitivity. Map to ratio used for comparison.
	// Lower threshold value = more sensitive blanking.
	if threshold < 0 {
		threshold = 0
	}
	if threshold > 100 {
		threshold = 100
	}

	sr := float64(sampleRate)

	// Gate: ~0.5ms blanking window
	gateSamples := int(0.0005 * sr)
	if gateSamples < 1 {
		gateSamples = 1
	}
	if gateSamples > 4096 {
		gateSamples = 4096
	}

	// Magnitude averaging window: ~5ms
	magSamples := int(0.005 * sr)
	if magSamples < 1 {
		magSamples = 1
	}
	if magSamples > 32768 {
		magSamples = 32768
	}

	delaySamples := gateSamples / 2
	if delaySamples < 1 {
		delaySamples = 1
	}

	ratio := 0.005 * threshold * float64(magSamples)

	return &NoiseBlanker{
		threshold:    ratio,
		delayBuf:     make([]float64, delaySamples+1),
		magBuf:       make([]float64, magSamples+1),
		delaySamples: delaySamples,
		gateSamples:  gateSamples,
		magSamples:   magSamples,
	}
}

func (nb *NoiseBlanker) Process(samples []float64) {
	for i, samp := range samples {
		mag := math.Abs(samp)

		// Update moving average of magnitude
		nb.magSum -= nb.magBuf[nb.mPtr]
		nb.magSum += mag
		nb.magBuf[nb.mPtr] = mag
		nb.mPtr++
		if nb.mPtr > nb.magSamples {
			nb.mPtr = 0
		}

		// Pull oldest sample from delay buffer, insert new one
		oldest := nb.delayBuf[nb.dPtr]
		nb.delayBuf[nb.dPtr] = samp
		nb.dPtr++
		if nb.dPtr > nb.delaySamples {
			nb.dPtr = 0
		}

		// Check if this sample is an impulse
		if mag*nb.threshold > nb.magSum {
			nb.blankCount = nb.gateSamples
		}

		if nb.blankCount > 0 {
			nb.blankCount--
			samples[i] = 0
		} else {
			samples[i] = oldest
		}
	}
}

func (nb *NoiseBlanker) Reset() {
	nb.dPtr = 0
	nb.mPtr = 0
	nb.magSum = 0
	nb.blankCount = 0
	for i := range nb.delayBuf {
		nb.delayBuf[i] = 0
	}
	for i := range nb.magBuf {
		nb.magBuf[i] = 0
	}
}
