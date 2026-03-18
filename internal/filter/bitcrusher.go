package filter

import "math"

type Bitcrusher struct {
	step       float64
	holdPeriod float64
	skipHold   bool
	counter    float64
	heldValue  float64
}

func NewBitcrusher(bits int, crushRate float64, sampleRate int) *Bitcrusher {
	if bits < 1 {
		bits = 1
	}
	if bits > 16 {
		bits = 16
	}
	step := 2.0 / (math.Exp2(float64(bits)) - 1)
	holdPeriod := float64(sampleRate) / crushRate
	return &Bitcrusher{
		step:       step,
		holdPeriod: holdPeriod,
		skipHold:   crushRate >= float64(sampleRate),
		counter:    holdPeriod,
	}
}

func (b *Bitcrusher) Process(samples []float64) {
	step := b.step
	for i, s := range samples {
		q := math.Round(s/step) * step
		if q > 1.0 {
			q = 1.0
		} else if q < -1.0 {
			q = -1.0
		}
		if b.skipHold {
			samples[i] = q
			continue
		}
		b.counter++
		if b.counter >= b.holdPeriod {
			b.heldValue = q
			b.counter -= b.holdPeriod
		}
		samples[i] = b.heldValue
	}
}

func (b *Bitcrusher) Reset() {
	b.counter = b.holdPeriod
	b.heldValue = 0
}
