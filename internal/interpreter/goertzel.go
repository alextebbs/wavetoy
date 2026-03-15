package interpreter

import "math"

// Goertzel computes the magnitude of a single frequency bin
// using the Goertzel algorithm. This is much more efficient than
// a full FFT when you only need one or a few frequency bins.
type Goertzel struct {
	coeff      float64
	blockSize  int
	targetFreq float64
	sampleRate float64

	s1, s2 float64
	count  int
}

func NewGoertzel(targetFreq float64, sampleRate float64, blockSize int) *Goertzel {
	k := 0.5 + float64(blockSize)*targetFreq/sampleRate
	w := 2.0 * math.Pi * k / float64(blockSize)
	return &Goertzel{
		coeff:      2.0 * math.Cos(w),
		blockSize:  blockSize,
		targetFreq: targetFreq,
		sampleRate: sampleRate,
	}
}

// ProcessSample feeds one sample and returns (magnitude, true) when
// a full block has been accumulated.
func (g *Goertzel) ProcessSample(sample float64) (float64, bool) {
	s0 := sample + g.coeff*g.s1 - g.s2
	g.s2 = g.s1
	g.s1 = s0
	g.count++

	if g.count >= g.blockSize {
		mag := math.Sqrt(g.s1*g.s1 + g.s2*g.s2 - g.coeff*g.s1*g.s2)
		g.s1 = 0
		g.s2 = 0
		g.count = 0
		return mag, true
	}
	return 0, false
}

func (g *Goertzel) Reset() {
	g.s1 = 0
	g.s2 = 0
	g.count = 0
}

// Retune changes the target frequency without reallocating.
func (g *Goertzel) Retune(targetFreq float64) {
	k := 0.5 + float64(g.blockSize)*targetFreq/g.sampleRate
	w := 2.0 * math.Pi * k / float64(g.blockSize)
	g.coeff = 2.0 * math.Cos(w)
	g.targetFreq = targetFreq
	g.Reset()
}
