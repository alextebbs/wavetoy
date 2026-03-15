package filter

import "math"

const (
	nrFFTSize = 512
	nrHopSize = nrFFTSize / 2 // 50% overlap

	// Noise estimate smoothing. Lower = slower convergence, more stable.
	nrNoiseAlpha = 0.02

	// Minimum number of frames before noise estimate is trusted.
	nrMinNoiseFrames = 8
)

// NoiseReducer implements spectral-subtraction noise reduction with
// overlap-add buffering. It estimates the noise floor per frequency bin
// during quiet moments and subtracts it from the signal spectrum.
type NoiseReducer struct {
	strength float64 // 0.0–1.0: subtraction aggressiveness
	floorDB  float64 // minimum bin level after subtraction (e.g. -20)

	window   [nrFFTSize]float64
	noiseEst [nrFFTSize/2 + 1]float64 // per-bin noise magnitude estimate

	inputBuf [nrFFTSize]float64 // accumulation ring for incoming samples
	inputPos int                // write cursor in inputBuf
	primed   bool               // true once we have a full window

	// Overlap-add buffers:
	// overlapBuf holds the second half of the previous IFFT output,
	// waiting to be added to the first half of the next block.
	// readyBuf holds completed samples ready to be emitted.
	overlapBuf [nrHopSize]float64
	readyBuf   [nrHopSize]float64
	readyPos   int // next read position in readyBuf
	readyCount int // samples available in readyBuf

	// Scratch buffers for FFT (avoid per-frame allocation)
	fftRe [nrFFTSize]float64
	fftIm [nrFFTSize]float64

	noiseFrames int // frames used for noise estimation
}

func NewNoiseReducer(strength, floorDB float64) *NoiseReducer {
	nr := &NoiseReducer{
		strength: strength,
		floorDB:  floorDB,
	}
	for i := 0; i < nrFFTSize; i++ {
		nr.window[i] = 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(nrFFTSize)))
	}
	return nr
}

func (nr *NoiseReducer) Reset() {
	nr.inputPos = 0
	nr.primed = false
	nr.readyPos = 0
	nr.readyCount = 0
	nr.noiseFrames = 0
	for i := range nr.noiseEst {
		nr.noiseEst[i] = 0
	}
	for i := range nr.inputBuf {
		nr.inputBuf[i] = 0
	}
	for i := range nr.overlapBuf {
		nr.overlapBuf[i] = 0
	}
}

// Process applies spectral-subtraction noise reduction in-place.
// The overlap-add scheme introduces a latency of nrHopSize samples (~21ms at 12kHz).
func (nr *NoiseReducer) Process(samples []float64) {
	floor := math.Pow(10, nr.floorDB/20.0)
	out := 0

	for i := 0; i < len(samples); i++ {
		nr.inputBuf[nr.inputPos] = samples[i]
		nr.inputPos++

		if nr.inputPos == nrFFTSize {
			nr.processBlock(floor)
			nr.inputPos = nrHopSize
			copy(nr.inputBuf[:nrHopSize], nr.inputBuf[nrHopSize:])
		}

		if nr.primed && nr.readyCount > 0 {
			samples[out] = nr.readyBuf[nr.readyPos]
			nr.readyPos++
			nr.readyCount--
			out++
		} else {
			samples[out] = 0
			out++
		}
	}
}

func (nr *NoiseReducer) processBlock(floor float64) {
	bins := nrFFTSize/2 + 1

	for i := 0; i < nrFFTSize; i++ {
		nr.fftRe[i] = nr.inputBuf[i] * nr.window[i]
		nr.fftIm[i] = 0
	}

	fft(nr.fftRe[:], nr.fftIm[:])

	var mags [nrFFTSize/2 + 1]float64
	var frameEnergy float64
	for k := 0; k < bins; k++ {
		mags[k] = math.Sqrt(nr.fftRe[k]*nr.fftRe[k] + nr.fftIm[k]*nr.fftIm[k])
		frameEnergy += mags[k] * mags[k]
	}

	avgEnergy := frameEnergy / float64(bins)

	// Determine if this is a "quiet" frame suitable for updating the noise estimate.
	// During the first nrMinNoiseFrames, always update (bootstrap).
	// After that, update only if energy is within 6 dB of the noise floor.
	isQuiet := nr.noiseFrames < nrMinNoiseFrames
	if !isQuiet {
		var noiseEnergy float64
		for k := 0; k < bins; k++ {
			noiseEnergy += nr.noiseEst[k] * nr.noiseEst[k]
		}
		noiseAvg := noiseEnergy / float64(bins)
		if noiseAvg > 0 && avgEnergy < noiseAvg*4.0 {
			isQuiet = true
		}
	}

	if isQuiet {
		alpha := nrNoiseAlpha
		if nr.noiseFrames < nrMinNoiseFrames {
			alpha = 1.0 / float64(nr.noiseFrames+1)
		}
		for k := 0; k < bins; k++ {
			nr.noiseEst[k] = nr.noiseEst[k]*(1.0-alpha) + mags[k]*alpha
		}
		nr.noiseFrames++
	}

	// Spectral subtraction
	for k := 0; k < bins; k++ {
		mag := mags[k]
		noiseMag := nr.noiseEst[k] * nr.strength

		newMag := mag - noiseMag
		minMag := mag * floor
		if newMag < minMag {
			newMag = minMag
		}

		if mag > 1e-10 {
			gain := newMag / mag
			nr.fftRe[k] *= gain
			nr.fftIm[k] *= gain
			if k > 0 && k < nrFFTSize/2 {
				nr.fftRe[nrFFTSize-k] *= gain
				nr.fftIm[nrFFTSize-k] *= gain
			}
		}
	}

	ifft(nr.fftRe[:], nr.fftIm[:])

	// Overlap-add: combine the first half of this block's IFFT output
	// with the stored second half of the previous block. The Hann window
	// with 50% overlap sums to 1.0, so no synthesis window is needed.
	for i := 0; i < nrHopSize; i++ {
		nr.readyBuf[i] = nr.overlapBuf[i] + nr.fftRe[i]
	}
	nr.readyPos = 0
	nr.readyCount = nrHopSize

	// Store the second half for overlap with the next block
	for i := 0; i < nrHopSize; i++ {
		nr.overlapBuf[i] = nr.fftRe[nrHopSize+i]
	}

	nr.primed = true
}
