package whisper

import (
	"fmt"
	"log"
	"path/filepath"
	"sync"
)

// Pool serializes all whisper inference across streams through a single
// loaded model. Only one model is loaded at a time; changing the model size
// unloads the current model and loads the new one on next inference.
type Pool struct {
	mu       sync.Mutex
	ctx      *Context
	modelDir string
	size     string
}

func NewPool(modelDir, defaultSize string) *Pool {
	if defaultSize == "" {
		defaultSize = "small"
	}
	return &Pool{
		modelDir: modelDir,
		size:     defaultSize,
	}
}

func (p *Pool) Infer(samples []float32, params InferenceParams) ([]Segment, string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.ctx == nil {
		path := filepath.Join(p.modelDir, fmt.Sprintf("ggml-%s.bin", p.size))
		log.Printf("[whisper] loading model: %s", path)
		ctx, err := LoadModel(path)
		if err != nil {
			return nil, "", fmt.Errorf("whisper: load model %s: %w", path, err)
		}
		p.ctx = ctx
		log.Printf("[whisper] model loaded: %s", p.size)
	}

	return p.ctx.Infer(samples, params)
}

// SetModel changes the model size. The current model is freed and the new
// one will be loaded lazily on next Infer call.
func (p *Pool) SetModel(size string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if size == p.size {
		return
	}
	if p.ctx != nil {
		p.ctx.Close()
		p.ctx = nil
	}
	p.size = size
}

func (p *Pool) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ctx != nil {
		p.ctx.Close()
		p.ctx = nil
	}
}
