package filter

import "math"

const (
	nrFFTSize = 512
	nrHopSize = nrFFTSize / 2 // 50% overlap
	nrBins    = nrFFTSize/2 + 1

	nrSNRPrioMinDB = -30.0
	nrGainLimit    = 0.001
	nrSmoothWidth  = 4
)

// NoiseReducer implements MMSE-STSA noise reduction (Ephraim-Malah 1984)
// with speech probability tracking and overlap-add buffering.
//
// Compared to basic spectral subtraction, MMSE-STSA produces significantly
// cleaner output with fewer "musical noise" artifacts by using:
//   - Per-bin speech probability for continuous noise estimation
//   - Decision-directed a priori SNR smoothing
//   - Ephraim-Malah optimal gain function
//   - Dynamic frequency averaging to reduce musical noise
type NoiseReducer struct {
	strength float64 // 0.0–1.0: maps to alpha (decision-directed smoothing)
	floorDB  float64 // minimum gain in dB (e.g. -20)

	sampleRate float64

	window [nrFFTSize]float64

	// Per-bin state
	noiseEst [nrBins]float64 // noise power estimate
	snrPrio  [nrBins]float64 // a priori SNR
	snrPost  [nrBins]float64 // a posteriori SNR
	hkOld    [nrBins]float64 // previous frame gain squared * post SNR
	pslp     [nrBins]float64 // smoothed speech probability
	gainBuf  [nrBins]float64 // gain factors (before/after frequency smoothing)
	xt       [nrBins]float64 // smoothed noise+signal power for speech prob

	inputBuf [nrFFTSize]float64
	inputPos int
	primed   bool

	overlapBuf [nrHopSize]float64
	readyBuf   [nrHopSize]float64
	readyPos   int
	readyCount int

	fftRe [nrFFTSize]float64
	fftIm [nrFFTSize]float64

	initPhase int // 0=first_time, 1=calibrating, 2=running
	initCount int

	// Derived from sample rate
	ax float64 // noise smoothing factor
	ap float64 // speech probability smoothing factor

	// Derived from strength/config
	alpha    float64 // decision-directed smoothing (from strength)
	xih1     float64 // a priori SNR under H1
	xih1r    float64 // 1/(1+xih1) - 1
	pfac     float64 // (1/pspri - 1) * (1 + xih1)
	gainFloor float64 // minimum gain (linear, from floorDB)
}

func NewNoiseReducer(strength, floorDB float64) *NoiseReducer {
	nr := &NoiseReducer{
		strength: strength,
		floorDB:  floorDB,
	}
	for i := 0; i < nrFFTSize; i++ {
		// sqrt-Hann window for perfect reconstruction with overlap-add
		nr.window[i] = math.Sqrt(0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(nrFFTSize))))
	}
	nr.computeDerived(12000)
	return nr
}

func (nr *NoiseReducer) computeDerived(sampleRate float64) {
	nr.sampleRate = sampleRate
	tinc := 1.0 / (sampleRate / float64(nrFFTSize) * 2)
	tax := -tinc / math.Log(0.8)
	tap := -tinc / math.Log(0.9)
	nr.ax = math.Exp(-tinc / tax)
	nr.ap = math.Exp(-tinc / tap)

	// Map strength (0–1) to alpha (0.70–0.99). Higher alpha = more smoothing = less
	// aggressive but fewer artifacts. Lower alpha = more aggressive.
	nr.alpha = 0.70 + (1.0-nr.strength)*0.29

	asnr := math.Pow(10, 30.0/10.0) // 30 dB active SNR
	nr.xih1 = asnr
	nr.xih1r = 1.0/(1.0+nr.xih1) - 1.0

	const pspri = 0.5
	nr.pfac = (1.0/pspri - 1.0) * (1.0 + nr.xih1)

	nr.gainFloor = math.Pow(10, nr.floorDB/20.0)
}

func (nr *NoiseReducer) Reset() {
	nr.inputPos = 0
	nr.primed = false
	nr.readyPos = 0
	nr.readyCount = 0
	nr.initPhase = 0
	nr.initCount = 0
	for i := range nr.noiseEst {
		nr.noiseEst[i] = 0
		nr.hkOld[i] = 1.0
		nr.snrPost[i] = 2.0
		nr.snrPrio[i] = 1.0
		nr.pslp[i] = 0.5
		nr.xt[i] = 0
		nr.gainBuf[i] = 1.0
	}
	for i := range nr.inputBuf {
		nr.inputBuf[i] = 0
	}
	for i := range nr.overlapBuf {
		nr.overlapBuf[i] = 0
	}
}

