package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func baseCfg() Config {
	return Config{
		Listen:           ":0",
		UpstreamBase:     "http://upstream.test/zen/v1",
		RetryMax:         2,
		RetryBaseBackoff: 10 * time.Millisecond,
		RetryMaxBackoff:  50 * time.Millisecond,
		CircuitFailures:  0, // disabled by default in tests
		CircuitCooldown:  100 * time.Millisecond,
		MaxBodyBytes:     1 << 20,
	}
}

func newTestProxy(t *testing.T, cfg Config) *Proxy {
	t.Helper()
	p, err := newProxy(cfg, testLogger())
	if err != nil {
		t.Fatalf("newProxy: %v", err)
	}
	return p
}

func doJSON(t *testing.T, h http.Handler, method, path, body string, hdrs map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range hdrs {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestModelAllowlistAndRewrite(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		fmt.Fprintf(w, `{"model":%q,"choices":[{"message":{"role":"assistant","content":"hi"}}]}`, body.Model)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL + "/zen/v1"
	cfg.Models = []string{"real-model"}
	cfg.ModelMap = map[string]string{"alias": "real-model"}
	p := newTestProxy(t, cfg)
	h := p.Handler()

	// alias is rewritten upstream and rewritten back in the response
	rec := doJSON(t, h, "POST", "/v1/chat/completions",
		`{"model":"alias","messages":[{"role":"user","content":"x"}],"stream":false}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"model":"alias"`) {
		t.Fatalf("response model not rewritten back: %s", rec.Body.String())
	}

	// direct configured model passes through
	rec = doJSON(t, h, "POST", "/v1/chat/completions",
		`{"model":"real-model","messages":[]}`, nil)
	if rec.Code != 200 {
		t.Fatalf("direct model status = %d", rec.Code)
	}

	// disallowed model rejected
	rec = doJSON(t, h, "POST", "/v1/chat/completions",
		`{"model":"other","messages":[]}`, nil)
	if rec.Code != 400 {
		t.Fatalf("disallowed model status = %d", rec.Code)
	}

	// /v1/models lists aliases + configured models
	rec = doJSON(t, h, "GET", "/v1/models", "", nil)
	if rec.Code != 200 {
		t.Fatalf("models status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"real-model"`) || !strings.Contains(rec.Body.String(), `"alias"`) {
		t.Fatalf("models list wrong: %s", rec.Body.String())
	}
}

func TestNoRestrictionAllowsAnyModel(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"model":"anything","choices":[]}`)
	}))
	defer upstream.Close()
	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"whatever","messages":[]}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestRetryOn429(t *testing.T) {
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) < 3 {
			w.WriteHeader(http.StatusTooManyRequests)
			io.WriteString(w, `{"error":{"message":"slow down"}}`)
			return
		}
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.RetryMax = 3
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if hits.Load() != 3 {
		t.Fatalf("expected 3 upstream attempts, got %d", hits.Load())
	}
}

func TestRetryExhaustedReturns429(t *testing.T) {
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, `{"error":{"message":"nope"}}`)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.RetryMax = 2
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != 429 {
		t.Fatalf("status = %d", rec.Code)
	}
	if hits.Load() != 3 { // 1 + RetryMax retries
		t.Fatalf("expected 3 upstream attempts, got %d", hits.Load())
	}
	if !strings.Contains(rec.Body.String(), "rate_limit") {
		t.Fatalf("expected rate limit error body, got %s", rec.Body.String())
	}
}

func TestCircuitBreakerShieldsUpstream(t *testing.T) {
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, `{"error":{"message":"nope"}}`)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.RetryMax = 1
	cfg.CircuitFailures = 2
	p := newTestProxy(t, cfg)
	h := p.Handler()
	body := `{"model":"m","messages":[]}`

	// request 1: 2 upstream hits (1 + 1 retry) -> circuit opens
	doJSON(t, h, "POST", "/v1/chat/completions", body, nil)
	afterFirst := hits.Load()
	if afterFirst != 2 {
		t.Fatalf("expected 2 hits, got %d", afterFirst)
	}

	// request 2: circuit open -> no upstream contact
	rec := doJSON(t, h, "POST", "/v1/chat/completions", body, nil)
	if rec.Code != 429 {
		t.Fatalf("circuit-open status = %d", rec.Code)
	}
	if hits.Load() != afterFirst {
		t.Fatalf("upstream was hit while circuit open (%d -> %d)", afterFirst, hits.Load())
	}

	// after cooldown the circuit half-opens and allows one attempt
	time.Sleep(150 * time.Millisecond)
	doJSON(t, h, "POST", "/v1/chat/completions", body, nil)
	if hits.Load() <= afterFirst {
		t.Fatalf("expected upstream contact after cooldown, hits=%d", hits.Load())
	}
}

func TestAuthOptional(t *testing.T) {
	cfg := baseCfg()
	cfg.AuthKey = "sekret"
	cfg.UpstreamBase = "http://127.0.0.1:1" // should not be reached when 401
	p := newTestProxy(t, cfg)
	h := p.Handler()
	body := `{"model":"m","messages":[]}`

	rec := doJSON(t, h, "POST", "/v1/chat/completions", body, nil)
	if rec.Code != 401 {
		t.Fatalf("expected 401 without key, got %d", rec.Code)
	}

	rec = doJSON(t, h, "POST", "/v1/chat/completions", body, map[string]string{"Authorization": "Bearer wrong"})
	if rec.Code != 401 {
		t.Fatalf("expected 401 with wrong key, got %d", rec.Code)
	}

	// With no auth key configured, requests pass without one.
	cfg2 := baseCfg()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"choices":[]}`)
	}))
	defer upstream.Close()
	cfg2.UpstreamBase = upstream.URL
	p2 := newTestProxy(t, cfg2)
	if rec := doJSON(t, p2.Handler(), "POST", "/v1/chat/completions", body, nil); rec.Code != 200 {
		t.Fatalf("expected 200 without auth configured, got %d", rec.Code)
	}
}

