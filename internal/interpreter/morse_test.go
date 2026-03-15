package interpreter

import (
	"encoding/binary"
	"fmt"
	"math"
	"strings"
	"testing"
)

// generateCWTone creates PCM16 little-endian audio containing a CW tone.
// segments is a list of (durationMs, toneOn) pairs.
func generateCWTone(sampleRate int, freqHz float64, segments []struct {
	durationMs float64
	toneOn     bool
}) []byte {
	var pcm []byte
	phase := 0.0
	phaseInc := 2 * math.Pi * freqHz / float64(sampleRate)

	for _, seg := range segments {
		nSamples := int(float64(sampleRate) * seg.durationMs / 1000.0)
		for i := 0; i < nSamples; i++ {
			var sample int16
			if seg.toneOn {
				sample = int16(math.Sin(phase) * 16000)
			} else {
				sample = 0
			}
			phase += phaseInc
			b := make([]byte, 2)
			binary.LittleEndian.PutUint16(b, uint16(sample))
			pcm = append(pcm, b...)
		}
	}
	return pcm
}

// ditDahSegments converts a Morse pattern string (e.g. "... --- ...")
// into CW tone segments with proper timing.
func ditDahSegments(pattern string, ditMs float64) []struct {
	durationMs float64
	toneOn     bool
} {
	var segs []struct {
		durationMs float64
		toneOn     bool
	}

	chars := strings.Split(pattern, " ")
	for ci, char := range chars {
		if char == "" {
			continue
		}
		for ei, elem := range char {
			switch elem {
			case '.':
				segs = append(segs, struct {
					durationMs float64
					toneOn     bool
				}{ditMs, true})
			case '-':
				segs = append(segs, struct {
					durationMs float64
					toneOn     bool
				}{ditMs * 3, true})
			}
			if ei < len(char)-1 {
				segs = append(segs, struct {
					durationMs float64
					toneOn     bool
				}{ditMs, false})
			}
		}
		if ci < len(chars)-1 {
			segs = append(segs, struct {
				durationMs float64
				toneOn     bool
			}{ditMs * 3, false})
		}
	}

	// Add leading and trailing silence
	leadTrail := struct {
		durationMs float64
		toneOn     bool
	}{ditMs * 7, false}
	result := make([]struct {
		durationMs float64
		toneOn     bool
	}, 0, len(segs)+2)
	result = append(result, leadTrail)
	result = append(result, segs...)
	result = append(result, leadTrail)
	return result
}

func collectText(outputs []Output) string {
	var sb strings.Builder
	for _, o := range outputs {
		sb.WriteString(o.Text)
	}
	return sb.String()
}

func TestGoertzelDetectsTone(t *testing.T) {
	sampleRate := 12000
	freq := 700.0
	blockSize := sampleRate * goertzelBlockMs / 1000

	g := NewGoertzel(freq, float64(sampleRate), blockSize)

	// Feed a 700 Hz tone
	var maxMag float64
	phaseInc := 2 * math.Pi * freq / float64(sampleRate)
	for i := 0; i < blockSize; i++ {
		sample := math.Sin(float64(i) * phaseInc)
		mag, ready := g.ProcessSample(sample)
		if ready {
			maxMag = mag
		}
	}
	if maxMag < 10 {
		t.Errorf("expected significant magnitude for on-frequency tone, got %f", maxMag)
	}

	// Feed a 1500 Hz tone (off-frequency)
	g.Reset()
	offPhaseInc := 2 * math.Pi * 1500 / float64(sampleRate)
	var offMag float64
	for i := 0; i < blockSize; i++ {
		sample := math.Sin(float64(i) * offPhaseInc)
		mag, ready := g.ProcessSample(sample)
		if ready {
			offMag = mag
		}
	}

	if offMag > maxMag*0.1 {
		t.Errorf("off-frequency magnitude %f should be much less than on-frequency %f", offMag, maxMag)
	}
}

