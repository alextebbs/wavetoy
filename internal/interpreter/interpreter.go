package interpreter

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"fmt"
)

// Config is the per-stream interpreter configuration, stored as JSONB.
type Config struct {
	Type    string `json:"type,omitempty"`    // "morse", "rtty", etc.
	Enabled bool   `json:"enabled,omitempty"`

	// Morse-specific
	SidetoneHz int `json:"sidetone_hz,omitempty"` // 0 = auto-detect
	WPM        int `json:"wpm,omitempty"`         // 0 = auto-detect
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
	Interpreter string `json:"interpreter"`
	Text        string `json:"text,omitempty"`
	WPM         int    `json:"wpm,omitempty"`
	SidetoneHz  int    `json:"sidetone_hz,omitempty"`
	Clear       bool   `json:"clear,omitempty"`
}

// Interpreter decodes structured information from a PCM audio stream.
type Interpreter interface {
	// Feed processes a PCM16 little-endian audio frame.
	// Decoded output (if any) is returned.
	Feed(pcm []byte) []Output

	// Reconfigure updates parameters without restarting.
	Reconfigure(cfg Config)

	// Reset clears internal state.
	Reset()
}

// New creates an interpreter for the given config. Returns nil if the
// type is unknown or the interpreter is disabled.
func New(cfg Config, sampleRate int) Interpreter {
	if !cfg.Enabled {
		return nil
	}
	switch cfg.Type {
	case "morse":
		return NewMorse(cfg, sampleRate)
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
func NewRunner(cfg Config, sampleRate int, audioCh <-chan []byte, outputFn func(Output)) *Runner {
	ctx, cancel := context.WithCancel(context.Background())
	r := &Runner{
		cancel:     cancel,
		outputCh:   make(chan Output, 64),
		sampleRate: sampleRate,
	}

	interp := New(cfg, sampleRate)
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
