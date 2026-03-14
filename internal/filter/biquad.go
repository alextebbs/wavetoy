package filter

import "math"

// biquad implements a second-order IIR filter (direct form I).
// Coefficients follow the Audio EQ Cookbook (Robert Bristow-Johnson).
type biquad struct {
	b0, b1, b2 float64
	a1, a2     float64
	x1, x2     float64
	y1, y2     float64
}

func (bq *biquad) process(samples []float64) {
	for i, x := range samples {
		y := bq.b0*x + bq.b1*bq.x1 + bq.b2*bq.x2 - bq.a1*bq.y1 - bq.a2*bq.y2
		bq.x2 = bq.x1
		bq.x1 = x
		bq.y2 = bq.y1
		bq.y1 = y
		samples[i] = y
	}
}

func (bq *biquad) reset() {
	bq.x1, bq.x2 = 0, 0
	bq.y1, bq.y2 = 0, 0
}

// LowPass is a second-order Butterworth low-pass filter (12 dB/oct rolloff).
type LowPass struct{ bq biquad }

func NewLowPass(cutoffHz, sampleRate float64) *LowPass {
	w0 := 2 * math.Pi * cutoffHz / sampleRate
	cosW0 := math.Cos(w0)
	alpha := math.Sin(w0) / (2 * math.Sqrt2) // Q = 1/√2 for Butterworth

	a0 := 1 + alpha
	lp := &LowPass{}
	lp.bq.b0 = (1 - cosW0) / 2 / a0
	lp.bq.b1 = (1 - cosW0) / a0
	lp.bq.b2 = (1 - cosW0) / 2 / a0
	lp.bq.a1 = (-2 * cosW0) / a0
	lp.bq.a2 = (1 - alpha) / a0
	return lp
}

func (lp *LowPass) Process(samples []float64) { lp.bq.process(samples) }
func (lp *LowPass) Reset()                    { lp.bq.reset() }

// HighPass is a second-order Butterworth high-pass filter (12 dB/oct rolloff).
type HighPass struct{ bq biquad }

func NewHighPass(cutoffHz, sampleRate float64) *HighPass {
	w0 := 2 * math.Pi * cutoffHz / sampleRate
	cosW0 := math.Cos(w0)
	alpha := math.Sin(w0) / (2 * math.Sqrt2)

	a0 := 1 + alpha
	hp := &HighPass{}
	hp.bq.b0 = (1 + cosW0) / 2 / a0
	hp.bq.b1 = -(1 + cosW0) / a0
	hp.bq.b2 = (1 + cosW0) / 2 / a0
	hp.bq.a1 = (-2 * cosW0) / a0
	hp.bq.a2 = (1 - alpha) / a0
	return hp
}

func (hp *HighPass) Process(samples []float64) { hp.bq.process(samples) }
func (hp *HighPass) Reset()                    { hp.bq.reset() }

// Notch (band-reject) filter removes a narrow frequency band while
// passing everything else. Use it to kill constant tonal interference
// like heterodyne whistles, birdies, or power-supply whine.
type Notch struct{ bq biquad }

func NewNotch(centerHz, q, sampleRate float64) *Notch {
	if q <= 0 {
		q = 10
	}
	w0 := 2 * math.Pi * centerHz / sampleRate
	cosW0 := math.Cos(w0)
	alpha := math.Sin(w0) / (2 * q)

	a0 := 1 + alpha
	n := &Notch{}
	n.bq.b0 = 1 / a0
	n.bq.b1 = -2 * cosW0 / a0
	n.bq.b2 = 1 / a0
	n.bq.a1 = -2 * cosW0 / a0
	n.bq.a2 = (1 - alpha) / a0
	return n
}

func (n *Notch) Process(samples []float64) { n.bq.process(samples) }
func (n *Notch) Reset()                    { n.bq.reset() }
