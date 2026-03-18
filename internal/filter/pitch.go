package filter

import "math"

const (
	pitchGrainSize = 128
	pitchHopSize   = 64
	pitchBufSize   = 2048
)

type PitchShifter struct {
	pitchRatio float64
	buf        []float64
	writePos   float64
	readPos    float64
	hann       [pitchGrainSize]float64
	overlap    [pitchGrainSize]float64
	outPos     int
}

func NewPitchShifter(semitones float64, sampleRate int) *PitchShifter {
	ps := &PitchShifter{
		pitchRatio: math.Pow(2, semitones/12.0),
		buf:        make([]float64, pitchBufSize),
		writePos:   float64(pitchBufSize),
		readPos:    0,
	}
	for i := 0; i < pitchGrainSize; i++ {
		ps.hann[i] = 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(pitchGrainSize)))
	}
	return ps
}

func (ps *PitchShifter) Process(samples []float64) {
	for _, s := range samples {
		idx := int(ps.writePos) % pitchBufSize
		ps.buf[idx] = s
		ps.writePos++
	}

	n := len(samples)
	outIdx := 0
	minRead := ps.writePos - float64(pitchBufSize)
	if ps.readPos < minRead {
		ps.readPos = minRead
	}

	for outIdx < n {
		for ps.outPos < pitchHopSize && outIdx < n {
			samples[outIdx] = ps.overlap[ps.outPos]
			outIdx++
			ps.outPos++
		}
		if ps.outPos >= pitchHopSize {
			for i := 0; i < pitchHopSize; i++ {
				ps.overlap[i] = ps.overlap[i+pitchHopSize]
			}
			for i := pitchHopSize; i < pitchGrainSize; i++ {
				ps.overlap[i] = 0
			}
			ps.outPos = 0
		}

		for ps.outPos == 0 && outIdx < n {
			needRead := ps.readPos + float64(pitchGrainSize-1)*ps.pitchRatio
			if needRead >= ps.writePos {
				break
			}

			for i := 0; i < pitchGrainSize; i++ {
				pos := ps.readPos + float64(i)*ps.pitchRatio
				idx := int(math.Floor(pos))
				frac := pos - math.Floor(pos)
				a := ps.buf[idx%pitchBufSize]
				b := ps.buf[(idx+1)%pitchBufSize]
				s := a + frac*(b-a)
				ps.overlap[i] += s * ps.hann[i]
			}
			ps.readPos += float64(pitchHopSize) * ps.pitchRatio
		}
	}

	for outIdx < n {
		samples[outIdx] = 0
		outIdx++
	}
}

func (ps *PitchShifter) Reset() {
	for i := range ps.buf {
		ps.buf[i] = 0
	}
	for i := range ps.overlap {
		ps.overlap[i] = 0
	}
	ps.writePos = float64(pitchBufSize)
	ps.readPos = 0
	ps.outPos = 0
}
