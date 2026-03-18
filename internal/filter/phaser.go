package filter

import "math"

const (
	phaserMinFreq = 100
	phaserMaxFreq = 4000
)

type Phaser struct {
	rate       float64
	depth      float64
	stages     int
	mix        float64
	sampleRate float64
	phaseInc   float64
	phase      float64
	x1, y1     []float64
}

func NewPhaser(rate, depth float64, stages int, mix float64, sampleRate int) *Phaser {
	if stages < 2 {
		stages = 2
	}
	if stages > 12 {
		stages = 12
	}
	sr := float64(sampleRate)
	return &Phaser{
		rate:       rate,
		depth:      depth,
		stages:     stages,
		mix:        mix,
		sampleRate: sr,
		phaseInc:   2 * math.Pi * rate / sr,
		x1:         make([]float64, stages),
		y1:         make([]float64, stages),
	}
}

func (p *Phaser) Process(samples []float64) {
	for i, dry := range samples {
		lfoVal := 0.5 * (1 + math.Sin(p.phase))
		p.phase += p.phaseInc
		sweepFreq := phaserMinFreq + (phaserMaxFreq-phaserMinFreq)*p.depth*lfoVal
		w := math.Tan(math.Pi * sweepFreq / p.sampleRate)
		a1 := (1 - w) / (1 + w)

		in := dry
		for s := 0; s < p.stages; s++ {
			out := a1*in + p.x1[s] - a1*p.y1[s]
			p.x1[s] = in
			p.y1[s] = out
			in = out
		}
		samples[i] = (1-p.mix)*dry + p.mix*in
	}
}

func (p *Phaser) Reset() {
	for i := range p.x1 {
		p.x1[i] = 0
		p.y1[i] = 0
	}
	p.phase = 0
}
