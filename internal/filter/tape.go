package filter

import "math"

const (
	wowHz    = 1.2
	flutterHz = 6.5
)

type TapeSaturator struct {
	drive      float64
	wowFlutter float64
	sampleRate float64

	maxDelaySamples int
	delayBuf        []float64
	writePos        int

	wowPhaseInc    float64
	flutterPhaseInc float64
	wowPhase       float64
	flutterPhase   float64

	lpCoeff float64
	lpState float64
}

func NewTapeSaturator(drive, wowFlutter float64, sampleRate int) *TapeSaturator {
	sr := float64(sampleRate)
	maxDelay := int(sr * 2 / 1000)
	if maxDelay < 1 {
		maxDelay = 1
	}
	coeff := 0.3 + 0.5*(1-drive)
	return &TapeSaturator{
		drive:           drive,
		wowFlutter:      wowFlutter,
		sampleRate:      sr,
		maxDelaySamples: maxDelay,
		delayBuf:        make([]float64, maxDelay),
		wowPhaseInc:     2 * math.Pi * wowHz / sr,
		flutterPhaseInc: 2 * math.Pi * flutterHz / sr,
		lpCoeff:         coeff,
	}
}

func (t *TapeSaturator) Process(samples []float64) {
	drive := t.drive
	wowFlutter := t.wowFlutter
	bufSize := len(t.delayBuf)

	for i, s := range samples {
		driven := s * (1 + drive*3)
		var saturated float64
		if driven >= 0 {
			saturated = driven - drive*driven*driven
		} else {
			saturated = driven + drive*0.5*driven*driven
		}
		if saturated > 1.0 {
			saturated = 1.0
		} else if saturated < -1.0 {
			saturated = -1.0
		}

		var delayed float64
		if wowFlutter > 0 {
			modDepth := wowFlutter * (0.7*math.Sin(t.wowPhase) + 0.3*math.Sin(t.flutterPhase))
			t.wowPhase += t.wowPhaseInc
			t.flutterPhase += t.flutterPhaseInc
			if t.wowPhase >= 2*math.Pi {
				t.wowPhase -= 2 * math.Pi
			} else if t.wowPhase < 0 {
				t.wowPhase += 2 * math.Pi
			}
			if t.flutterPhase >= 2*math.Pi {
				t.flutterPhase -= 2 * math.Pi
			} else if t.flutterPhase < 0 {
				t.flutterPhase += 2 * math.Pi
			}

			delaySamples := (1 + modDepth) * float64(t.maxDelaySamples) / 2
			if delaySamples < 0 {
				delaySamples = 0
			}
			if delaySamples > float64(t.maxDelaySamples) {
				delaySamples = float64(t.maxDelaySamples)
			}

			t.delayBuf[t.writePos] = saturated
			t.writePos = (t.writePos + 1) % bufSize

			readPos := float64(t.writePos) - delaySamples
			for readPos < 0 {
				readPos += float64(bufSize)
			}
			readPos = math.Mod(readPos, float64(bufSize))

			idx0 := int(math.Floor(readPos)) % bufSize
			idx1 := (idx0 + 1) % bufSize
			frac := readPos - math.Floor(readPos)
			delayed = t.delayBuf[idx0]*(1-frac) + t.delayBuf[idx1]*frac
		} else {
			delayed = saturated
		}

		t.lpState += t.lpCoeff * (delayed - t.lpState)
		samples[i] = t.lpState
	}
}

func (t *TapeSaturator) Reset() {
	for i := range t.delayBuf {
		t.delayBuf[i] = 0
	}
	t.writePos = 0
	t.wowPhase = 0
	t.flutterPhase = 0
	t.lpState = 0
}
