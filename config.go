package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all runtime settings. Every knob is optional and driven by
// environment variables so the same binary is easy to run in Docker.
type Config struct {
	Listen               string
	UpstreamBase         string
	UpstreamAPIKey       string // optional: key used when calling opencode zen
	Socks5               string // optional: socks5://user:pass@host:port
	Models               []string
	ModelMap             map[string]string // alias -> upstream model id
	AuthKey              string            // optional: key callers must present
	RetryMax             int
	RetryBaseBackoff     time.Duration
	RetryMaxBackoff      time.Duration
	CircuitFailures      int
	CircuitCooldown      time.Duration
	MaxBodyBytes         int64
	UpstreamTimeout      time.Duration
	UpstreamTimeoutSet   bool
	MaxConcurrency       int
	IPv6Prefer           bool
	ForceIPv6            bool
	ForceChatCompletions bool
	LogLevel             string
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

func envBool(key string, def bool) bool {
	v := strings.ToLower(os.Getenv(key))
	if v == "" {
		return def
	}
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

func parseModelMap(s string) (map[string]string, error) {
	m := map[string]string{}
	for _, pair := range strings.Split(s, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		parts := strings.SplitN(pair, "=", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
			return nil, fmt.Errorf("invalid ZEN_MODEL_MAP entry %q (want alias=upstreamModel)", pair)
		}
		m[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
	}
	return m, nil
}

func loadConfig() (Config, error) {
	cfg := Config{
		Listen:               envStr("LISTEN_ADDR", ":8080"),
		UpstreamBase:         strings.TrimRight(envStr("ZEN_UPSTREAM", "https://opencode.ai/zen/v1"), "/"),
		UpstreamAPIKey:       envStr("ZEN_UPSTREAM_API_KEY", ""),
		Socks5:               envStr("ZEN_SOCKS5", ""),
		AuthKey:              envStr("ZEN_AUTH_KEY", ""),
		RetryMax:             envInt("ZEN_RETRY_MAX", 3),
		RetryBaseBackoff:     envSeconds("ZEN_RETRY_BACKOFF_SECONDS", 2),
		RetryMaxBackoff:      envSeconds("ZEN_RETRY_MAX_BACKOFF_SECONDS", 30),
		CircuitFailures:      envInt("ZEN_CIRCUIT_FAILURES", 5),
		CircuitCooldown:      envSeconds("ZEN_CIRCUIT_COOLDOWN_SECONDS", 30),
		MaxBodyBytes:         int64(envInt("ZEN_MAX_BODY_MB", 128)) << 20,
		UpstreamTimeout:      envSeconds("ZEN_UPSTREAM_TIMEOUT_SECONDS", 600),
		MaxConcurrency:       envInt("ZEN_MAX_CONCURRENCY", 0),
		IPv6Prefer:           envBool("ZEN_IPV6_PREFER", true),
		ForceIPv6:            envBool("ZEN_FORCE_IPV6", false),
		ForceChatCompletions: envBool("ZEN_FORCE_CHAT_COMPLETIONS", false),
		LogLevel:             envStr("LOG_LEVEL", "info"),
	}
	if cfg.UpstreamTimeout > 0 {
		cfg.UpstreamTimeoutSet = true
	}
	var err error
	cfg.ModelMap, err = parseModelMap(envStr("ZEN_MODEL_MAP", ""))
	if err != nil {
		return cfg, err
	}
	for _, m := range strings.Split(envStr("ZEN_MODELS", ""), ",") {
		m = strings.TrimSpace(m)
		if m != "" {
			cfg.Models = append(cfg.Models, m)
		}
	}
	if cfg.Listen == "" {
		return cfg, fmt.Errorf("LISTEN_ADDR cannot be empty")
	}
	if cfg.RetryMax < 0 || cfg.RetryBaseBackoff <= 0 {
		return cfg, fmt.Errorf("invalid retry settings: ZEN_RETRY_MAX and ZEN_RETRY_BACKOFF_SECONDS must be >= 0 / > 0")
	}
	return cfg, nil
}
