package filter

type Echo struct {
	buf       []float64
	writePos  int
	feedback  float64
	mix       float64
	bufSize   int
}

func NewEcho(delayMs, feedback, mix float64, sampleRate int) *Echo {
	delaySamples := int(delayMs / 1000.0 * float64(sampleRate))
	if delaySamples < 1 {
		delaySamples = 1
	}
	if feedback > 0.95 {
		feedback = 0.95
	}
	return &Echo{
		buf:      make([]float64, delaySamples),
		feedback: feedback,
		mix:      mix,
		bufSize:  delaySamples,
	}
}

func (e *Echo) Process(samples []float64) {
	for i, s := range samples {
		delayed := e.buf[e.writePos]
		wet := delayed
		e.buf[e.writePos] = s + e.feedback*delayed
		e.writePos = (e.writePos + 1) % e.bufSize
		samples[i] = (1-e.mix)*s + e.mix*wet
	}
}

func (e *Echo) Reset() {
	for i := range e.buf {
		e.buf[i] = 0
	}
	e.writePos = 0
}
