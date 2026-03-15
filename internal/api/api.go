package api

import (
	"encoding/json"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/fallback"
	"github.com/sammy/sdr-radio/internal/streamlog"
	"github.com/sammy/sdr-radio/internal/streammgr"
)

type Server struct {
	db              *db.DB
	streamManager   *streammgr.Manager
	streamLog       *streamlog.Logger
	fallbackManager *fallback.Manager
	wsUpgrader      websocket.Upgrader
	registry        *topicRegistry
	wsMu            sync.RWMutex
	wsClients       map[string]map[*streamWSClient]struct{}
	frontendDist    string
	jwtSecret       string
	jwtExpiry       time.Duration
}

type streamWSClient struct {
	conn      *websocket.Conn
	mu        sync.Mutex
	sessionID string
	color     string
	joinedAt  time.Time
}

func New(database *db.DB, logger *streamlog.Logger, jwtSecret string, jwtExpiry time.Duration) *Server {
	return &Server{
		db:            database,
		streamManager: streammgr.New(database, logger),
		streamLog:     logger,
		wsUpgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		registry:     newTopicRegistry(),
		wsClients:    make(map[string]map[*streamWSClient]struct{}),
		frontendDist: filepath.Join("frontend", "dist"),
		jwtSecret:    jwtSecret,
		jwtExpiry:    jwtExpiry,
	}
}

func (s *Server) StreamManager() *streammgr.Manager {
	return s.streamManager
}

func (s *Server) StreamLog() *streamlog.Logger {
	return s.streamLog
}

func (s *Server) SetFallbackManager(fm *fallback.Manager) {
	s.fallbackManager = fm
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	r.Route("/api", func(api chi.Router) {
		api.Post("/auth", s.authenticate)

		api.Group(func(protected chi.Router) {
			protected.Use(s.requireAuth)

			protected.Get("/sources", s.listSources)
			protected.Get("/sources/map", s.listMapSources)
			protected.Post("/sources/{id}/probe", s.probeSource)
			protected.Get("/streams", s.listStreams)
			protected.Get("/streams/{id}", s.getStream)
			protected.Post("/streams", s.createStream)
			protected.Patch("/streams/{id}", s.patchStream)
			protected.Delete("/streams/{id}", s.deleteStream)
			protected.Get("/streams/{id}/ws", s.streamWS)
			protected.Get("/streams/{id}/logs", s.getStreamLogs)
			protected.Post("/streams/{id}/debug", s.setStreamDebug)
			protected.Get("/streams/{id}/fallbacks", s.getStreamFallbacks)
			protected.Get("/streams/{id}/fallbacks/ref-audio", s.getStreamRefAudio)
			protected.Get("/streams/{id}/fallbacks/{rank}/probe-audio", s.getFallbackProbeAudio)
			protected.Post("/streams/{id}/reprobe", s.reprobeStream)
			protected.Post("/streams/{id}/capture", s.captureStream)
			protected.Get("/ws", s.globalWS)
		})
	})

	r.Get("/*", s.serveFrontend)

	return r
}

func (s *Server) serveFrontend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}

	if devURL := os.Getenv("FRONTEND_DEV_URL"); devURL != "" {
		if target, err := url.Parse(devURL); err == nil {
			httputil.NewSingleHostReverseProxy(target).ServeHTTP(w, r)
			return
		}
	}

	dist := s.frontendDist
	if p := os.Getenv("FRONTEND_DIST"); p != "" {
		dist = p
	}

	reqPath := path.Clean(r.URL.Path)
	if reqPath == "/" {
		http.ServeFile(w, r, filepath.Join(dist, "index.html"))
		return
	}

	target := filepath.Join(dist, strings.TrimPrefix(reqPath, "/"))
	if _, err := os.Stat(target); err == nil {
		http.ServeFile(w, r, target)
		return
	}

	http.ServeFile(w, r, filepath.Join(dist, "index.html"))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg, code string) {
	writeJSON(w, status, map[string]string{"error": msg, "code": code})
}
