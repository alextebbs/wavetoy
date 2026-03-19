package streamlog

import (
	"log/slog"
	"strings"
	"sync"
	"time"
)

const DefaultBufferSize = 2000

type Logger struct {
	mu         sync.RWMutex
	streams    map[string]*streamLog
	bufferSize int
}

type streamLog struct {
	mu    sync.RWMutex
	buf   []Entry
	head  int
	count int
	cap   int
	level LogLevel

	onEmit func(Entry)

	subMu       sync.RWMutex
	subscribers map[chan Entry]struct{}
}

func New() *Logger {
	return &Logger{
		streams:    make(map[string]*streamLog),
		bufferSize: DefaultBufferSize,
	}
}

func (l *Logger) getOrCreate(streamID string) *streamLog {
	l.mu.RLock()
	sl, ok := l.streams[streamID]
	l.mu.RUnlock()
	if ok {
		return sl
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if sl, ok = l.streams[streamID]; ok {
		return sl
	}
	sl = &streamLog{
		buf:         make([]Entry, l.bufferSize),
		cap:         l.bufferSize,
		level:       LevelInfo,
		subscribers: make(map[chan Entry]struct{}),
	}
	l.streams[streamID] = sl
	return sl
}

func (l *Logger) Remove(streamID string) {
	l.mu.Lock()
	sl, ok := l.streams[streamID]
	if ok {
		delete(l.streams, streamID)
	}
	l.mu.Unlock()

	if ok {
		sl.closeAll()
	}
}

func (l *Logger) Info(streamID, action, msg string) {
	l.emit(streamID, LevelInfo, action, "", "", msg)
}

func (l *Logger) Warn(streamID, action, msg string) {
	l.emit(streamID, LevelWarn, action, "", "", msg)
}

func (l *Logger) Error(streamID, action, msg string) {
	l.emit(streamID, LevelError, action, "", "", msg)
}

func (l *Logger) Debug(streamID, action, msg string) {
	l.emit(streamID, LevelDebug, action, "", "", msg)
}

func (l *Logger) Log(streamID string, level LogLevel, action, msg string) {
	l.emit(streamID, level, action, "", "", msg)
}

func (l *Logger) Wire(streamID string, level LogLevel, action, from, to, msg string) {
	l.emit(streamID, level, action, from, to, msg)
}

func (l *Logger) emit(streamID string, level LogLevel, action, from, to, msg string) {
	if isNoise(msg) {
		return
	}

	sl := l.getOrCreate(streamID)

	entry := Entry{
		Time:     time.Now(),
		StreamID: streamID,
		Level:    level,
		Action:   action,
		From:     from,
		To:       to,
		Message:  msg,
	}

	emitSlog(entry)

	if level.severity() < sl.getLevel().severity() {
		return
	}

	sl.append(entry)
	sl.broadcast(entry)

	sl.mu.RLock()
	fn := sl.onEmit
	sl.mu.RUnlock()
	if fn != nil {
		fn(entry)
	}
}

func (l *Logger) Subscribe(streamID string) (<-chan Entry, func(), error) {
	sl := l.getOrCreate(streamID)

	ch := make(chan Entry, 64)
	sl.subMu.Lock()
	sl.subscribers[ch] = struct{}{}
	sl.subMu.Unlock()

	unsub := func() {
		sl.subMu.Lock()
		if _, ok := sl.subscribers[ch]; ok {
			delete(sl.subscribers, ch)
			close(ch)
		}
		sl.subMu.Unlock()
	}
	return ch, unsub, nil
}

func (l *Logger) Snapshot(streamID string, minLevel LogLevel, limit int) []Entry {
	l.mu.RLock()
	sl, ok := l.streams[streamID]
	l.mu.RUnlock()
	if !ok {
		return nil
	}
	return sl.snapshot(minLevel, limit)
}

func (l *Logger) SetLevel(streamID string, level LogLevel) {
	sl := l.getOrCreate(streamID)
	sl.mu.Lock()
	sl.level = level
	sl.mu.Unlock()
}

func (l *Logger) GetLevel(streamID string) LogLevel {
	l.mu.RLock()
	sl, ok := l.streams[streamID]
	l.mu.RUnlock()
	if !ok {
		return LevelInfo
	}
	return sl.getLevel()
}

// SetOnEmit registers a callback invoked for every emitted entry on the given stream.
// Used by streammgr to forward log entries into the ChunkRing.
func (l *Logger) SetOnEmit(streamID string, fn func(Entry)) {
	sl := l.getOrCreate(streamID)
	sl.mu.Lock()
	sl.onEmit = fn
	sl.mu.Unlock()
}

// MakeLogFunc returns a log function suitable for the kiwi client callback.
// The returned function only emits entries when the stream's level allows it.
func (l *Logger) MakeLogFunc(streamID string) func(level LogLevel, action, from, to, msg string) {
	return func(level LogLevel, action, from, to, msg string) {
		l.emit(streamID, level, action, from, to, msg)
	}
}

// --- streamLog methods ---

func (sl *streamLog) getLevel() LogLevel {
	sl.mu.RLock()
	defer sl.mu.RUnlock()
	return sl.level
}

func (sl *streamLog) append(e Entry) {
	sl.mu.Lock()
	defer sl.mu.Unlock()

	idx := (sl.head + sl.count) % sl.cap
	if sl.count == sl.cap {
		sl.head = (sl.head + 1) % sl.cap
	} else {
		sl.count++
	}
	sl.buf[idx] = e
}

func (sl *streamLog) snapshot(minLevel LogLevel, limit int) []Entry {
	sl.mu.RLock()
	defer sl.mu.RUnlock()

	if sl.count == 0 {
		return nil
	}

	// Collect from newest to oldest, filter by level, stop at limit
	var result []Entry
	minSev := minLevel.severity()
	for i := sl.count - 1; i >= 0; i-- {
		idx := (sl.head + i) % sl.cap
		e := sl.buf[idx]
		if e.Level.severity() >= minSev {
			result = append(result, e)
			if limit > 0 && len(result) >= limit {
				break
			}
		}
	}

	// Reverse to chronological order
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return result
}

func (sl *streamLog) broadcast(e Entry) {
	sl.subMu.RLock()
	defer sl.subMu.RUnlock()
	for ch := range sl.subscribers {
		select {
		case ch <- e:
		default:
		}
	}
}

func (sl *streamLog) closeAll() {
	sl.subMu.Lock()
	defer sl.subMu.Unlock()
	for ch := range sl.subscribers {
		delete(sl.subscribers, ch)
		close(ch)
	}
}

// noisePrefixes lists message prefixes that carry no useful information
// and should be silently dropped from both the ring buffer and slog output.
var noisePrefixes = []string{
	"antsw",
	"last_community_download=",
}

func isNoise(msg string) bool {
	for _, p := range noisePrefixes {
		if strings.HasPrefix(msg, p) {
			return true
		}
	}
	return false
}

func emitSlog(e Entry) {
	attrs := []any{
		slog.String("stream", e.StreamID),
		slog.String("action", e.Action),
	}
	if e.From != "" {
		attrs = append(attrs, slog.String("from", e.From))
	}
	if e.To != "" {
		attrs = append(attrs, slog.String("to", e.To))
	}
	if e.Message != "" {
		attrs = append(attrs, slog.String("detail", e.Message))
	}

	switch e.Level {
	case LevelError:
		slog.Error("stream event", attrs...)
	case LevelWarn:
		slog.Warn("stream event", attrs...)
	case LevelInfo:
		slog.Info("stream event", attrs...)
	case LevelDebug:
		slog.Debug("stream event", attrs...)
	}
}
