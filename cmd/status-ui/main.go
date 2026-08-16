// Command status-ui runs the standalone zen-proxy status UI: it receives
// model state-change reports pushed by the proxy (POST /api/events),
// reconciles with the proxy's /debug/modes endpoint, and serves a status
// page showing the anonymous/keyed/keyed_failed switching per model.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"zenproxy/status"
)

func main() {
	cfg, err := status.Load()
	if err != nil {
		slog.Error("load config", "error", err)
		os.Exit(1)
	}

	level := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	checker := status.NewChecker(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go checker.Run(ctx)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           status.NewHandler(checker, log),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Info("status UI listening",
		"addr", cfg.ListenAddr,
		"proxy", cfg.Proxy,
		"reconcile_interval_s", cfg.Interval/time.Second,
	)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server exited", "error", err)
		os.Exit(1)
	}
}
