package status

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPageAPIAndEvents(t *testing.T) {
	cfg := Config{
		Proxy:      "http://127.0.0.1:8080",
		EventToken: "ev-secret",
		Timeout:    5 * time.Second,
		History:    10,
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

	// Events endpoint rejects missing token.
	ev := StateEvent{Model: "m", From: "anonymous", To: "keyed", Reason: "anonymous_failures", At: 123}
	payload, _ := json.Marshal(ev)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/events", bytes.NewReader(payload))
	resp3, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", resp3.StatusCode)
	}

	// With the token the event is ingested and shows up in /api/status.
	req, _ = http.NewRequest(http.MethodPost, srv.URL+"/api/events", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer ev-secret")
	resp4, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp4.Body.Close()
	if resp4.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", resp4.StatusCode)
	}

	resp5, err := http.Get(srv.URL + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp5.Body.Close()
	var snap Snapshot
	if err := json.NewDecoder(resp5.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	if snap.Overall != "blue" || len(snap.Models) != 1 || snap.Models[0].State != StateKeyed {
		t.Fatalf("event not reflected in snapshot: %+v", snap)
	}
	if snap.Models[0].Switches != 1 || snap.Models[0].LastEvent.Reason != "anonymous_failures" {
		t.Fatalf("unexpected model view: %+v", snap.Models[0])
	}
	if resp5.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("expected no-store cache header")
	}
}

func TestConfigLoad(t *testing.T) {
	t.Setenv("STATUS_PROXY", "http://proxy.test:8080/")
	t.Setenv("STATUS_PROXY_AUTH", "proxy-secret")
	t.Setenv("STATUS_EVENT_TOKEN", "ev-secret")
	t.Setenv("STATUS_INTERVAL", "7")
	t.Setenv("STATUS_TIMEOUT", "9")
	t.Setenv("STATUS_HISTORY", "42")
	t.Setenv("STATUS_LISTEN_ADDR", "127.0.0.1:9999")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Proxy != "http://proxy.test:8080" {
		t.Fatalf("proxy trailing slash not trimmed: %q", cfg.Proxy)
	}
	if cfg.ProxyAuth != "proxy-secret" || cfg.EventToken != "ev-secret" {
		t.Fatalf("auth config not loaded: %+v", cfg)
	}
	if cfg.Interval != 7*time.Second || cfg.Timeout != 9*time.Second || cfg.History != 42 {
		t.Fatalf("tunables not parsed: %+v", cfg)
	}
	if cfg.ListenAddr != "127.0.0.1:9999" {
		t.Fatalf("listen addr not parsed: %q", cfg.ListenAddr)
	}
}
