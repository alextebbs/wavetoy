package streamlog

import (
	"fmt"
	"time"
)

type LogLevel string

const (
	LevelError LogLevel = "error"
	LevelWarn  LogLevel = "warn"
	LevelInfo  LogLevel = "info"
	LevelDebug LogLevel = "debug"
)

func (l LogLevel) severity() int {
	switch l {
	case LevelError:
		return 3
	case LevelWarn:
		return 2
	case LevelInfo:
		return 1
	case LevelDebug:
		return 0
	default:
		return 0
	}
}

type Entry struct {
	Time     time.Time `json:"t"`
	StreamID string    `json:"sid,omitempty"`
	Level    LogLevel  `json:"level"`
	Action   string    `json:"action"`
	From     string    `json:"from,omitempty"`
	To       string    `json:"to,omitempty"`
	Message  string    `json:"msg,omitempty"`
}

func (e Entry) Format() string {
	ts := e.Time.Format("15:04:05.000")
	lvl := levelTag(e.Level)
	if e.From != "" && e.To != "" {
		if e.Message != "" {
			return fmt.Sprintf("%s %s %-18s %s→%s %s", ts, lvl, e.Action, e.From, e.To, e.Message)
		}
		return fmt.Sprintf("%s %s %-18s %s→%s", ts, lvl, e.Action, e.From, e.To)
	}
	if e.Message != "" {
		return fmt.Sprintf("%s %s %-18s %s", ts, lvl, e.Action, e.Message)
	}
	return fmt.Sprintf("%s %s %s", ts, lvl, e.Action)
}

func levelTag(l LogLevel) string {
	switch l {
	case LevelError:
		return "ERR"
	case LevelWarn:
		return "WRN"
	case LevelInfo:
		return "INF"
	case LevelDebug:
		return "DBG"
	default:
		return "???"
	}
}
