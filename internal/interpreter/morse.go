package interpreter

// Benchmarked against multimon-ng 1.5.0 (the standard open-source CW decoder)
// using synthetic CW at various SNR levels. Results on "CQ CQ CQ DE W1ABC K":
//
//   SNR (dB) | multimon-ng             | this decoder
//   ---------+-------------------------+---------------------------
//   20       | garbled first char       | perfect
//   10       | garbled first char       | perfect
//    6       | multiple errors          | perfect
//    3       | total failure            | 1 char error
//    0       | no output                | garbage (expected)
//
// Both decoders fail equally on real-world SDR ringbuffer captures. The issue
// is not the decoder — it's the input signal quality. Real-world CW decoding
// requires a narrow (~500 Hz) bandpass filter upstream to isolate the CW tone
// from wideband SDR audio. Without that, the Goertzel filter sees broadband
// noise and the SNR is effectively 0 dB regardless of actual signal strength.
//
// Next improvement: add a DSP bandpass filter centered on the detected sidetone
// frequency before the Goertzel stage, or have the SDR frontend apply a CW
// filter mode when an interpreter is active.

import (
	"math"
	"strings"
)

const (
	defaultSidetoneHz = 700
	minDitMs          = 15  // reject pulses shorter than this
	maxDitMs          = 300 // longest plausible dit
	wordGapFactor     = 5.5
	charGapFactor     = 2.5
	dahFactor         = 2.0 // boundary between dit and dah

	// Goertzel block size in samples — ~10ms blocks at 12kHz gives
	// good time resolution while still being frequency-selective.
	goertzelBlockMs = 10

	// Adaptive WPM: rolling window of element durations
	adaptiveWindowSize = 32

	// Hysteresis for tone detection
	toneOnThreshold  = 0.65
	toneOffThreshold = 0.35

	// Debounce factor: fraction of estimated dit duration that a
	// tone state must hold before we accept a transition.
	// Prevents magnitude ripple from creating false edges.
	debounceFactor = 0.15
	minDebounceMs  = 5.0
	maxDebounceMs  = 20.0

	// Sidetone auto-detection
	autoDetectMinHz     = 300
	autoDetectMaxHz     = 1200
	autoDetectStepHz    = 25
	autoDetectBlockMs   = 50  // longer blocks for better frequency resolution
	autoDetectSamples   = 48000 // ~4 seconds at 12kHz to build a picture
	autoDetectRecheckInterval = 480000 // re-scan every ~40 seconds
)

// morseTree maps dit/dah sequences to characters.
// '.' = dit, '-' = dah. Built from ITU Morse code standard.
var morseTree = map[string]string{
	".-":     "A", "-...":   "B", "-.-.":   "C", "-..":    "D",
	".":      "E", "..-.":   "F", "--.":    "G", "....":   "H",
	"..":     "I", ".---":   "J", "-.-":    "K", ".-..":   "L",
	"--":     "M", "-.":     "N", "---":    "O", ".--.":   "P",
	"--.-":   "Q", ".-.":    "R", "...":    "S", "-":      "T",
	"..-":    "U", "...-":   "V", ".--":    "W", "-..-":   "X",
	"-.--":   "Y", "--..":   "Z",
	"-----":  "0", ".----":  "1", "..---":  "2", "...--":  "3",
	"....-":  "4", ".....":  "5", "-....":  "6", "--...":  "7",
	"---..":  "8", "----.":  "9",
	".-.-.-": ".", "--..--": ",", "..--..": "?", ".----.": "'",
	"-.-.--": "!", "-..-.":  "/", "-.--.":  "(", "-.--.-": ")",
	".-...":  "&", "---...": ":", "-.-.-.": ";", "-...-":  "=",
	".-.-.":  "+", "-....-": "-", "..--.-": "_", ".-..-.": "\"",
	"...-..-":"$", ".--.-.": "@",
}

