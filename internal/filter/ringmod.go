package filter

import "math"

type RingModulator struct {
	phase    float64
	phaseInc float64
	mix      float64
}

func NewRingModulator(carrierHz, mix float64, sampleRate int) *RingModulator {
	return &RingModulator{
		phase:    0,
		phaseInc: 2 * math.Pi * carrierHz / float64(sampleRate),
		mix:      mix,
	}
}

func (rm *RingModulator) Process(samples []float64) {
	for i, s := range samples {
		modulated := s * math.Sin(rm.phase)
		samples[i] = (1-rm.mix)*s + rm.mix*modulated
		rm.phase += rm.phaseInc
		if rm.phase >= 2*math.Pi {
			rm.phase -= 2 * math.Pi
		}
	}
}

func (rm *RingModulator) Reset() {
	rm.phase = 0
}