func TestStreamingRewrite(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"model\":\"real-model\",\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.ModelMap = map[string]string{"alias": "real-model"}
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"alias","messages":[],"stream":true}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"model":"alias"`) {
		t.Fatalf("streaming model not rewritten: %q", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("stream terminator missing: %q", rec.Body.String())
	}
}

func TestSocks5Parsing(t *testing.T) {
	d, err := newSocks5Dialer("socks5://user:pass@100.64.0.16:1080")
	if err != nil || d == nil {
		t.Fatalf("socks5 dialer: %v", err)
	}
	// unauthenticated + default port
	if _, err := newSocks5Dialer("socks5://proxy.example.com"); err != nil {
		t.Fatalf("socks5 no-auth: %v", err)
	}
	if _, err := newSocks5Dialer("socks4://host:1080"); err == nil {
		t.Fatal("expected error for invalid socks5 scheme")
	}
}

func TestHealthz(t *testing.T) {
	cfg := baseCfg()
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "GET", "/healthz", "", nil)
	if rec.Code != 200 || rec.Body.String() != "ok" {
		t.Fatalf("healthz = %d %q", rec.Code, rec.Body.String())
	}
}

func TestInvalidBody(t *testing.T) {
	cfg := baseCfg()
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions", "{bad json", nil)
	if rec.Code != 400 {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestOrderIPs(t *testing.T) {
	v4 := []net.IP{net.ParseIP("172.65.90.21")}
	v6 := []net.IP{net.ParseIP("2606:4700:78::90:0:142")}
	ips := append(append([]net.IP{}, v4...), v6...)

	got := orderIPs(ips, true)
	if !got[0].Equal(v6[0]) || !got[1].Equal(v4[0]) {
		t.Fatalf("ipv6 first order wrong: %v", got)
	}
	got = orderIPs(ips, false)
	if !got[0].Equal(v4[0]) || !got[1].Equal(v6[0]) {
		t.Fatalf("ipv4 first order wrong: %v", got)
	}
}

func TestDialPrefersIPv6WithFallback(t *testing.T) {
	// Server bound only to 127.0.0.1: prefer-IPv6 dial of "localhost" must
	// try ::1 first, fail, and fall back to 127.0.0.1.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	}))
	defer srv.Close()

	u, _ := url.Parse(srv.URL)
	host, port, _ := net.SplitHostPort(u.Host) // 127.0.0.1:port
	cfg := baseCfg()
	cfg.IPv6Prefer = true
	nd := &net.Dialer{Timeout: 5 * time.Second}
	dial := makeDialContext(cfg, testLogger(), nd.DialContext)

	conn, err := dial(context.Background(), "tcp", net.JoinHostPort(host, port))
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	conn.Close()

	// Preferring IPv4 for the same target must also succeed.
	cfg.IPv6Prefer = false
	dial4 := makeDialContext(cfg, testLogger(), nd.DialContext)
	conn, err = dial4(context.Background(), "tcp", "localhost:"+port)
	if err != nil {
		t.Fatalf("dial (no prefer) failed: %v", err)
	}
	conn.Close()
}

func TestForceChatCompletionsForwardsAnyModel(t *testing.T) {
	var gotModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		gotModel = body.Model
		fmt.Fprintf(w, `{"model":%q,"choices":[]}`, body.Model)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.Models = []string{"only-this"}
	cfg.ForceChatCompletions = true
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"not-whitelisted","messages":[]}`, nil)
	if rec.Code != 200 {
		t.Fatalf("force forward status = %d body=%s", rec.Code, rec.Body.String())
	}
	if gotModel != "not-whitelisted" {
		t.Fatalf("expected model forwarded verbatim, got %q", gotModel)
	}

	// without the flag the same request must be rejected
	cfg.ForceChatCompletions = false
	p2 := newTestProxy(t, cfg)
	rec = doJSON(t, p2.Handler(), "POST", "/v1/chat/completions",
		`{"model":"not-whitelisted","messages":[]}`, nil)
	if rec.Code != 400 {
		t.Fatalf("expected 400 without force flag, got %d", rec.Code)
	}
}

func TestDebugUpstreamIP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = srv.URL
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "GET", "/debug/upstream-ip", "", nil)
	if rec.Code != 200 {
		t.Fatalf("debug ip status = %d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		IP     string `json:"ip"`
		Family string `json:"family"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Family != "ipv4" || out.IP != "127.0.0.1" {
		t.Fatalf("unexpected probe result: %+v", out)
	}
}