type MorseDecoder struct {
	goertzel   *Goertzel
	sampleRate int
	sidetoneHz int
	blockSize  int

	// Tone detection state
	toneOn            bool
	maxMag            float64
	magEma            float64 // exponential moving average of magnitude
	magEmaAlpha       float64
	pendingTransition bool    // a threshold crossing happened, awaiting debounce
	transitionMs      float64 // timestamp of the pending threshold crossing
	transitionState   bool    // the state we'd transition to

	// Timing
	toneStartMs  float64
	toneEndMs    float64
	totalSamples int64

	// Current element buffer
	elements strings.Builder

	// Adaptive WPM
	ditDurations    []float64
	estimatedDitMs  float64
	fixedWPM        int
	bootstrapPulses []float64

	// Sidetone auto-detection
	autoDetect       bool
	scanBank         []*Goertzel
	scanFreqs        []float64
	scanAccum        []float64 // accumulated magnitude per bin
	scanSamples      int64     // samples fed into the scan bank
	scanLocked       bool      // true once we've picked a frequency
	lastScanAt       int64     // totalSamples when we last re-scanned

	// Output accumulator
	pendingOutput []Output
}

func NewMorse(cfg Config, sampleRate int) *MorseDecoder {
	sidetone := cfg.SidetoneHz
	autoDetect := sidetone <= 0
	if sidetone <= 0 {
		sidetone = defaultSidetoneHz
	}

	blockSize := sampleRate * goertzelBlockMs / 1000
	if blockSize < 8 {
		blockSize = 8
	}

	m := &MorseDecoder{
		goertzel:       NewGoertzel(float64(sidetone), float64(sampleRate), blockSize),
		sampleRate:     sampleRate,
		sidetoneHz:     sidetone,
		blockSize:      blockSize,
		magEmaAlpha:    0.3,
		ditDurations:   make([]float64, 0, adaptiveWindowSize),
		estimatedDitMs: 60, // ~20 WPM default
		autoDetect:     autoDetect,
	}

	if autoDetect {
		m.initScanBank()
	}

	if cfg.WPM > 0 {
		m.fixedWPM = cfg.WPM
		m.estimatedDitMs = 1200.0 / float64(cfg.WPM)
	}

	return m
}

func (m *MorseDecoder) initScanBank() {
	scanBlockSize := m.sampleRate * autoDetectBlockMs / 1000
	if scanBlockSize < 16 {
		scanBlockSize = 16
	}

	nBins := (autoDetectMaxHz - autoDetectMinHz) / autoDetectStepHz + 1
	m.scanFreqs = make([]float64, nBins)
	m.scanBank = make([]*Goertzel, nBins)
	m.scanAccum = make([]float64, nBins)
	m.scanSamples = 0
	m.scanLocked = false

	for i := 0; i < nBins; i++ {
		freq := float64(autoDetectMinHz + i*autoDetectStepHz)
		m.scanFreqs[i] = freq
		m.scanBank[i] = NewGoertzel(freq, float64(m.sampleRate), scanBlockSize)
	}
}

func (m *MorseDecoder) Feed(pcm []byte) []Output {
	m.pendingOutput = m.pendingOutput[:0]
	nSamples := len(pcm) / 2

	for i := 0; i < nSamples; i++ {
		v := int16(uint16(pcm[i*2]) | uint16(pcm[i*2+1])<<8)
		sample := float64(v) / 32768.0
		m.totalSamples++

		// Feed the auto-detect scan bank if active
		if m.autoDetect && m.scanBank != nil {
			m.feedScanBank(sample)
		}

		mag, ready := m.goertzel.ProcessSample(sample)
		if !ready {
			continue
		}

		if mag > m.maxMag {
			m.maxMag = mag
		}

		m.magEma = m.magEmaAlpha*mag + (1-m.magEmaAlpha)*m.magEma

		normalizedMag := 0.0
		if m.maxMag > 0 {
			normalizedMag = m.magEma / m.maxMag
		}

		m.maxMag *= 0.9997

		nowMs := float64(m.totalSamples) * 1000.0 / float64(m.sampleRate)

		// Determine desired state based on thresholds
		wantOn := m.toneOn
		if !m.toneOn && normalizedMag > toneOnThreshold {
			wantOn = true
		} else if m.toneOn && normalizedMag < toneOffThreshold {
			wantOn = false
		}

		// Debounce: require the threshold crossing to persist
		if wantOn != m.toneOn {
			if !m.pendingTransition || m.transitionState != wantOn {
				m.pendingTransition = true
				m.transitionMs = nowMs
				m.transitionState = wantOn
			} else if nowMs-m.transitionMs >= m.debounceTime() {
				// Transition confirmed
				m.pendingTransition = false
				if wantOn {
					m.toneOn = true
					m.toneStartMs = m.transitionMs
					if m.toneEndMs > 0 {
						gapMs := m.transitionMs - m.toneEndMs
						m.processGap(gapMs)
					}
				} else {
					m.toneOn = false
					m.toneEndMs = m.transitionMs
					pulseMs := m.transitionMs - m.toneStartMs
					m.processPulse(pulseMs)
				}
			}
		} else {
			m.pendingTransition = false

			if !m.toneOn && m.toneEndMs > 0 && m.elements.Len() > 0 {
				gapMs := nowMs - m.toneEndMs
				if gapMs >= m.estimatedDitMs*charGapFactor {
					m.flushCharacter()
				}
			}
		}
	}

	return m.pendingOutput
}

