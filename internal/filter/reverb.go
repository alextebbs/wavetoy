package filter

const reverbFeedback = 0.84
const reverbAllpassCoef = 0.5

var combBaseDelays = [4]int{1116, 1188, 1277, 1356}
var allpassBaseDelays = [2]int{225, 556}

type Reverb struct {
	roomSize float64
	damping  float64
	mix      float64

	combBuf    [4][]float64
	combPos    [4]int
	combState  [4]float64
	combSize   [4]int
	allpassBuf [2][]float64
	allpassPos [2]int
	allpassSize [2]int
}

func NewReverb(roomSize, damping, mix float64, sampleRate int) *Reverb {
	scale := roomSize * float64(sampleRate) / 12000.0
	r := &Reverb{
		roomSize: roomSize,
		damping:  damping,
		mix:      mix,
	}
	for i := 0; i < 4; i++ {
		d := int(float64(combBaseDelays[i]) * scale)
		if d < 1 {
			d = 1
		}
		r.combBuf[i] = make([]float64, d)
		r.combSize[i] = d
	}
	for i := 0; i < 2; i++ {
		d := int(float64(allpassBaseDelays[i]) * scale)
		if d < 1 {
			d = 1
		}
		r.allpassBuf[i] = make([]float64, d)
		r.allpassSize[i] = d
	}
	return r
}

func (r *Reverb) Process(samples []float64) {
	for i, dry := range samples {
		combSum := 0.0
		for j := 0; j < 4; j++ {
			delayed := r.combBuf[j][r.combPos[j]]
			r.combState[j] = delayed*(1-r.damping) + r.combState[j]*r.damping
			r.combBuf[j][r.combPos[j]] = dry + reverbFeedback*r.combState[j]
			r.combPos[j] = (r.combPos[j] + 1) % r.combSize[j]
			combSum += delayed
		}
		x := combSum
		for j := 0; j < 2; j++ {
			delayed := r.allpassBuf[j][r.allpassPos[j]]
			out := -x + delayed
			r.allpassBuf[j][r.allpassPos[j]] = x + reverbAllpassCoef*delayed
			r.allpassPos[j] = (r.allpassPos[j] + 1) % r.allpassSize[j]
			x = out
		}
		samples[i] = (1-r.mix)*dry + r.mix*x
	}
}

func (r *Reverb) Reset() {
	for i := 0; i < 4; i++ {
		for j := range r.combBuf[i] {
			r.combBuf[i][j] = 0
		}
		r.combPos[i] = 0
		r.combState[i] = 0
	}
	for i := 0; i < 2; i++ {
		for j := range r.allpassBuf[i] {
			r.allpassBuf[i][j] = 0
		}
		r.allpassPos[i] = 0
	}
}