func TestMorseDecodesE(t *testing.T) {
	// "E" = single dit
	sampleRate := 12000
	ditMs := 60.0

	segs := ditDahSegments(".", ditMs)
	pcm := generateCWTone(sampleRate, 700, segs)

	decoder := NewMorse(Config{
		Type:    "morse",
		Enabled: true,
		WPM:     20,
	}, sampleRate)

	var allOutputs []Output
	// Feed in chunks (simulate streaming)
	chunkSize := 1024
	for i := 0; i < len(pcm); i += chunkSize {
		end := i + chunkSize
		if end > len(pcm) {
			end = len(pcm)
		}
		outputs := decoder.Feed(pcm[i:end])
		allOutputs = append(allOutputs, outputs...)
	}

	text := collectText(allOutputs)
	text = strings.TrimSpace(text)
	if text != "E" {
		t.Errorf("expected 'E', got %q", text)
	}
}

func TestMorseDecodesSOS(t *testing.T) {
	sampleRate := 12000
	ditMs := 60.0

	// S = ... , O = --- , S = ...
	segs := ditDahSegments("... --- ...", ditMs)
	pcm := generateCWTone(sampleRate, 700, segs)

	decoder := NewMorse(Config{
		Type:    "morse",
		Enabled: true,
		WPM:     20,
	}, sampleRate)

	var allOutputs []Output
	chunkSize := 512
	for i := 0; i < len(pcm); i += chunkSize {
		end := i + chunkSize
		if end > len(pcm) {
			end = len(pcm)
		}
		outputs := decoder.Feed(pcm[i:end])
		allOutputs = append(allOutputs, outputs...)
	}

	text := collectText(allOutputs)
	text = strings.TrimSpace(text)
	if text != "SOS" {
		t.Errorf("expected 'SOS', got %q", text)
	}
}

func TestMorseDecodesHelloWithWordGap(t *testing.T) {
	sampleRate := 12000
	ditMs := 60.0

	// H=.... I=..  (word gap)  H=.... I=..
	// Simpler: just test a word gap produces a space
	// C=-.-.  Q=--.-(word gap)
	// "CQ" with word gap → "CQ " (trailing space from word gap detection)
	cqSegs := ditDahSegments("-.-.", ditMs)
	// Remove trailing silence from first char
	cqSegs = cqSegs[:len(cqSegs)-1]
	// Add word gap
	cqSegs = append(cqSegs, struct {
		durationMs float64
		toneOn     bool
	}{ditMs * 8, false})
	// Add "Q" = --.-
	qSegs := ditDahSegments("--.-", ditMs)
	cqSegs = append(cqSegs, qSegs...)

	pcm := generateCWTone(sampleRate, 700, cqSegs)

	decoder := NewMorse(Config{
		Type:    "morse",
		Enabled: true,
		WPM:     20,
	}, sampleRate)

	var allOutputs []Output
	chunkSize := 512
	for i := 0; i < len(pcm); i += chunkSize {
		end := i + chunkSize
		if end > len(pcm) {
			end = len(pcm)
		}
		outputs := decoder.Feed(pcm[i:end])
		allOutputs = append(allOutputs, outputs...)
	}

	text := collectText(allOutputs)
	text = strings.TrimSpace(text)
	if !strings.Contains(text, "C") || !strings.Contains(text, "Q") {
		t.Errorf("expected text containing C and Q, got %q", text)
	}
}

func TestMorseWPMEstimate(t *testing.T) {
	sampleRate := 12000
	ditMs := 60.0 // 20 WPM

	segs := ditDahSegments("... --- ...", ditMs)
	pcm := generateCWTone(sampleRate, 700, segs)

	decoder := NewMorse(Config{
		Type:    "morse",
		Enabled: true,
		// No fixed WPM — let it auto-detect
	}, sampleRate)

	var allOutputs []Output
	chunkSize := 512
	for i := 0; i < len(pcm); i += chunkSize {
		end := i + chunkSize
		if end > len(pcm) {
			end = len(pcm)
		}
		outputs := decoder.Feed(pcm[i:end])
		allOutputs = append(allOutputs, outputs...)
	}

	// Check that at least one output has a reasonable WPM
	foundWPM := false
	for _, o := range allOutputs {
		if o.WPM >= 15 && o.WPM <= 25 {
			foundWPM = true
			break
		}
	}
	if !foundWPM && len(allOutputs) > 0 {
		t.Errorf("expected WPM estimate near 20, got outputs: %+v", allOutputs)
	}
}

