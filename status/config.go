// Package status implements a standalone status UI for zen-proxy. It runs in
// its own process and own HTTP port, receives model state-change reports
// pushed by the proxy (POST /api/events), and reconciles against the proxy's
// /debug/modes endpoint so the page always reflects the real switching state.
package status

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds the runtime configuration of the status UI, loaded from
// STATUS_* environment variables.
type Config struct {
	// ListenAddr is the address the status UI listens on.
	ListenAddr string
	// Proxy is the base URL of the zen-proxy service used for anonymous probes.
	Proxy string
	// ProxyAuth is an optional bearer token required by the proxy
	// (its ZEN_AUTH_KEY). It is attached to requests sent to the proxy.
	ProxyAuth string
	// EventToken, when set, must be supplied as Authorization: Bearer on
	// POST /api/events (matching the proxy's ZEN_STATUS_TOKEN).
	EventToken string
	// Interval is how often the UI reconciles its state with the proxy's
	// /debug/modes endpoint.
	Interval time.Duration
	// Timeout bounds a single reconcile request.
	Timeout time.Duration
	// History caps the number of state-change events kept in the timeline.
	History int
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envSeconds(key string, def int) time.Duration {
	return time.Duration(envInt(key, def)) * time.Second
}

// Load reads the status UI configuration from the environment.
func Load() (Config, error) {
	cfg := Config{
		ListenAddr: envStr("STATUS_LISTEN_ADDR", ":8090"),
		Proxy:      strings.TrimRight(envStr("STATUS_PROXY", "http://127.0.0.1:8080"), "/"),
		ProxyAuth:  envStr("STATUS_PROXY_AUTH", ""),
		EventToken: envStr("STATUS_EVENT_TOKEN", ""),
		Interval:   envSeconds("STATUS_INTERVAL", 15),
		Timeout:    envSeconds("STATUS_TIMEOUT", 30),
		History:    envInt("STATUS_HISTORY", 120),
	}
	if cfg.ListenAddr == "" {
		return cfg, fmt.Errorf("STATUS_LISTEN_ADDR cannot be empty")
	}
	if cfg.Proxy == "" {
		return cfg, fmt.Errorf("STATUS_PROXY cannot be empty")
	}
	if cfg.Interval <= 0 {
		return cfg, fmt.Errorf("invalid STATUS_INTERVAL %s: must be > 0", cfg.Interval)
	}
	if cfg.Timeout <= 0 {
		return cfg, fmt.Errorf("invalid STATUS_TIMEOUT %s: must be > 0", cfg.Timeout)
	}
	if cfg.History < 1 {
		return cfg, fmt.Errorf("invalid STATUS_HISTORY %d: must be >= 1", cfg.History)
	}
	return cfg, nil
}
