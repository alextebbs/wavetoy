package fallback

import (
	"sync"
	"time"
)

const (
	DegradedHoldoff     = 5 * time.Second
	FrameGapThreshold   = 2 * time.Second
	MinFrameRate        = 15.0
	FrameRateWindowSec  = 10.0
	ConsecutiveErrLimit = 3
	BackoffResetWindow  = 5 * time.Minute
	MaxBackoff          = 16 * time.Second
)

type QualityMonitor struct {
	mu sync.Mutex

	state           DegradationState
	lastFrameAt     time.Time
	windowStart     time.Time
	windowFrames    int64
	consecutiveErrs int
	degradedSince   time.Time
	degradedReason  string

	failoverCount  int
	lastFailoverAt time.Time

	onDegraded func(reason string)
	onTransition func(from, to DegradationState, reason string)
}

func NewQualityMonitor(onDegraded func(reason string)) *QualityMonitor {
	return &QualityMonitor{
		state:       StateHealthy,
		windowStart: time.Now(),
		onDegraded:  onDegraded,
	}
}

func (q *QualityMonitor) SetOnTransition(fn func(from, to DegradationState, reason string)) {
	q.mu.Lock()
	q.onTransition = fn
	q.mu.Unlock()
}

func (q *QualityMonitor) RecordFrame() {
	q.mu.Lock()
	defer q.mu.Unlock()

	now := time.Now()
	q.lastFrameAt = now
	q.windowFrames++
	q.consecutiveErrs = 0

	if q.state == StateDegraded || q.state == StateFailing {
		q.transitionTo(StateHealthy, "")
	}
}

func (q *QualityMonitor) RecordError() {
	q.mu.Lock()
	defer q.mu.Unlock()

	q.consecutiveErrs++
	if q.consecutiveErrs >= ConsecutiveErrLimit && q.state == StateHealthy {
		q.transitionTo(StateDegraded, "repeated_errors")
	}
}

func (q *QualityMonitor) RecordDisconnect() {
	q.mu.Lock()
	defer q.mu.Unlock()

	q.transitionTo(StateFailing, "connection_lost")
	if q.onDegraded != nil {
		q.onDegraded("connection_lost")
	}
}

func (q *QualityMonitor) CheckTimeout() {
	q.mu.Lock()
	defer q.mu.Unlock()

	now := time.Now()

	if !q.lastFrameAt.IsZero() && now.Sub(q.lastFrameAt) > FrameGapThreshold {
		if q.state == StateHealthy {
			q.transitionTo(StateDegraded, "frame_gap")
		}
	}

	elapsed := now.Sub(q.windowStart).Seconds()
	if elapsed >= FrameRateWindowSec {
		rate := float64(q.windowFrames) / elapsed
		q.windowStart = now
		q.windowFrames = 0

		if rate < MinFrameRate && q.state == StateHealthy {
			q.transitionTo(StateDegraded, "frame_rate_degraded")
		}
	}

	if q.state == StateDegraded && !q.degradedSince.IsZero() {
		if now.Sub(q.degradedSince) >= DegradedHoldoff {
			q.transitionTo(StateFailing, q.degradedReason)
			if q.onDegraded != nil {
				q.onDegraded(q.degradedReason)
			}
		}
	}
}

func (q *QualityMonitor) State() DegradationState {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.state
}

func (q *QualityMonitor) FailoverBackoff() time.Duration {
	q.mu.Lock()
	defer q.mu.Unlock()

	if !q.lastFailoverAt.IsZero() && time.Since(q.lastFailoverAt) > BackoffResetWindow {
		q.failoverCount = 0
	}

	q.failoverCount++
	q.lastFailoverAt = time.Now()

	backoff := time.Second
	for i := 1; i < q.failoverCount; i++ {
		backoff *= 2
		if backoff > MaxBackoff {
			backoff = MaxBackoff
			break
		}
	}
	return backoff
}

func (q *QualityMonitor) MarkSwitching() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.state = StateSwitching
}

func (q *QualityMonitor) Reset() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.state = StateHealthy
	q.consecutiveErrs = 0
	q.degradedSince = time.Time{}
	q.degradedReason = ""
	q.windowStart = time.Now()
	q.windowFrames = 0
}

func (q *QualityMonitor) transitionTo(state DegradationState, reason string) {
	prev := q.state
	q.state = state
	if state == StateDegraded {
		q.degradedSince = time.Now()
		q.degradedReason = reason
	} else {
		q.degradedSince = time.Time{}
		q.degradedReason = ""
	}
	if q.onTransition != nil && prev != state {
		q.onTransition(prev, state, reason)
	}
}
