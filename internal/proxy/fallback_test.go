package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"zenproxy/internal/config"
)

// authTrackingServer records the Authorization header of the last request and
// can be switched between "down" (anonymous 429) and "up" (anonymous 200).
type authTrackingServer struct {
	mu       sync.Mutex
	down     bool
	lastAuth string
	probes   int
	keyed    int
}

func (s *authTrackingServer) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	auth := r.Header.Get("Authorization")
	s.mu.Lock()
	s.lastAuth = auth
	if strings.Contains(string(body), `"ping"`) && auth == "" {
		s.probes++
	}
	if auth != "" {
		s.keyed++
	}
	down := s.down
	s.mu.Unlock()
	if auth == "" && down {
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, `{"error":{"type":"rate_limit_error"}}`)
		return
	}
	io.WriteString(w, `{"id":"c1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
}

func (s *authTrackingServer) setDown(d bool) {
	s.mu.Lock()
	s.down = d
	s.mu.Unlock()
}

func (s *authTrackingServer) setAuth(a string) {
	s.mu.Lock()
	s.lastAuth = a
	s.mu.Unlock()
}

func (s *authTrackingServer) snapshot() (auth string, probes, keyed int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastAuth, s.probes, s.keyed
}

func fallbackCfg(t *testing.T, upstream string) config.Config {
	t.Helper()
	cfg := baseCfg()
	cfg.UpstreamBase = upstream
	cfg.APIKeys = []string{"key-A", "key-B"}
	cfg.NoKeyFailThreshold = 3
	cfg.NoKeyProbeInterval = 50 * time.Millisecond
	return cfg
}

func TestFallbackToAPIKeyAfterConsecutiveFailures(t *testing.T) {
	ts := &authTrackingServer{down: true}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	p := newTestProxy(t, cfg)

	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request 1 expected 429 (anonymous down), got %d", rec.Code)
	}
	rec = doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request 2 expected 429 (anonymous down), got %d", rec.Code)
	}

	// Third failure crosses the threshold: the same request must be retried
	// with an API key and succeed, so the user sees no error.
	rec = doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"content":"ok"`) {
		t.Fatalf("request 3 should transparently succeed via API key, got %d body=%s", rec.Code, rec.Body.String())
	}
	auth, _, keyed := ts.snapshot()
	if auth == "" || !strings.HasPrefix(auth, "Bearer key-") {
		t.Fatalf("expected a keyed request after fallback, got auth=%q", auth)
	}
	if keyed == 0 {
		t.Fatal("expected at least one keyed attempt")
	}
	if !p.inKeyMode() {
		t.Fatal("expected proxy to stay in keyed mode after fallback")
	}
}

func TestNoKeySuccessResetsFailures(t *testing.T) {
	ts := &authTrackingServer{down: true}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 3
	p := newTestProxy(t, cfg)

	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request 1 expected 429, got %d", rec.Code)
	}

	// Recover: the next anonymous request succeeds and resets the counter.
	ts.setDown(false)
	rec = doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("request 2 expected 200 after recovery, got %d", rec.Code)
	}

	// Fail once more: counter is back to 1, so no fallback yet.
	ts.setDown(true)
	rec = doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request 3 expected 429 (failures not accumulated), got %d", rec.Code)
	}
	if p.inKeyMode() {
		t.Fatal("expected no fallback after a single new failure")
	}
	auth, _, keyed := ts.snapshot()
	if auth != "" || keyed != 0 {
		t.Fatalf("no keyed request expected, auth=%q keyed=%d", auth, keyed)
	}
}

func TestProbeSwitchesBackToNoKey(t *testing.T) {
	ts := &authTrackingServer{down: true}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 1
	p := newTestProxy(t, cfg)

	// First request fails anonymously, falls back to keyed, succeeds.
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("fallback request expected 200, got %d", rec.Code)
	}
	if !p.inKeyMode() {
		t.Fatal("expected keyed mode after fallback")
	}

	// Anonymous recovers; the 3s probe should flip the proxy back.
	ts.setDown(false)
	deadline := time.Now().Add(3 * time.Second)
	for p.inKeyMode() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if p.inKeyMode() {
		t.Fatal("proxy did not switch back to anonymous after recovery")
	}

	ts.setAuth("")
	rec = doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("request after recovery expected 200, got %d", rec.Code)
	}
	auth, probes, keyed := ts.snapshot()
	if auth != "" {
		t.Fatalf("expected anonymous request after recovery, auth=%q", auth)
	}
	if probes == 0 {
		t.Fatal("expected at least one anonymous probe while in keyed mode")
	}
	if keyed == 0 {
		t.Fatal("expected keyed requests while in fallback")
	}
}

func TestFallbackTrafficGoesThroughSocks5(t *testing.T) {
	socks := newMinimalSocks5Server(t)
	ts := &authTrackingServer{down: true}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 1
	cfg.Socks5 = "socks5://" + socks.addr()
	cfg.RotateIP = true
	p := newTestProxy(t, cfg)

	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("fallback request expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if socks.handshakes.Load() == 0 {
		t.Fatal("no SOCKS5 handshake: fallback traffic did not go through the socks5 proxy")
	}
	if !p.inKeyMode() {
		t.Fatal("expected keyed mode")
	}
}

func TestProbeKeepsKeyedModeWhileDown(t *testing.T) {
	ts := &authTrackingServer{down: true}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 1
	cfg.NoKeyProbeInterval = 30 * time.Millisecond
	p := newTestProxy(t, cfg)

	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 via keyed retry, got %d", rec.Code)
	}
	deadline := time.Now().Add(2 * time.Second)
	for p.inKeyMode() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !p.inKeyMode() {
		t.Fatal("expected probe to keep keyed mode while anonymous is down")
	}
}

func TestCircuitOpenStillTriggersFallback(t *testing.T) {
	ts := &authTrackingServer{down: true}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 2
	cfg.CircuitFailures = 1 // open the breaker after the very first 429
	cfg.CircuitCooldown = 5 * time.Minute
	p := newTestProxy(t, cfg)

	// First failure opens the breaker; the second request would normally be
	// short-circuited, but the no-key failure counting must still trip the
	// API-key fallback and transparently retry with a key.
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request 1 expected 429, got %d", rec.Code)
	}
	rec = doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("request 2 expected transparent 200 via API key despite open breaker, got %d body=%s",
			rec.Code, rec.Body.String())
	}
	if !p.inKeyMode() {
		t.Fatal("expected keyed mode after circuit-open fallback")
	}
	auth, _, keyed := ts.snapshot()
	if auth == "" || keyed == 0 {
		t.Fatalf("expected a keyed attempt, auth=%q keyed=%d", auth, keyed)
	}
}