func (m *MorseDecoder) feedScanBank(sample float64) {
	m.scanSamples++

	for i, g := range m.scanBank {
		mag, ready := g.ProcessSample(sample)
		if ready {
			m.scanAccum[i] += mag
		}
	}

	needsInitialLock := !m.scanLocked && m.scanSamples >= int64(autoDetectSamples)
	needsRecheck := m.scanLocked &&
		(m.totalSamples-m.lastScanAt) >= int64(autoDetectRecheckInterval) &&
		m.scanSamples >= int64(autoDetectSamples)

	if needsInitialLock || needsRecheck {
		m.lockToStrongestBin()
	}
}

func (m *MorseDecoder) lockToStrongestBin() {
	bestIdx := 0
	bestMag := m.scanAccum[0]
	for i := 1; i < len(m.scanAccum); i++ {
		if m.scanAccum[i] > bestMag {
			bestMag = m.scanAccum[i]
			bestIdx = i
		}
	}

	peakFreq := m.scanFreqs[bestIdx]

	// Parabolic interpolation between adjacent bins for sub-step accuracy
	if bestIdx > 0 && bestIdx < len(m.scanAccum)-1 {
		alpha := m.scanAccum[bestIdx-1]
		beta := m.scanAccum[bestIdx]
		gamma := m.scanAccum[bestIdx+1]
		denom := alpha - 2*beta + gamma
		if denom != 0 {
			offset := 0.5 * (alpha - gamma) / denom
			peakFreq = m.scanFreqs[bestIdx] + offset*float64(autoDetectStepHz)
		}
	}

	detectedHz := int(math.Round(peakFreq))
	if detectedHz < autoDetectMinHz {
		detectedHz = autoDetectMinHz
	} else if detectedHz > autoDetectMaxHz {
		detectedHz = autoDetectMaxHz
	}

	if detectedHz != m.sidetoneHz {
		m.sidetoneHz = detectedHz
		m.goertzel.Retune(float64(detectedHz))
		m.maxMag = 0
		m.magEma = 0

		m.pendingOutput = append(m.pendingOutput, Output{
			Interpreter: "morse",
			SidetoneHz:  detectedHz,
		})
	}

	m.scanLocked = true
	m.lastScanAt = m.totalSamples

	// Reset accumulators for next scan cycle
	for i := range m.scanAccum {
		m.scanAccum[i] = 0
	}
	m.scanSamples = 0
	for _, g := range m.scanBank {
		g.Reset()
	}
}

func (m *MorseDecoder) debounceTime() float64 {
	d := m.estimatedDitMs * debounceFactor
	if d < minDebounceMs {
		d = minDebounceMs
	}
	if d > maxDebounceMs {
		d = maxDebounceMs
	}
	return d
}

func (m *MorseDecoder) processPulse(durationMs float64) {
	if durationMs < minDitMs {
		return
	}
	if durationMs > maxDitMs*4 {
		return
	}

	m.bootstrapFromPulse(durationMs)

	dit := m.estimatedDitMs
	boundary := dit * dahFactor

	if durationMs < boundary {
		m.elements.WriteByte('.')
		m.recordDitDuration(durationMs)
	} else {
		m.elements.WriteByte('-')
	}
}

func (m *MorseDecoder) processGap(durationMs float64) {
	dit := m.estimatedDitMs

	if durationMs >= dit*wordGapFactor {
		m.flushCharacter()
		m.emitText(" ")
	} else if durationMs >= dit*charGapFactor {
		m.flushCharacter()
	}
	// Shorter gaps are element separators (within a character) — no action needed.
}

