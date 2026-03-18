package filter

import "math"

type Wobble struct {
	rate       float64
	rangeHz    float64
	resonance  float64
	baseHz     float64
	sampleRate float64
	phaseInc   float64
	low        float64
	band       float64
	phase      float64
}

func NewWobble(rate, rangeHz, resonance, baseHz float64, sampleRate int) *Wobble {
	if resonance > 0.95 {
		resonance = 0.95
	}
	sr := float64(sampleRate)
	return &Wobble{
		rate:       rate,
		rangeHz:    rangeHz,
		resonance:  resonance,
		baseHz:     baseHz,
		sampleRate: sr,
		phaseInc:   2 * math.Pi * rate / sr,
	}
}

func (w *Wobble) Process(samples []float64) {
	for i, s := range samples {
		lfoVal := 0.5 * (1 + math.Sin(w.phase))
		w.phase += w.phaseInc
		if w.phase >= 2*math.Pi {
			w.phase -= 2 * math.Pi
		} else if w.phase < 0 {
			w.phase += 2 * math.Pi
		}

		cutoffHz := w.baseHz + w.rangeHz*lfoVal
		if cutoffHz < 20 {
			cutoffHz = 20
		}
		maxCutoff := w.sampleRate / 2
		if cutoffHz > maxCutoff {
			cutoffHz = maxCutoff
		}

		f := 2 * math.Sin(math.Pi*cutoffHz/w.sampleRate)
		q := 1 - w.resonance

		w.low += f * w.band
		high := s - w.low - q*w.band
		w.band += f * high

		samples[i] = w.low
	}
}

func (w *Wobble) Reset() {
	w.low = 0
	w.band = 0
	w.phase = 0
}
