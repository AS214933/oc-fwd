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

	"zenproxy/internal/config"
	"zenproxy/internal/proxy"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	var level slog.Level
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		level = slog.LevelInfo
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	p, err := proxy.New(cfg, log)
	if err != nil {
		log.Error("failed to initialize proxy", "error", err)
		os.Exit(1)
	}

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           p.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// Read/Write timeouts intentionally left at zero: request bodies can
		// be very large and responses can stream for a long time.
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("zen-proxy listening",
			"addr", cfg.Listen,
			"upstream", cfg.UpstreamBase,
			"auth_required", cfg.AuthKey != "",
			"socks5", cfg.Socks5 != "",
			"rotate_ip", cfg.RotateIP,
			"retry_max", cfg.RetryMax,
			"circuit_failures", cfg.CircuitFailures,
		)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errCh:
		log.Error("server error", "error", err)
		os.Exit(1)
	case sig := <-stop:
		log.Info("shutting down", "signal", sig.String())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
	log.Info("bye")
}
