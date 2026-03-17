package streammgr

type StreamState string

const (
	StateConnecting   StreamState = "connecting"
	StateActive       StreamState = "active"
	StateReconnecting StreamState = "reconnecting"
	StateError        StreamState = "error"
	StateIdle         StreamState = "idle"
)
