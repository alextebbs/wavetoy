//go:build whisper

package whisper

/*
#cgo CFLAGS: -I${SRCDIR}
#cgo darwin LDFLAGS: -L${SRCDIR}/lib/darwin_arm64 -lwhisper -lggml -lggml-cpu -lggml-metal -lggml-blas -lggml-base -framework Accelerate -framework Metal -framework Foundation -framework CoreGraphics -lstdc++
#cgo linux LDFLAGS: -L${SRCDIR}/lib/linux_amd64 -lwhisper -lggml -lggml-cpu -lggml-base -lm -lstdc++ -lpthread

#include "whisper.h"
#include <stdlib.h>
*/
import "C"
import (
	"fmt"
	"time"
	"unsafe"
)

type Context struct {
	ctx *C.struct_whisper_context
}

type Segment struct {
	Text  string
	Start time.Duration
	End   time.Duration
}

type InferenceParams struct {
	Task     string // "transcribe" or "translate"
	Language string // ISO 639-1 or "" for auto-detect
	Threads  int
}

func LoadModel(path string) (*Context, error) {
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))

	ctx := C.whisper_init_from_file_with_params(cPath, C.whisper_context_default_params())
	if ctx == nil {
		return nil, fmt.Errorf("whisper: failed to load model from %s", path)
	}
	return &Context{ctx: ctx}, nil
}

func (c *Context) Close() {
	if c.ctx != nil {
		C.whisper_free(c.ctx)
		c.ctx = nil
	}
}

func (c *Context) Infer(samples []float32, params InferenceParams) ([]Segment, string, error) {
	if c.ctx == nil {
		return nil, "", fmt.Errorf("whisper: context is closed")
	}
	if len(samples) == 0 {
		return nil, "", nil
	}

	fp := C.whisper_full_default_params(C.WHISPER_SAMPLING_GREEDY)

	if params.Task == "translate" {
		fp.translate = C.bool(true)
	}

	if params.Language != "" {
		cLang := C.CString(params.Language)
		defer C.free(unsafe.Pointer(cLang))
		fp.language = cLang
	}

	if params.Threads > 0 {
		fp.n_threads = C.int(params.Threads)
	}

	fp.no_context = C.bool(true)
	fp.single_segment = C.bool(false)
	fp.print_progress = C.bool(false)
	fp.print_realtime = C.bool(false)
	fp.print_timestamps = C.bool(false)

	ret := C.whisper_full(c.ctx, fp, (*C.float)(unsafe.Pointer(&samples[0])), C.int(len(samples)))
	if ret != 0 {
		return nil, "", fmt.Errorf("whisper: inference failed with code %d", ret)
	}

	nSegments := int(C.whisper_full_n_segments(c.ctx))
	segments := make([]Segment, 0, nSegments)
	for i := 0; i < nSegments; i++ {
		text := C.GoString(C.whisper_full_get_segment_text(c.ctx, C.int(i)))
		t0 := C.whisper_full_get_segment_t0(c.ctx, C.int(i))
		t1 := C.whisper_full_get_segment_t1(c.ctx, C.int(i))
		segments = append(segments, Segment{
			Text:  text,
			Start: time.Duration(t0) * 10 * time.Millisecond,
			End:   time.Duration(t1) * 10 * time.Millisecond,
		})
	}

	lang := ""
	langID := C.whisper_full_lang_id(c.ctx)
	if langID >= 0 {
		lang = C.GoString(C.whisper_lang_str(langID))
	}

	return segments, lang, nil
}

// Available returns true when this binary was built with whisper support.
func Available() bool { return true }
