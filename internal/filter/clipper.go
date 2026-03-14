package filter

import "math"

// SoftClipper applies a tanh saturation curve that smoothly compresses
// peaks instead of hard-clipping. Stateless — no Reset needed.
type SoftClipper struct {
	drive   float64
	ceiling float64
}

func NewSoftClipper(driveDB, ceilingDB float64) *SoftClipper {
	return &SoftClipper{
		drive:   math.Pow(10, driveDB/20.0),
		ceiling: math.Pow(10, ceilingDB/20.0),
	}
}

func (sc *SoftClipper) Process(samples []float64) {
	c := sc.ceiling
	invC := sc.drive / c
	for i, s := range samples {
		samples[i] = c * math.Tanh(s*invC)
	}
}

func (sc *SoftClipper) Reset() {}