// Process applies MMSE-STSA noise reduction in-place.
func (nr *NoiseReducer) Process(samples []float64) {
	out := 0

	for i := 0; i < len(samples); i++ {
		nr.inputBuf[nr.inputPos] = samples[i]
		nr.inputPos++

		if nr.inputPos == nrFFTSize {
			nr.processBlock()
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

func (nr *NoiseReducer) processBlock() {
	// Apply analysis window and FFT
	for i := 0; i < nrFFTSize; i++ {
		nr.fftRe[i] = nr.inputBuf[i] * nr.window[i]
		nr.fftIm[i] = 0
	}

	fft(nr.fftRe[:], nr.fftIm[:])

	// Compute squared magnitude (power) per bin
	var xPow [nrBins]float64
	for k := 0; k < nrBins; k++ {
		xPow[k] = nr.fftRe[k]*nr.fftRe[k] + nr.fftIm[k]*nr.fftIm[k]
	}

	const psthr = 0.99
	const pnsaf = 0.01

	snrPrioMin := math.Pow(10, nrSNRPrioMinDB/10.0)

	switch nr.initPhase {
	case 0:
		// First frame: initialize
		for k := 0; k < nrBins; k++ {
			nr.gainBuf[k] = 1.0
			nr.hkOld[k] = 1.0
			nr.noiseEst[k] = 0.0
			nr.pslp[k] = 0.5
			nr.xt[k] = 0.5 * xPow[k]
		}
		nr.initPhase = 1
		nr.initCount = 0

	case 1:
		// Calibration: average first 20 frames (~100ms) to bootstrap noise estimate
		for k := 0; k < nrBins; k++ {
			nr.noiseEst[k] += 0.05 * xPow[k]
			nr.xt[k] = 0.5 * nr.noiseEst[k]
		}
		nr.initCount++
		if nr.initCount > 19 {
			nr.initPhase = 2
		}

	case 2:
		// MMSE noise estimation with speech probability
		for k := 0; k < nrBins; k++ {
			denom := nr.xt[k]
			if denom < 1e-30 {
				denom = 1e-30
			}
			ph1y := 1.0 / (1.0 + nr.pfac*math.Exp(nr.xih1r*xPow[k]/denom))
			nr.pslp[k] = nr.ap*nr.pslp[k] + (1.0-nr.ap)*ph1y

			if nr.pslp[k] > psthr {
				ph1y = 1.0 - pnsaf
			} else if ph1y > 1.0 {
				ph1y = 1.0
			}

			xtr := (1.0-ph1y)*xPow[k] + ph1y*nr.xt[k]
			nr.xt[k] = nr.ax*nr.xt[k] + (1.0-nr.ax)*xtr
		}

		// A posteriori and a priori SNR estimation (decision-directed)
		for k := 0; k < nrBins; k++ {
			noise := nr.xt[k]
			if noise < 1e-30 {
				noise = 1e-30
			}
			post := xPow[k] / noise
			if post > 1000.0 {
				post = 1000.0
			}
			if post < snrPrioMin {
				post = snrPrioMin
			}
			nr.snrPost[k] = post

			prioDD := nr.alpha*nr.hkOld[k] + (1.0-nr.alpha)*math.Max(post-1.0, 0.0)
			if prioDD < 0 {
				prioDD = 0
			}
			nr.snrPrio[k] = prioDD
		}

		// Ephraim-Malah gain function
		for k := 0; k < nrBins; k++ {
			v := nr.snrPrio[k] * nr.snrPost[k] / (1.0 + nr.snrPrio[k])
			g := (1.0 / nr.snrPost[k]) * math.Sqrt(0.7212*v+v*v)
			if g < nrGainLimit {
				g = nrGainLimit
			}
			if g < nr.gainFloor {
				g = nr.gainFloor
			}
			nr.gainBuf[k] = g
			nr.hkOld[k] = nr.snrPost[k] * g * g
		}

		// Dynamic frequency averaging to reduce musical noise
		var prePower, postPower float64
		for k := 0; k < nrBins; k++ {
			prePower += xPow[k]
			postPower += nr.gainBuf[k] * nr.gainBuf[k] * xPow[k]
		}

		var nn int
		if prePower > 1e-30 {
			ratio := postPower / prePower
			if ratio > 0.4 {
				nn = 1
			} else {
				nn = 1 + 2*int(0.5+float64(nrSmoothWidth)*(1.0-ratio/0.4))
			}
		} else {
			nn = 1
		}

		if nn > 1 {
			var smoothed [nrBins]float64
			half := nn / 2
			for k := 0; k < nrBins; k++ {
				lo := k - half
				if lo < 0 {
					lo = 0
				}
				hi := k + half
				if hi >= nrBins {
					hi = nrBins - 1
				}
				var sum float64
				for m := lo; m <= hi; m++ {
					sum += nr.gainBuf[m]
				}
				smoothed[k] = sum / float64(hi-lo+1)
			}
			copy(nr.gainBuf[:], smoothed[:])
		}
	}

	// Apply gain to spectrum
	for k := 0; k < nrBins; k++ {
		g := nr.gainBuf[k]
		nr.fftRe[k] *= g
		nr.fftIm[k] *= g
		if k > 0 && k < nrFFTSize/2 {
			nr.fftRe[nrFFTSize-k] *= g
			nr.fftIm[nrFFTSize-k] *= g
		}
	}

	ifft(nr.fftRe[:], nr.fftIm[:])

	// Apply synthesis window (sqrt-Hann) after IFFT
	for i := 0; i < nrFFTSize; i++ {
		nr.fftRe[i] *= nr.window[i]
	}

	// Overlap-add
	for i := 0; i < nrHopSize; i++ {
		nr.readyBuf[i] = nr.overlapBuf[i] + nr.fftRe[i]
	}
	nr.readyPos = 0
	nr.readyCount = nrHopSize

	for i := 0; i < nrHopSize; i++ {
		nr.overlapBuf[i] = nr.fftRe[nrHopSize+i]
	}

	nr.primed = true
}