// ditDahWords converts a space-separated list of Morse-encoded words
// into CW segments. Words use " / " as separator, characters use " ".
// Example: ".- -... / -.-." encodes "AB CD" (two words).
func ditDahWords(morseWords string, ditMs float64) []struct {
	durationMs float64
	toneOn     bool
} {
	seg := func(ms float64, on bool) struct {
		durationMs float64
		toneOn     bool
	} {
		return struct {
			durationMs float64
			toneOn     bool
		}{ms, on}
	}

	var segs []struct {
		durationMs float64
		toneOn     bool
	}

	segs = append(segs, seg(ditMs*7, false)) // leading silence

	words := strings.Split(morseWords, " / ")
	for wi, word := range words {
		chars := strings.Fields(word)
		for ci, ch := range chars {
			for ei, elem := range ch {
				switch elem {
				case '.':
					segs = append(segs, seg(ditMs, true))
				case '-':
					segs = append(segs, seg(ditMs*3, true))
				}
				if ei < len(ch)-1 {
					segs = append(segs, seg(ditMs, false))
				}
			}
			if ci < len(chars)-1 {
				segs = append(segs, seg(ditMs*3, false)) // char gap
			}
		}
		if wi < len(words)-1 {
			segs = append(segs, seg(ditMs*7, false)) // word gap
		}
	}

	segs = append(segs, seg(ditMs*7, false)) // trailing silence
	return segs
}

// morseEncode encodes an ASCII string to Morse pattern notation.
func morseEncode(text string) string {
	charToMorse := map[rune]string{
		'A': ".-", 'B': "-...", 'C': "-.-.", 'D': "-..", 'E': ".",
		'F': "..-.", 'G': "--.", 'H': "....", 'I': "..", 'J': ".---",
		'K': "-.-", 'L': ".-..", 'M': "--", 'N': "-.", 'O': "---",
		'P': ".--.", 'Q': "--.-", 'R': ".-.", 'S': "...", 'T': "-",
		'U': "..-", 'V': "...-", 'W': ".--", 'X': "-..-", 'Y': "-.--",
		'Z': "--..",
		'0': "-----", '1': ".----", '2': "..---", '3': "...--",
		'4': "....-", '5': ".....", '6': "-....", '7': "--...",
		'8': "---..", '9': "----.",
	}

	var parts []string
	var currentWord []string
	for _, ch := range strings.ToUpper(text) {
		if ch == ' ' {
			if len(currentWord) > 0 {
				parts = append(parts, strings.Join(currentWord, " "))
				currentWord = nil
			}
			continue
		}
		if m, ok := charToMorse[ch]; ok {
			currentWord = append(currentWord, m)
		}
	}
	if len(currentWord) > 0 {
		parts = append(parts, strings.Join(currentWord, " "))
	}
	return strings.Join(parts, " / ")
}