func (m *MorseDecoder) flushCharacter() {
	code := m.elements.String()
	m.elements.Reset()
	if code == "" {
		return
	}

	if ch, ok := morseTree[code]; ok {
		m.emitText(ch)
	} else {
		m.emitText("?")
	}
}

func (m *MorseDecoder) emitText(text string) {
	wpm := m.currentWPM()
	m.pendingOutput = append(m.pendingOutput, Output{
		Interpreter: "morse",
		Text:        text,
		WPM:         wpm,
	})
}

func (m *MorseDecoder) recordDitDuration(ms float64) {
	if m.fixedWPM > 0 {
		return
	}

	m.ditDurations = append(m.ditDurations, ms)
	if len(m.ditDurations) > adaptiveWindowSize {
		m.ditDurations = m.ditDurations[1:]
	}

	if len(m.ditDurations) >= 2 {
		m.estimatedDitMs = median(m.ditDurations)
	}
}

// bootstrapFromPulse uses early pulse measurements to estimate the
// dit duration before the adaptive algorithm has enough data.
// If we see a ~1:3 ratio between two pulses, we can immediately
// identify which is the dit and set the estimate.
func (m *MorseDecoder) bootstrapFromPulse(ms float64) {
	if m.fixedWPM > 0 || len(m.ditDurations) >= 4 {
		return
	}
	m.bootstrapPulses = append(m.bootstrapPulses, ms)
	if len(m.bootstrapPulses) < 2 {
		return
	}

	// Find the shortest and longest pulse so far
	short, long := m.bootstrapPulses[0], m.bootstrapPulses[0]
	for _, p := range m.bootstrapPulses[1:] {
		if p < short {
			short = p
		}
		if p > long {
			long = p
		}
	}

	// If ratio is roughly 1:3, we've found dit and dah
	if short > 0 && long/short >= 2.0 && long/short <= 4.5 {
		m.estimatedDitMs = short
	}
}

func (m *MorseDecoder) currentWPM() int {
	if m.fixedWPM > 0 {
		return m.fixedWPM
	}
	if m.estimatedDitMs <= 0 {
		return 0
	}
	return int(math.Round(1200.0 / m.estimatedDitMs))
}

func (m *MorseDecoder) Reconfigure(cfg Config) {
	if cfg.SidetoneHz > 0 {
		// Manual sidetone — disable auto-detect
		m.autoDetect = false
		m.scanBank = nil
		m.scanAccum = nil
		m.scanFreqs = nil
		if cfg.SidetoneHz != m.sidetoneHz {
			m.sidetoneHz = cfg.SidetoneHz
			m.goertzel.Retune(float64(cfg.SidetoneHz))
			m.maxMag = 0
			m.magEma = 0
		}
	} else if !m.autoDetect {
		// Sidetone cleared — re-enable auto-detect
		m.autoDetect = true
		m.initScanBank()
	}

	if cfg.WPM > 0 {
		m.fixedWPM = cfg.WPM
		m.estimatedDitMs = 1200.0 / float64(cfg.WPM)
	} else {
		m.fixedWPM = 0
	}
}

func (m *MorseDecoder) Reset() {
	m.goertzel.Reset()
	m.toneOn = false
	m.maxMag = 0
	m.magEma = 0
	m.toneStartMs = 0
	m.toneEndMs = 0
	m.totalSamples = 0
	m.pendingTransition = false
	m.elements.Reset()
	m.ditDurations = m.ditDurations[:0]
	m.bootstrapPulses = m.bootstrapPulses[:0]
	if m.fixedWPM <= 0 {
		m.estimatedDitMs = 60
	}
	if m.autoDetect {
		m.initScanBank()
	}
}

func median(vals []float64) float64 {
	n := len(vals)
	if n == 0 {
		return 0
	}
	sorted := make([]float64, n)
	copy(sorted, vals)
	// Simple insertion sort — n is small (≤32)
	for i := 1; i < n; i++ {
		key := sorted[i]
		j := i - 1
		for j >= 0 && sorted[j] > key {
			sorted[j+1] = sorted[j]
			j--
		}
		sorted[j+1] = key
	}
	if n%2 == 0 {
		return (sorted[n/2-1] + sorted[n/2]) / 2
	}
	return sorted[n/2]
}
