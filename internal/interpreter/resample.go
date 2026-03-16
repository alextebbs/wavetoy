package interpreter

// resample12to16 converts PCM int16 at 12 kHz to float32 at 16 kHz using
// linear interpolation. Output is normalized to [-1, 1].
func resample12to16(in []int16) []float32 {
	if len(in) == 0 {
		return nil
	}
	const ratio = 12000.0 / 16000.0 // 0.75
	outLen := int(float64(len(in)) / ratio)
	out := make([]float32, outLen)
	for i := range out {
		srcPos := float64(i) * ratio
		idx := int(srcPos)
		frac := float32(srcPos - float64(idx))
		if idx+1 < len(in) {
			out[i] = (float32(in[idx])*(1-frac) + float32(in[idx+1])*frac) / 32768.0
		} else if idx < len(in) {
			out[i] = float32(in[idx]) / 32768.0
		}
	}
	return out
}
