package interpreter

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"fmt"
)

// Config is the per-stream interpreter configuration, stored as JSONB.
type Config struct {
	Type    string `json:"type,omitempty"`    // "morse", "voice", etc.
	Enabled bool   `json:"enabled,omitempty"`

	// Morse-specific
	SidetoneHz int `json:"sidetone_hz,omitempty"` // 0 = auto-detect
	WPM        int `json:"wpm,omitempty"`         // 0 = auto-detect

	// Voice-specific
	SourceLang string `json:"source_lang,omitempty"` // "" = auto-detect
	ModelSize  string `json:"model_size,omitempty"`  // "tiny", "base", "small"
}

func (c *Config) Scan(src interface{}) error {
	if src == nil {
		return nil
	}
	var data []byte
	switch v := src.(type) {
	case []byte:
		data = v
	case string:
		data = []byte(v)
	default:
		return fmt.Errorf("interpreter.Config.Scan: unsupported type %T", src)
	}
	if len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, c)
}

func (c Config) Value() (driver.Value, error) {
	return json.Marshal(c)
}

// Output is a decoded result pushed to clients via WebSocket.
type Output struct {
	Interpreter string   `json:"interpreter"`
	Text        string   `json:"text,omitempty"`
	WPM         int      `json:"wpm,omitempty"`
	SidetoneHz  int      `json:"sidetone_hz,omitempty"`
	Clear       bool     `json:"clear,omitempty"`
	Language    string   `json:"language,omitempty"`  // voice: detected source language
	Status      string   `json:"status,omitempty"`    // diagnostic status line for the UI
	Progress    *float64 `json:"progress,omitempty"`  // 0.0–1.0 chunk buffer fill (voice)
}

// Interpreter decodes structured information from a PCM audio stream.
type Interpreter interface {
	// Feed processes a PCM16 little-endian audio frame.
	// Decoded output (if any) is returned synchronously.
	// For async interpreters (voice), Feed returns nil and output
	// is delivered via the callback set by SetOutputCallback.
	Feed(pcm []byte) []Output

	// Reconfigure updates parameters without restarting.
	Reconfigure(cfg Config)

	// Reset clears internal state.
	Reset()
}

// AsyncInterpreter extends Interpreter for decoders whose output is
// produced asynchronously (e.g. voice, where inference takes seconds).
// Feed() returns nil; results arrive via the registered callback.
type AsyncInterpreter interface {
	Interpreter
	SetOutputCallback(func(Output))
}

// LogFunc is a stream-scoped logging function for interpreter diagnostics.
type LogFunc func(level, action, msg string)

// New creates an interpreter for the given config. Returns nil if the
// type is unknown or the interpreter is disabled.
func New(cfg Config, sampleRate int, logFn LogFunc) Interpreter {
	if !cfg.Enabled {
		return nil
	}
	if logFn == nil {
		logFn = func(_, _, _ string) {}
	}
	switch cfg.Type {
	case "morse":
		return NewMorse(cfg, sampleRate)
	case "voice":
		return NewVoice(cfg, sampleRate, logFn)
	default:
		return nil
	}
}

// Runner manages an interpreter goroutine for a stream.
// It subscribes to PCM frames and pushes decoded output via a callback.
type Runner struct {
	cancel     context.CancelFunc
	outputCh   chan Output
	sampleRate int
}

// NewRunner starts an interpreter that reads from audioCh and
// sends decoded output to outputFn. Call Stop() to shut it down.
func NewRunner(cfg Config, sampleRate int, audioCh <-chan []byte, outputFn func(Output), logFn LogFunc) *Runner {
	ctx, cancel := context.WithCancel(context.Background())
	r := &Runner{
		cancel:     cancel,
		outputCh:   make(chan Output, 64),
		sampleRate: sampleRate,
	}

	interp := New(cfg, sampleRate, logFn)
	if interp == nil {
		cancel()
		return r
	}

	// Decode goroutine
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case frame, ok := <-audioCh:
				if !ok {
					return
				}
				outputs := interp.Feed(frame)
				for _, o := range outputs {
					select {
					case r.outputCh <- o:
					default:
					}
				}
			}
		}
	}()

	// Dispatch goroutine
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case o, ok := <-r.outputCh:
				if !ok {
					return
				}
				outputFn(o)
			}
		}
	}()

	return r
}

func (r *Runner) Stop() {
	if r.cancel != nil {
		r.cancel()
	}
}
