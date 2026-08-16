package status

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPageAndAPI(t *testing.T) {
	cfg := Config{
		Proxy:    "http://127.0.0.1:8080",
		Upstream: "https://example.test/zen/v1",
		APIKey:   "k",
		Timeout:  5 * time.Second,
		History:  10,
	}
	c := NewChecker(cfg)
	h := NewHandler(c, nil)
	srv := httptest.NewServer(h)
	defer srv.Close()

	// Static page.
	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if !strings.Contains(string(body), "Zen Proxy 状态") {
		t.Fatalf("index.html missing title")
	}

	// Asset.
	resp2, err := http.Get(srv.URL + "/assets/app.js")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for app.js, got %d", resp2.StatusCode)
	}

	// JSON API: before any cycle the unknown state is reported.
	resp3, err := http.Get(srv.URL + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	var snap Snapshot
	if err := json.NewDecoder(resp3.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	if snap.Overall != StateUnknown {
		t.Fatalf("expected unknown overall before first cycle, got %s", snap.Overall)
	}
	if !snap.Keyed {
		t.Fatalf("expected keyed probes enabled")
	}
	if resp3.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("expected no-store cache header")
	}
}

func TestConfigLoad(t *testing.T) {
	t.Setenv("STATUS_PROXY", "http://proxy.test:8080/")
	t.Setenv("STATUS_UPSTREAM", "https://up.test/zen/v1/")
	t.Setenv("STATUS_API_KEY", "secret")
	t.Setenv("STATUS_MODELS", "a, b ")
	t.Setenv("STATUS_INTERVAL", "7")
	t.Setenv("STATUS_TIMEOUT", "9")
	t.Setenv("STATUS_HISTORY", "42")
	t.Setenv("STATUS_LISTEN_ADDR", "127.0.0.1:9999")
	t.Setenv("STATUS_PROXY_AUTH", "proxy-secret")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Proxy != "http://proxy.test:8080" {
		t.Fatalf("proxy trailing slash not trimmed: %q", cfg.Proxy)
	}
	if cfg.Upstream != "https://up.test/zen/v1" {
		t.Fatalf("upstream trailing slash not trimmed: %q", cfg.Upstream)
	}
	if cfg.APIKey != "secret" || cfg.ProxyAuth != "proxy-secret" {
		t.Fatalf("auth config not loaded: %+v", cfg)
	}
	if len(cfg.Models) != 2 || cfg.Models[0] != "a" || cfg.Models[1] != "b" {
		t.Fatalf("models not parsed: %v", cfg.Models)
	}
	if cfg.Interval != 7*time.Second || cfg.Timeout != 9*time.Second || cfg.History != 42 {
		t.Fatalf("tunables not parsed: %+v", cfg)
	}
	if cfg.ListenAddr != "127.0.0.1:9999" {
		t.Fatalf("listen addr not parsed: %q", cfg.ListenAddr)
	}
}

func TestConfigLoadWithoutKeyDisablesKeyedProbes(t *testing.T) {
	t.Setenv("STATUS_API_KEY", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Upstream != "" {
		t.Fatalf("expected empty upstream without API key, got %q", cfg.Upstream)
	}
}
