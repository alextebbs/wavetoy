package interpreter

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TestMorseDiagnostics runs the decoder against WAV files with detailed
// timing diagnostics. This helps identify why decoding is failing.
//
//	go test ./internal/interpreter/ -run TestMorseDiagnostics -v
func TestMorseDiagnostics(t *testing.T) {
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Skipf("no testdata directory: %v", err)
	}

	var wavFiles []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".wav") {
			wavFiles = append(wavFiles, filepath.Join("testdata", e.Name()))
		}
	}
	if len(wavFiles) == 0 {
		t.Skip("no .wav files in testdata/")
	}

	for _, path := range wavFiles {
		t.Run(filepath.Base(path), func(t *testing.T) {
			diagMorseWAV(t, path)
		})
	}
}

func diagMorseWAV(t *testing.T, path string) {
	t.Helper()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	hdr, rawAudio, err := parseWAV(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	samples, err := toPCM16Mono(hdr, rawAudio)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if hdr.SampleRate != decoderSampleRate {
		samples = resample16(samples, hdr.SampleRate, decoderSampleRate)
	}

	// Trim to last 3 minutes if longer
	tailSec := 180
	tailSamples := decoderSampleRate * tailSec
	if len(samples) > tailSamples {
		t.Logf("Trimming to last %d seconds (%.0f → %.0f sec)",
			tailSec, float64(len(samples))/float64(decoderSampleRate),
			float64(tailSamples)/float64(decoderSampleRate))
		samples = samples[len(samples)-tailSamples:]
	}

	// Phase 1: Run the sidetone scanner to see what frequency it picks
	t.Log("=== SIDETONE SCAN ===")
	scanResult := scanSidetone(t, samples)
	t.Logf("Top frequencies by energy:")
	for i, r := range scanResult {
		if i >= 10 {
			break
		}
		t.Logf("  %4d Hz  energy=%.1f %s", r.freqHz, r.energy, r.bar)
	}

	bestFreq := float64(scanResult[0].freqHz)
	t.Logf("Selected sidetone: %.0f Hz", bestFreq)

	// Phase 2: Run tone detection at the selected frequency and collect timing
	t.Log("")
	t.Log("=== TONE TIMING ANALYSIS ===")
	pulses, gaps := collectTimings(samples, bestFreq)

	t.Logf("Total pulses (tone-on):  %d", len(pulses))
	t.Logf("Total gaps (tone-off):   %d", len(gaps))

	if len(pulses) > 0 {
		t.Log("")
		t.Log("Pulse duration histogram (ms):")
		printHistogram(t, pulses, 20)

		t.Log("")
		t.Logf("Pulse stats: min=%.0f median=%.0f mean=%.0f max=%.0f",
			pulses[0], pulses[len(pulses)/2],
			mean(pulses), pulses[len(pulses)-1])
	}

	if len(gaps) > 0 {
		t.Log("")
		t.Log("Gap duration histogram (ms):")
		printHistogram(t, gaps, 20)

		t.Logf("Gap stats: min=%.0f median=%.0f mean=%.0f max=%.0f",
			gaps[0], gaps[len(gaps)/2],
			mean(gaps), gaps[len(gaps)-1])
	}

	// Phase 3: Estimate dit duration from pulse clustering
	if len(pulses) > 10 {
		t.Log("")
		t.Log("=== WPM ESTIMATION ===")
		estDit := estimateDitFromPulses(pulses)
		t.Logf("Estimated dit duration: %.0f ms", estDit)
		t.Logf("Estimated WPM: %.0f", 1200.0/estDit)
		t.Logf("Expected dah: ~%.0f ms", estDit*3)
		t.Logf("Expected char gap: ~%.0f ms", estDit*3)
		t.Logf("Expected word gap: ~%.0f ms", estDit*7)
	}

	// Phase 4: Decode with the estimated parameters
	if len(pulses) > 10 {
		estDit := estimateDitFromPulses(pulses)
		estWPM := int(math.Round(1200.0 / estDit))

		t.Log("")
		t.Log("=== DECODE WITH ESTIMATED WPM ===")
		pcm := samplesToBytes(samples)
		text := decodeWithParams(pcm, int(math.Round(bestFreq)), estWPM)
		t.Logf("WPM=%d, Sidetone=%d Hz", estWPM, int(bestFreq))
		t.Logf("Decoded: %q", text)

		t.Log("")
		t.Log("=== DECODE WITH AUTO (for comparison) ===")
		textAuto := decodeWithParams(pcm, 0, 0)
		t.Logf("Decoded: %q", textAuto)
	}
}

type freqEnergy struct {
	freqHz int
	energy float64
	bar    string
}

func scanSidetone(t *testing.T, samples []int16) []freqEnergy {
	t.Helper()

	scanBlockSize := decoderSampleRate * autoDetectBlockMs / 1000
	nBins := (autoDetectMaxHz-autoDetectMinHz)/autoDetectStepHz + 1

	freqs := make([]float64, nBins)
	bank := make([]*Goertzel, nBins)
	accum := make([]float64, nBins)

	for i := 0; i < nBins; i++ {
		freqs[i] = float64(autoDetectMinHz + i*autoDetectStepHz)
		bank[i] = NewGoertzel(freqs[i], float64(decoderSampleRate), scanBlockSize)
	}

	limit := len(samples)
	if limit > decoderSampleRate*30 {
		limit = decoderSampleRate * 30
	}

	for s := 0; s < limit; s++ {
		sample := float64(samples[s]) / 32768.0
		for i, g := range bank {
			mag, ready := g.ProcessSample(sample)
			if ready {
				accum[i] += mag
			}
		}
	}

	maxEnergy := 0.0
	for _, e := range accum {
		if e > maxEnergy {
			maxEnergy = e
		}
	}

	results := make([]freqEnergy, nBins)
	for i := range results {
		barLen := 0
		if maxEnergy > 0 {
			barLen = int(accum[i] / maxEnergy * 40)
		}
		results[i] = freqEnergy{
			freqHz: int(freqs[i]),
			energy: accum[i],
			bar:    strings.Repeat("█", barLen),
		}
	}

	sort.Slice(results, func(i, j int) bool {
		return results[i].energy > results[j].energy
	})

	return results
}

func collectTimings(samples []int16, toneFreq float64) (pulses, gaps []float64) {
	// Use the actual decoder with small chunks (10ms) to capture
	// transitions at full resolution.
	decoder := NewMorse(Config{
		Type:       "morse",
		Enabled:    true,
		SidetoneHz: int(math.Round(toneFreq)),
	}, decoderSampleRate)

	pcm := samplesToBytes(samples)
	chunkBytes := decoderSampleRate * 10 / 1000 * 2 // 10ms chunks for fine resolution
	prevToneOn := false
	var toneStartMs, toneEndMs float64

	for i := 0; i < len(pcm); i += chunkBytes {
		end := i + chunkBytes
		if end > len(pcm) {
			end = len(pcm)
		}
		decoder.Feed(pcm[i:end])

		nowMs := float64(decoder.totalSamples) * 1000.0 / float64(decoderSampleRate)
		if decoder.toneOn && !prevToneOn {
			toneStartMs = nowMs
			if toneEndMs > 0 {
				gapMs := nowMs - toneEndMs
				if gapMs > 1 && gapMs < 5000 {
					gaps = append(gaps, gapMs)
				}
			}
		} else if !decoder.toneOn && prevToneOn {
			toneEndMs = nowMs
			pulseMs := nowMs - toneStartMs
			if pulseMs > 1 && pulseMs < 5000 {
				pulses = append(pulses, pulseMs)
			}
		}
		prevToneOn = decoder.toneOn
	}

	sort.Float64s(pulses)
	sort.Float64s(gaps)
	return
}

func printHistogram(t *testing.T, sorted []float64, nBuckets int) {
	t.Helper()
	if len(sorted) == 0 {
		return
	}

	lo := sorted[0]
	hi := sorted[len(sorted)-1]

	// Cap at 99th percentile to avoid outlier-stretched histograms
	p99Idx := int(float64(len(sorted)) * 0.99)
	if p99Idx < len(sorted) {
		hi = sorted[p99Idx]
	}
	if hi <= lo {
		hi = lo + 1
	}

	bucketWidth := (hi - lo) / float64(nBuckets)
	counts := make([]int, nBuckets)

	for _, v := range sorted {
		idx := int((v - lo) / bucketWidth)
		if idx >= nBuckets {
			idx = nBuckets - 1
		}
		if idx < 0 {
			idx = 0
		}
		counts[idx]++
	}

	maxCount := 0
	for _, c := range counts {
		if c > maxCount {
			maxCount = c
		}
	}

	for i, c := range counts {
		bucketLo := lo + float64(i)*bucketWidth
		bucketHi := bucketLo + bucketWidth
		barLen := 0
		if maxCount > 0 {
			barLen = c * 40 / maxCount
		}
		t.Logf("  %5.0f-%5.0f ms [%4d] %s",
			bucketLo, bucketHi, c, strings.Repeat("█", barLen))
	}
}

func mean(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range vals {
		sum += v
	}
	return sum / float64(len(vals))
}

// estimateDitFromPulses finds the dit cluster using valley detection.
// In well-formed Morse, pulses cluster around ditMs and 3*ditMs.
func estimateDitFromPulses(sorted []float64) float64 {
	// Take the 25th percentile as a starting estimate for dit duration,
	// since dits should be the shorter cluster and more numerous.
	p25Idx := len(sorted) / 4
	estimate := sorted[p25Idx]

	// Refine: take the median of all pulses shorter than 2x the estimate
	var shortPulses []float64
	for _, p := range sorted {
		if p < estimate*2.5 {
			shortPulses = append(shortPulses, p)
		}
	}
	if len(shortPulses) > 3 {
		estimate = shortPulses[len(shortPulses)/2]
	}

	return estimate
}

func decodeWithParams(pcm []byte, sidetoneHz int, wpm int) string {
	cfg := Config{
		Type:       "morse",
		Enabled:    true,
		SidetoneHz: sidetoneHz,
		WPM:        wpm,
	}

	decoder := New(cfg, decoderSampleRate, func(string, string, string) {})
	if decoder == nil {
		return "<nil decoder>"
	}

	var sb strings.Builder
	chunkBytes := decoderSampleRate / 5 // 200ms chunks
	for i := 0; i < len(pcm); i += chunkBytes {
		end := i + chunkBytes
		if end > len(pcm) {
			end = len(pcm)
		}
		outputs := decoder.Feed(pcm[i:end])
		for _, o := range outputs {
			if o.Text != "" {
				sb.WriteString(o.Text)
			}
		}
	}

	silence := make([]byte, decoderSampleRate*2)
	outputs := decoder.Feed(silence)
	for _, o := range outputs {
		if o.Text != "" {
			sb.WriteString(o.Text)
		}
	}

	return sb.String()
}

// TestSidetoneSpectrumDump prints a full frequency spectrum for debugging.
func TestSidetoneSpectrumDump(t *testing.T) {
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Skipf("no testdata directory: %v", err)
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".wav") {
			continue
		}
		path := filepath.Join("testdata", e.Name())
		t.Run(e.Name(), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			hdr, rawAudio, err := parseWAV(data)
			if err != nil {
				t.Fatal(err)
			}
			samples, err := toPCM16Mono(hdr, rawAudio)
			if err != nil {
				t.Fatal(err)
			}
			if hdr.SampleRate != decoderSampleRate {
				samples = resample16(samples, hdr.SampleRate, decoderSampleRate)
			}

			scanBlockSize := decoderSampleRate * autoDetectBlockMs / 1000
			t.Log("Frequency spectrum (300-1200 Hz):")

			maxE := 0.0
			type bin struct {
				hz     int
				energy float64
			}
			var bins []bin

			for hz := autoDetectMinHz; hz <= autoDetectMaxHz; hz += 10 {
				g := NewGoertzel(float64(hz), float64(decoderSampleRate), scanBlockSize)
				energy := 0.0
				limit := len(samples)
				if limit > decoderSampleRate*20 {
					limit = decoderSampleRate * 20
				}
				for i := 0; i < limit; i++ {
					mag, ready := g.ProcessSample(float64(samples[i]) / 32768.0)
					if ready {
						energy += mag
					}
				}
				bins = append(bins, bin{hz, energy})
				if energy > maxE {
					maxE = energy
				}
			}

			for _, b := range bins {
				barLen := 0
				if maxE > 0 {
					barLen = int(b.energy / maxE * 60)
				}
				marker := " "
				if barLen > 30 {
					marker = "◄"
				}
				t.Logf("  %4d Hz %s %s",
					b.hz, strings.Repeat("█", barLen), marker)
			}
		})
	}
}

