package proxy

import (
	"encoding/json"
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
// can be switched between "down" (anonymous 429) and "up" (anonymous 200),
// either globally or per model.
type authTrackingServer struct {
	mu         sync.Mutex
	down       bool
	downMap    map[string]bool
	downStatus int  // status returned for anonymous requests while down (default 429)
	errorAll   bool // return downStatus for every request (even keyed)
	lastAuth   string
	lastModel  string
	probes     int
	keyed      int
	errs       int // error responses written to anonymous/keyed clients
	keyAuths   []string
}

func (s *authTrackingServer) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var m struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal(body, &m)
	auth := r.Header.Get("Authorization")
	s.mu.Lock()
	s.lastAuth = auth
	s.lastModel = m.Model
	if strings.Contains(string(body), `"ping"`) && auth == "" {
		s.probes++
	}
	if auth != "" {
		s.keyed++
		s.keyAuths = append(s.keyAuths, strings.TrimPrefix(auth, "Bearer "))
	}
	down := s.down
	if m.Model != "" && s.downMap[m.Model] {
		down = true
	}
	status := s.downStatus
	errAll := s.errorAll
	s.mu.Unlock()
	if status == 0 {
		status = http.StatusTooManyRequests
	}
	if (auth == "" && down) || errAll {
		s.errs++
		w.WriteHeader(status)
		io.WriteString(w, `{"error":{"type":"upstream_error"}}`)
		return
	}
	io.WriteString(w, `{"id":"c1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
}

func (s *authTrackingServer) setDown(d bool) {
	s.mu.Lock()
	s.down = d
	s.mu.Unlock()
}

func (s *authTrackingServer) setDownModel(model string, d bool) {
	s.mu.Lock()
	s.downMap[model] = d
	s.mu.Unlock()
}

func (s *authTrackingServer) setDownStatus(code int) {
	s.mu.Lock()
	s.downStatus = code
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

func (s *authTrackingServer) errCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.errs
}

func (s *authTrackingServer) keyAuthsCopy() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.keyAuths))
	copy(out, s.keyAuths)
	return out
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
	if !p.inKeyMode("m") {
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
	if p.inKeyMode("m") {
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
	if !p.inKeyMode("m") {
		t.Fatal("expected keyed mode after fallback")
	}

	// Anonymous recovers; the probe should flip the proxy back.
	ts.setDown(false)
	deadline := time.Now().Add(3 * time.Second)
	for p.inKeyMode("m") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if p.inKeyMode("m") {
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
	if !p.inKeyMode("m") {
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
	for p.inKeyMode("m") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !p.inKeyMode("m") {
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
	if !p.inKeyMode("m") {
		t.Fatal("expected keyed mode after circuit-open fallback")
	}
	auth, _, keyed := ts.snapshot()
	if auth == "" || keyed == 0 {
		t.Fatalf("expected a keyed attempt, auth=%q keyed=%d", auth, keyed)
	}
}

// TestPerModelFallbackIsIndependent verifies a 429 storm on model A only
// switches model A to API-key mode while model B keeps going anonymously.
func TestPerModelFallbackIsIndependent(t *testing.T) {
	ts := &authTrackingServer{downMap: map[string]bool{"model-a": true}}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 1
	cfg.NoKeyProbeInterval = time.Hour // keep the recovery probe out of the way
	p := newTestProxy(t, cfg)

	// model-a fails anonymously once and must transparently use a key.
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"model-a","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("model-a fallback expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !p.inKeyMode("model-a") {
		t.Fatal("model-a should be in keyed mode")
	}
	auth, _, keyed := ts.snapshot()
	if auth == "" || !strings.HasPrefix(auth, "Bearer key-") || keyed == 0 {
		t.Fatalf("expected a keyed request for model-a, auth=%q keyed=%d", auth, keyed)
	}

	// model-b is healthy: it stays anonymous and succeeds without a key even
	// though model-a already fell back.
	rec = doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"model-b","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("model-b expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if p.inKeyMode("model-b") {
		t.Fatal("model-b should stay anonymous")
	}
	auth, _, _ = ts.snapshot()
	if auth != "" {
		t.Fatalf("expected anonymous request for model-b, auth=%q", auth)
	}

	// model-a keeps using a key on later requests; model-b keeps going
	// without one.
	rec = doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"model-a","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("model-a second call expected 200, got %d", rec.Code)
	}
	auth, _, _ = ts.snapshot()
	if !strings.HasPrefix(auth, "Bearer key-") {
		t.Fatalf("expected keyed request for model-a, auth=%q", auth)
	}
}

// TestProbeRecoversSingleModel verifies recovery probing is per model: when
// model-a's anonymous path recovers only model-a flips back to anonymous,
// model-b remains in keyed mode.
func TestProbeRecoversSingleModel(t *testing.T) {
	ts := &authTrackingServer{downMap: map[string]bool{"model-a": true, "model-b": true}}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 1
	cfg.NoKeyProbeInterval = 30 * time.Millisecond
	p := newTestProxy(t, cfg)

	for _, model := range []string{"model-a", "model-b"} {
		rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
			`{"model":"`+model+`","messages":[]}`, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s fallback expected 200, got %d body=%s", model, rec.Code, rec.Body.String())
		}
	}
	if !p.inKeyMode("model-a") || !p.inKeyMode("model-b") {
		t.Fatal("both models should be in keyed mode")
	}

	// model-a anonymous recovers; only model-a must flip back.
	ts.setDownModel("model-a", false)
	deadline := time.Now().Add(3 * time.Second)
	for p.inKeyMode("model-a") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if p.inKeyMode("model-a") {
		t.Fatal("model-a should have switched back to anonymous after recovery")
	}
	if !p.inKeyMode("model-b") {
		t.Fatal("model-b should remain in keyed mode")
	}
}

// TestKeyedRequestsPickRandomKey verifies every keyed request draws one key at
// random from the whole pool: over enough requests both keys appear and each
// is used a substantial share of the time.
func TestKeyedRequestsPickRandomKey(t *testing.T) {
	ts := &authTrackingServer{down: true}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL) // APIKeys = key-A, key-B
	cfg.NoKeyFailThreshold = 1
	cfg.NoKeyProbeInterval = time.Hour
	p := newTestProxy(t, cfg)

	const n = 200
	for i := 0; i < n; i++ {
		rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
			`{"model":"m","messages":[]}`, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d expected 200, got %d", i, rec.Code)
		}
	}
	if !p.inKeyMode("m") {
		t.Fatal("expected keyed mode after fallback")
	}

	auths := ts.keyAuthsCopy()
	if len(auths) != n {
		t.Fatalf("expected %d keyed requests, got %d", n, len(auths))
	}
	seen := map[string]bool{}
	counts := map[string]int{}
	for _, k := range auths {
		seen[k] = true
		counts[k]++
	}
	if !seen["key-A"] || !seen["key-B"] {
		t.Fatalf("expected both pool keys to be picked over %d requests, seen=%v", n, seen)
	}
	for k, c := range counts {
		if c < n/4 {
			t.Fatalf("key %s used only %d/%d times; picks are not random enough", k, c, n)
		}
	}
}

// TestServerErrorRetriesThenFallsBack verifies a 5xx (e.g. 503) follows the
// same flow as 4xx: it retries with backoff, and once retries are exhausted
// the model switches to API-key mode and the very same request is
// transparently retried with a key, so the client never sees the 5xx.
func TestServerErrorRetriesThenFallsBack(t *testing.T) {
	ts := &authTrackingServer{down: true}
	ts.setDownStatus(http.StatusServiceUnavailable)
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyProbeInterval = time.Hour
	p := newTestProxy(t, cfg)

	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"content":"ok"`) {
		t.Fatalf("expected transparent 200 via API key, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !p.inKeyMode("m") {
		t.Fatal("expected model to be in keyed mode after 5xx retry exhaustion")
	}
	// baseCfg RetryMax=2 means attempts 0,1,2 hit the upstream anonymously
	// (3 tries) before the fallback kicks in and retries with a key.
	if errs := ts.errCount(); errs != 3 {
		t.Fatalf("expected 3 anonymous 5xx tries before falling back, got %d", errs)
	}
	auth, _, keyed := ts.snapshot()
	if auth == "" || !strings.HasPrefix(auth, "Bearer key-") || keyed == 0 {
		t.Fatalf("expected a keyed retry, auth=%q keyed=%d", auth, keyed)
	}
}

// TestServerErrorSurfacedWhenKeyedAlsoFails verifies the client only sees the
// 5xx when the keyed retry fails too.
func TestServerErrorSurfacedWhenKeyedAlsoFails(t *testing.T) {
	ts := &authTrackingServer{down: true, errorAll: true}
	ts.setDownStatus(http.StatusServiceUnavailable)
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.RetryMax = 1 // keep backoff quick
	cfg.NoKeyProbeInterval = time.Hour
	p := newTestProxy(t, cfg)

	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
		`{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when keyed retry also fails, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !p.inKeyMode("m") {
		t.Fatal("model should be in keyed mode after falling back")
	}
	// RetryMax=1: 2 anonymous tries, then 2 keyed tries, then the 503 is
	// surfaced. The client only sees the failure once the keyed retries fail.
	if errs := ts.errCount(); errs != 4 {
		t.Fatalf("expected 2 anonymous + 2 keyed 5xx tries, got %d", errs)
	}
}
