package filter

import "math"

// fft computes an in-place radix-2 Cooley-Tukey FFT.
// len(re) and len(im) must be equal and a power of two.
func fft(re, im []float64) {
	n := len(re)
	if n <= 1 {
		return
	}

	// Bit-reversal permutation
	j := 0
	for i := 1; i < n; i++ {
		bit := n >> 1
		for j&bit != 0 {
			j ^= bit
			bit >>= 1
		}
		j ^= bit
		if i < j {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}

	// Butterfly stages
	for size := 2; size <= n; size <<= 1 {
		half := size >> 1
		angleStep := -2.0 * math.Pi / float64(size)
		wRe := math.Cos(angleStep)
		wIm := math.Sin(angleStep)

		for start := 0; start < n; start += size {
			curRe, curIm := 1.0, 0.0
			for k := 0; k < half; k++ {
				u := start + k
				v := u + half
				tRe := curRe*re[v] - curIm*im[v]
				tIm := curRe*im[v] + curIm*re[v]
				re[v] = re[u] - tRe
				im[v] = im[u] - tIm
				re[u] += tRe
				im[u] += tIm
				curRe, curIm = curRe*wRe-curIm*wIm, curRe*wIm+curIm*wRe
			}
		}
	}
}

// ifft computes an in-place inverse FFT by conjugating, running fft, then
// conjugating and scaling.
func ifft(re, im []float64) {
	n := len(re)
	for i := range im {
		im[i] = -im[i]
	}
	fft(re, im)
	scale := 1.0 / float64(n)
	for i := range re {
		re[i] *= scale
		im[i] = -im[i] * scale
	}
}
