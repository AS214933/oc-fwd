// Package status implements a standalone status UI for zen-proxy. It is
// fully isolated from the proxy backend: it runs in its own process, owns
// its own HTTP port and static assets, and only talks to the proxy (and,
// for API-key probes, to the upstream) over plain HTTP.
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
	// Upstream is the base URL used for API-key probes. Unlike anonymous
	// probes, API-key probes are sent directly to the upstream service with
	// an API key, so the green/blue/red states reflect the two calling modes.
	Upstream string
	// APIKey is the API key used for API-key probes. When empty the keyed
	// probes are disabled and a model is only ever green or red.
	APIKey string
	// ProxyAuth is an optional bearer token required by the proxy
	// (its ZEN_AUTH_KEY). It is attached to requests sent to the proxy.
	ProxyAuth string
	// Models lists the upstream model ids to monitor. Empty means the model
	// list is discovered from the proxy's GET /v1/models endpoint.
	Models []string
	// Interval is how often a probe cycle runs.
	Interval time.Duration
	// Timeout bounds a single probe request.
	Timeout time.Duration
	// History determines how many past per-model states are kept for the
	// history bars rendered by the frontend.
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
	var models []string
	for _, m := range strings.Split(envStr("STATUS_MODELS", ""), ",") {
		m = strings.TrimSpace(m)
		if m != "" {
			models = append(models, m)
		}
	}
	cfg := Config{
		ListenAddr: envStr("STATUS_LISTEN_ADDR", ":8090"),
		Proxy:      strings.TrimRight(envStr("STATUS_PROXY", "http://127.0.0.1:8080"), "/"),
		Upstream:   strings.TrimRight(envStr("STATUS_UPSTREAM", "https://opencode.ai/zen"), "/"),
		APIKey:     envStr("STATUS_API_KEY", ""),
		ProxyAuth:  envStr("STATUS_PROXY_AUTH", ""),
		Models:     models,
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
	if cfg.Upstream == "" {
		return cfg, fmt.Errorf("STATUS_UPSTREAM cannot be empty")
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
	if cfg.APIKey == "" {
		// Without an API key there is nothing to probe on the upstream; keep
		// the keyed slot useful by leaving it unset rather than pointing the
		// keyed probe at the proxy (which would make it identical to the
		// anonymous probe).
		cfg.Upstream = ""
	}
	return cfg, nil
}
