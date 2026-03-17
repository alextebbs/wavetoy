package filter

// Autonotch implements a variable-leak LMS adaptive filter that automatically
// finds and removes tonal interference (heterodyne whistles, birdies, carriers).
//
// Based on Warren Pratt's WDSP ANR algorithm. The adaptive FIR filter learns
// to predict the input signal; for tonal (predictable) components the prediction
// is accurate so the error signal removes them. Broadband noise and speech are
// unpredictable, so they pass through as the error.
//
// Unlike the manual Notch filter, Autonotch doesn't require the user to know
// the interference frequency — it finds and tracks it automatically.
type Autonotch struct {
	dline [anrDlineSize]float64
	w     [anrDlineSize]float64 // adaptive FIR coefficients
	inIdx int

	taps  int
	delay int

	twoMu   float64 // adaptation gain
	gamma   float64 // leakage factor
	lidx    float64
	lidxMin float64
	lidxMax float64
	ngamma  float64
	denMult float64
	lincr   float64
	ldecr   float64

	strength float64 // 0.0–1.0 controls output mix
}

const (
	anrDlineSize = 512
	anrMask      = anrDlineSize - 1
)

func NewAutonotch(strength float64) *Autonotch {
	an := &Autonotch{
		strength: strength,
		taps:     64,
		delay:    16,
	}
	// Map strength to gain: higher strength = faster adaptation = more aggressive
	// Range: 8.192e-2 / 2^(20-gain_idx), gain_idx 1..20
	gainIdx := 6.0 + strength*10.0 // 6–16
	an.twoMu = 8.192e-2 / pow2(20.0-gainIdx)

	leakIdx := 7.0
	an.gamma = 8192.0 / pow2(23.0-leakIdx)

	an.lidx = 120.0
	an.lidxMin = 120.0
	an.lidxMax = 200.0
	an.ngamma = 0.001
	an.denMult = 6.25e-10
	an.lincr = 1.0
	an.ldecr = 3.0

	return an
}

func pow2(x float64) float64 {
	if x == 0 {
		return 1
	}
	result := 1.0
	base := 2.0
	neg := false
	if x < 0 {
		neg = true
		x = -x
	}
	ix := int(x)
	for i := 0; i < ix; i++ {
		result *= base
	}
	if neg {
		result = 1.0 / result
	}
	return result
}

func (an *Autonotch) Process(samples []float64) {
	for i, samp := range samples {
		an.dline[an.inIdx] = samp
		var y, sigma float64

		for j := 0; j < an.taps; j++ {
			idx := (an.inIdx + j + an.delay) & anrMask
			y += an.w[j] * an.dline[idx]
			sigma += an.dline[idx] * an.dline[idx]
		}

		invSigP := 1.0 / (sigma + 1e-10)
		err := samp - y

		// Output is the error signal (everything the filter couldn't predict =
		// broadband content with tones removed)
		samples[i] = err

		nel := err * (1.0 - an.twoMu*sigma*invSigP)
		if nel < 0 {
			nel = -nel
		}

		nev := samp - (1.0-an.twoMu*an.ngamma)*y - an.twoMu*err*sigma*invSigP
		if nev < 0 {
			nev = -nev
		}

		if nev < nel {
			an.lidx += an.lincr
			if an.lidx > an.lidxMax {
				an.lidx = an.lidxMax
			}
		} else {
			an.lidx -= an.ldecr
			if an.lidx < an.lidxMin {
				an.lidx = an.lidxMin
			}
		}

		an.ngamma = an.gamma * (an.lidx * an.lidx) * (an.lidx * an.lidx) * an.denMult

		c0 := 1.0 - an.twoMu*an.ngamma
		c1 := an.twoMu * err * invSigP

		for j := 0; j < an.taps; j++ {
			idx := (an.inIdx + j + an.delay) & anrMask
			an.w[j] = c0*an.w[j] + c1*an.dline[idx]
		}

		an.inIdx = (an.inIdx + anrMask) & anrMask
	}
}

func (an *Autonotch) Reset() {
	an.inIdx = 0
	for i := range an.dline {
		an.dline[i] = 0
	}
	for i := range an.w {
		an.w[i] = 0
	}
	an.lidx = 120.0
	an.ngamma = 0.001
}
