package status

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
)

//go:embed assets/*
var assets embed.FS

// NewHandler builds the HTTP routes of the status UI: the static frontend at
// / and the JSON snapshot at /api/status.
func NewHandler(c *Checker, log *slog.Logger) http.Handler {
	sub, err := fs.Sub(assets, "assets")
	if err != nil {
		panic(err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET /assets/", http.StripPrefix("/assets/", http.FileServer(http.FS(sub))))
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		b, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			http.Error(w, "assets unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(b)
	})
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(c.Snapshot())
	})
	return logMiddleware(log, mux)
}

func logMiddleware(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		if log != nil {
			log.Debug("status request", "method", r.Method, "path", r.URL.Path)
		}
	})
}
