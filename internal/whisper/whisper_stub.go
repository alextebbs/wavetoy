//go:build !whisper

package whisper

import (
	"fmt"
	"time"
)

type Context struct{}

type Segment struct {
	Text  string
	Start time.Duration
	End   time.Duration
}

type InferenceParams struct {
	Task     string
	Language string
	Threads  int
}

func LoadModel(_ string) (*Context, error) {
	return nil, fmt.Errorf("whisper: not compiled with whisper support (build with -tags whisper)")
}

func (c *Context) Close() {}

func (c *Context) Infer(_ []float32, _ InferenceParams) ([]Segment, string, error) {
	return nil, "", fmt.Errorf("whisper: not compiled with whisper support")
}

// Available returns true when this binary was built with whisper support.
func Available() bool { return false }
