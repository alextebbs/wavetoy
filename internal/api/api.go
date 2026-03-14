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

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/streammgr"
)

type Server struct {
	db            *db.DB
	streamManager *streammgr.Manager
	wsUpgrader    websocket.Upgrader
	wsMu          sync.RWMutex
	wsClients     map[string]map[*streamWSClient]struct{}
	frontendDist  string
}

type streamWSClient struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func New(database *db.DB) *Server {
	return &Server{
		db:            database,
		streamManager: streammgr.New(database),
		wsUpgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		wsClients:    make(map[string]map[*streamWSClient]struct{}),
		frontendDist: filepath.Join("frontend", "dist"),
	}
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	r.Route("/api", func(api chi.Router) {
		api.Get("/sources", s.listSources)
		api.Get("/sources/map", s.listMapSources)
		api.Get("/streams", s.listStreams)
		api.Get("/streams/{id}", s.getStream)
		api.Post("/streams", s.createStream)
		api.Patch("/streams/{id}", s.patchStream)
		api.Delete("/streams/{id}", s.deleteStream)
		api.Get("/streams/{id}/ws", s.streamWS)
	})

	r.Get("/*", s.serveFrontend)

	return r
}

func (s *Server) serveFrontend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}

	// In dev, proxy all non-API routes to Vite so HMR works.
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