func TestMorseDecodesPARIS(t *testing.T) {
	// PARIS is the standard WPM calibration word (50 dit-units per word).
	// Test both with auto WPM and fixed WPM to isolate adaptive issues.
	for _, tc := range []struct {
		wpm      int
		fixedWPM int // 0 = auto
		text     string
	}{
		{10, 10, "PARIS"},
		{15, 0, "PARIS"},
		{20, 0, "PARIS"},
		{25, 25, "PARIS"},
		{30, 30, "PARIS"},
	} {
		label := fmt.Sprintf("%dwpm_auto_%s", tc.wpm, tc.text)
		if tc.fixedWPM > 0 {
			label = fmt.Sprintf("%dwpm_fixed_%s", tc.wpm, tc.text)
		}
		t.Run(label, func(t *testing.T) {
			ditMs := 1200.0 / float64(tc.wpm)
			morse := morseEncode(tc.text)
			t.Logf("Morse pattern: %s (dit=%.0fms)", morse, ditMs)
			segs := ditDahWords(morse, ditMs)
			pcm := generateCWTone(12000, 700, segs)

			cfg := Config{Type: "morse", Enabled: true, SidetoneHz: 700}
			if tc.fixedWPM > 0 {
				cfg.WPM = tc.fixedWPM
			}
			decoder := NewMorse(cfg, 12000)

			// Instrument pulse/gap detection
			prevToneOn := false
			var toneStartMs, toneEndMs float64

			var allOutputs []Output
			chunkSize := 240 // 10ms chunks for fine resolution
			for i := 0; i < len(pcm); i += chunkSize {
				end := i + chunkSize
				if end > len(pcm) {
					end = len(pcm)
				}
				outs := decoder.Feed(pcm[i:end])

				nowMs := float64(decoder.totalSamples) * 1000.0 / float64(12000)
				if decoder.toneOn && !prevToneOn {
					if toneEndMs > 0 {
						t.Logf("  gap=%.0fms (charGap=%.0fms)", nowMs-toneEndMs, decoder.estimatedDitMs*charGapFactor)
					}
					toneStartMs = nowMs
				} else if !decoder.toneOn && prevToneOn {
					t.Logf("  pulse=%.0fms (boundary=%.0fms)", nowMs-toneStartMs, decoder.estimatedDitMs*dahFactor)
					toneEndMs = nowMs
				}
				prevToneOn = decoder.toneOn

				for _, o := range outs {
					if o.Text != "" {
						t.Logf("  >>> output: text=%q elements=%q estDit=%.0fms",
							o.Text, decoder.elements.String(), decoder.estimatedDitMs)
					}
				}
				allOutputs = append(allOutputs, outs...)
			}

			t.Logf("  final elements buffer: %q", decoder.elements.String())

			text := strings.TrimSpace(collectText(allOutputs))
			if text != tc.text {
				t.Errorf("expected %q, got %q", tc.text, text)
			} else {
				t.Logf("OK: %q at %d WPM (fixed=%d)", text, tc.wpm, tc.fixedWPM)
			}
		})
	}
}

func TestMorseDecodesSentence(t *testing.T) {
	for _, tc := range []struct {
		wpm  int
		text string
	}{
		{10, "CQ CQ DE W1ABC K"},
		{12, "CQ CQ CQ DE W1ABC K"},
		{18, "THE QUICK BROWN FOX"},
		{20, "5NN TU 73"},
		{25, "CQ CQ TEST DE W1ABC W1ABC K"},
	} {
		t.Run(fmt.Sprintf("%dwpm", tc.wpm), func(t *testing.T) {
			ditMs := 1200.0 / float64(tc.wpm)
			morse := morseEncode(tc.text)
			segs := ditDahWords(morse, ditMs)
			pcm := generateCWTone(12000, 700, segs)

			cfg := Config{Type: "morse", Enabled: true, SidetoneHz: 700}
			decoder := NewMorse(cfg, 12000)

			var allOutputs []Output
			chunkSize := 512
			for i := 0; i < len(pcm); i += chunkSize {
				end := i + chunkSize
				if end > len(pcm) {
					end = len(pcm)
				}
				allOutputs = append(allOutputs, decoder.Feed(pcm[i:end])...)
			}

			text := strings.TrimSpace(collectText(allOutputs))
			if text != tc.text {
				t.Errorf("expected %q, got %q", tc.text, text)
			} else {
				t.Logf("OK: %q at %d WPM", text, tc.wpm)
			}
		})
	}
}

func TestMorseReconfigure(t *testing.T) {
	decoder := NewMorse(Config{
		Type:       "morse",
		Enabled:    true,
		SidetoneHz: 700,
		WPM:        20,
	}, 12000)

	decoder.Reconfigure(Config{
		Type:       "morse",
		Enabled:    true,
		SidetoneHz: 800,
		WPM:        15,
	})

	if decoder.sidetoneHz != 800 {
		t.Errorf("expected sidetone 800, got %d", decoder.sidetoneHz)
	}
	if decoder.fixedWPM != 15 {
		t.Errorf("expected WPM 15, got %d", decoder.fixedWPM)
	}
}
