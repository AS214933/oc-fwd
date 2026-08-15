package proxy

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

	"zenproxy/internal/config"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func baseCfg() config.Config {
	return config.Config{
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

func newTestProxy(t *testing.T, cfg config.Config) *Proxy {
	t.Helper()
	p, err := New(cfg, testLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
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
	d, err := newSocks5Dialer("socks5://user:pass@127.0.0.1:1080")
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
	cfg.IPv6Prefer = true
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "GET", "/debug/upstream-ip", "", nil)
	if rec.Code != 200 {
		t.Fatalf("debug ip status = %d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		IP       string `json:"ip"`
		Family   string `json:"family"`
		ForceV6  bool   `json:"ipv6_force"`
		PreferV6 bool   `json:"ipv6_prefer"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Family != "ipv4" || out.IP != "127.0.0.1" {
		t.Fatalf("unexpected probe result: %+v", out)
	}
	if out.ForceV6 || !out.PreferV6 {
		t.Fatalf("unexpected ipv6 flags: %+v", out)
	}
}

func TestDebugUpstreamIPForced(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = srv.URL
	cfg.ForceIPv6 = true
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "GET", "/debug/upstream-ip", "", nil)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when ipv6 forced against ipv4-only target, got %d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Error   string `json:"error"`
		ForceV6 bool   `json:"ipv6_force"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.ForceV6 || out.Error == "" {
		t.Fatalf("expected ipv6_force=true with error, got %+v", out)
	}
}

func TestForceResponsesToChatCompletions(t *testing.T) {
	var gotPath string
	var got struct {
		Model    string `json:"model"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
		Stream bool `json:"stream"`
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		json.NewDecoder(r.Body).Decode(&got)
		fmt.Fprint(w, `{"model":"resp-model","choices":[{"message":{"role":"assistant","content":"x"}}]}`)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.ForceChatCompletions = true
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/responses",
		`{"model":"resp-model","instructions":"be nice","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}],"stream":false}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/chat/completions" {
		t.Fatalf("expected /chat/completions, got %s", gotPath)
	}
	if got.Model != "resp-model" || len(got.Messages) != 2 {
		t.Fatalf("bad conversion: %+v", got)
	}
	if got.Messages[0].Role != "system" || got.Messages[0].Content != "be nice" {
		t.Fatalf("system message wrong: %+v", got.Messages[0])
	}
	if got.Messages[1].Role != "user" || got.Messages[1].Content != "hello" {
		t.Fatalf("user message wrong: %+v", got.Messages[1])
	}
}

func TestForceMessagesToChatCompletions(t *testing.T) {
	var got struct {
		Model     string `json:"model"`
		MaxTokens int    `json:"max_tokens"`
		Stream    bool   `json:"stream"`
		Messages  []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("expected /chat/completions, got %s", r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&got)
		fmt.Fprint(w, `{"model":"an-model","choices":[]}`)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.ForceChatCompletions = true
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/messages",
		`{"model":"an-model","max_tokens":64,"system":[{"type":"text","text":"sys"}],"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"stream":true}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got.Model != "an-model" || got.MaxTokens != 64 || !got.Stream {
		t.Fatalf("bad conversion header: %+v", got)
	}
	if len(got.Messages) != 2 || got.Messages[0].Content != "sys" || got.Messages[1].Content != "hi" {
		t.Fatalf("bad messages: %+v", got.Messages)
	}
}

func TestMessagesPassthroughWithoutForce(t *testing.T) {
	var gotPath string
	var gotModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		gotModel, _ = body["model"].(string)
		fmt.Fprint(w, `{"type":"message","content":[]}`)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.Models = []string{"an-model"}
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/messages",
		`{"model":"an-model","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/messages" {
		t.Fatalf("expected /messages passthrough, got %s", gotPath)
	}
	if gotModel != "an-model" {
		t.Fatalf("model = %q", gotModel)
	}
}

func TestForceResponsesMixedStringInput(t *testing.T) {
	var got struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&got)
		fmt.Fprint(w, `{"model":"m","choices":[]}`)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.ForceChatCompletions = true
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/responses",
		`{"model":"m","input":["hello",{"type":"message","role":"user","content":[{"type":"input_text","text":"world"}]}]}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(got.Messages) != 2 || got.Messages[0].Content != "hello" || got.Messages[1].Content != "world" {
		t.Fatalf("bad conversion: %+v", got.Messages)
	}
}

func TestForceIPv6NoFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	host, port, _ := net.SplitHostPort(u.Host) // 127.0.0.1:port

	cfg := baseCfg()
	cfg.IPv6Prefer = true
	cfg.ForceIPv6 = true
	nd := &net.Dialer{Timeout: 2 * time.Second}
	dial := makeDialContext(cfg, testLogger(), nd.DialContext)

	_, err := dial(context.Background(), "tcp", net.JoinHostPort(host, port))
	if err == nil {
		t.Fatal("expected dial failure when IPv6 is forced and only IPv4 is reachable")
	}
	if !strings.Contains(err.Error(), "ipv6") {
		t.Fatalf("expected ipv6 error, got: %v", err)
	}
}

// minimalSocks5Server is a tiny no-auth SOCKS5 proxy used to prove that the
// upstream traffic actually flows through the configured SOCKS5 dialer.
type minimalSocks5Server struct {
	ln         net.Listener
	handshakes atomic.Int64
}

func newMinimalSocks5Server(t *testing.T) *minimalSocks5Server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &minimalSocks5Server{ln: ln}
	go s.serve()
	t.Cleanup(func() { ln.Close() })
	return s
}

func (s *minimalSocks5Server) addr() string { return s.ln.Addr().String() }

func (s *minimalSocks5Server) serve() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handle(c)
	}
}

func (s *minimalSocks5Server) handle(c net.Conn) {
	defer c.Close()
	greet := make([]byte, 2)
	if _, err := io.ReadFull(c, greet); err != nil || greet[0] != 0x05 {
		return
	}
	methods := make([]byte, int(greet[1]))
	if _, err := io.ReadFull(c, methods); err != nil {
		return
	}
	c.Write([]byte{0x05, 0x00}) // no-auth

	head := make([]byte, 4)
	if _, err := io.ReadFull(c, head); err != nil || head[0] != 0x05 || head[1] != 0x01 {
		return
	}
	var host string
	switch head[3] {
	case 0x01:
		b := make([]byte, 4)
		if _, err := io.ReadFull(c, b); err != nil {
			return
		}
		host = net.IP(b).String()
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(c, l); err != nil {
			return
		}
		b := make([]byte, int(l[0]))
		if _, err := io.ReadFull(c, b); err != nil {
			return
		}
		host = string(b)
	case 0x04:
		b := make([]byte, 16)
		if _, err := io.ReadFull(c, b); err != nil {
			return
		}
		host = net.IP(b).String()
	default:
		return
	}
	port := make([]byte, 2)
	if _, err := io.ReadFull(c, port); err != nil {
		return
	}
	s.handshakes.Add(1)

	target, err := net.Dial("tcp", net.JoinHostPort(host, fmt.Sprintf("%d", uint16(port[0])<<8|uint16(port[1]))))
	if err != nil {
		return
	}
	defer target.Close()
	c.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}) // success, bind 0.0.0.0:0
	done := make(chan struct{}, 2)
	go func() { io.Copy(target, c); done <- struct{}{} }()
	go func() { io.Copy(c, target); done <- struct{}{} }()
	<-done
}

func TestSocks5TrafficGoesThroughProxy(t *testing.T) {
	socks := newMinimalSocks5Server(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.Socks5 = "socks5://" + socks.addr()
	p := newTestProxy(t, cfg)
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if socks.handshakes.Load() == 0 {
		t.Fatal("no SOCKS5 handshake recorded: traffic did not go through the socks5 proxy")
	}
}

func TestRotateIPFreshConnectionPerRequest(t *testing.T) {
	socks := newMinimalSocks5Server(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.Socks5 = "socks5://" + socks.addr()
	cfg.RotateIP = true
	p := newTestProxy(t, cfg)

	for i := 0; i < 3; i++ {
		rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
			`{"model":"m","messages":[]}`, nil)
		if rec.Code != 200 {
			t.Fatalf("request %d status = %d body=%s", i, rec.Code, rec.Body.String())
		}
	}
	if got := socks.handshakes.Load(); got < 3 {
		t.Fatalf("expected a fresh SOCKS5 connection per request (rotate_ip), got %d handshakes for 3 requests", got)
	}
}

func TestRotateIPOffReusesConnection(t *testing.T) {
	socks := newMinimalSocks5Server(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	}))
	defer upstream.Close()

	cfg := baseCfg()
	cfg.UpstreamBase = upstream.URL
	cfg.Socks5 = "socks5://" + socks.addr()
	cfg.RotateIP = false
	p := newTestProxy(t, cfg)

	for i := 0; i < 3; i++ {
		rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
			`{"model":"m","messages":[]}`, nil)
		if rec.Code != 200 {
			t.Fatalf("request %d status = %d body=%s", i, rec.Code, rec.Body.String())
		}
	}
	if got := socks.handshakes.Load(); got != 1 {
		t.Fatalf("expected keep-alive reuse with rotate off, got %d handshakes for 3 requests", got)
	}
}