// TestDecodeGrid tries multiple sidetone/WPM combinations to find
// the best decode for a file.
func TestDecodeGrid(t *testing.T) {
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Skipf("no testdata directory: %v", err)
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".wav") {
			continue
		}
		path := filepath.Join("testdata", e.Name())
		t.Run(e.Name(), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			hdr, rawAudio, err := parseWAV(data)
			if err != nil {
				t.Fatal(err)
			}
			samples, err := toPCM16Mono(hdr, rawAudio)
			if err != nil {
				t.Fatal(err)
			}
			if hdr.SampleRate != decoderSampleRate {
				samples = resample16(samples, hdr.SampleRate, decoderSampleRate)
			}
			tailSamples := decoderSampleRate * 180
			if len(samples) > tailSamples {
				samples = samples[len(samples)-tailSamples:]
			}
			pcm := samplesToBytes(samples)

			wpmList := []int{5, 8, 10, 12, 15, 18, 20, 25}
			sidetones := []int{0, 500, 525, 550, 600, 700, 800}

			for _, st := range sidetones {
				for _, wpm := range wpmList {
					text := decodeWithParams(pcm, st, wpm)
					label := fmt.Sprintf("st=%4d wpm=%2d", st, wpm)

					// Score: ratio of alphanumeric to total, fewer ? is better
					alpha := 0
					qmark := 0
					for _, c := range text {
						if (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == ' ' {
							alpha++
						}
						if c == '?' {
							qmark++
						}
					}
					total := len(text)
					score := 0.0
					if total > 0 {
						score = float64(alpha) / float64(total) * 100
					}
					preview := text
					if len(preview) > 80 {
						preview = preview[:80] + "..."
					}
					t.Logf("  %s  score=%5.1f%%  ?=%3d  len=%4d  %q",
						label, score, qmark, total, preview)
				}
			}
		})
	}
}
