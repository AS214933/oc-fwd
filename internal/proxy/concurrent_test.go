package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// fireConcurrent sends n parallel completion requests and returns all codes.
func fireConcurrent(t *testing.T, p *Proxy, n int) []int {
	t.Helper()
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions",
				`{"model":"m","messages":[]}`, nil)
			codes[i] = rec.Code
		}(i)
	}
	wg.Wait()
	return codes
}

func countStatus(codes []int, want int) int {
	n := 0
	for _, c := range codes {
		if c == want {
			n++
		}
	}
	return n
}

func TestConcurrent429StormNoLeakedErrors(t *testing.T) {
	ts := &authTrackingServer{down: true}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 3
	cfg.RetryMax = 2
	cfg.RetryBaseBackoff = time.Millisecond
	cfg.RetryMaxBackoff = 5 * time.Millisecond
	p := newTestProxy(t, cfg)

	n := 40
	codes := fireConcurrent(t, p, n)

	// The threshold is 3: the up-to-threshold-1 requests that exhaust their
	// anonymous retries before the switch are expected 429s. Every request
	// that exhausts after the model switched must be retried with a key, so
	// no request may leak an error once key mode is engaged.
	leaked := countStatus(codes, http.StatusTooManyRequests) + countStatus(codes, http.StatusBadGateway) + countStatus(codes, http.StatusServiceUnavailable)
	if leaked > cfg.NoKeyFailThreshold-1 {
		t.Fatalf("%d/%d concurrent requests leaked an error (allowed <= %d): %v", leaked, n, cfg.NoKeyFailThreshold-1, codes)
	}
	if ok := countStatus(codes, http.StatusOK); ok != n-leaked {
		t.Fatalf("want %d OK, got %d: %v", n-leaked, ok, codes)
	}
	if !p.inKeyMode("m") {
		t.Fatal("expected proxy to be in keyed mode after the storm")
	}
	if _, _, keyed := ts.snapshot(); keyed == 0 {
		t.Fatal("expected keyed upstream attempts")
	}
}

func TestConcurrent503StormNoLeakedErrors(t *testing.T) {
	ts := &authTrackingServer{down: true, downStatus: http.StatusServiceUnavailable}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 3
	cfg.RetryMax = 2
	cfg.RetryBaseBackoff = time.Millisecond
	cfg.RetryMaxBackoff = 5 * time.Millisecond
	p := newTestProxy(t, cfg)

	n := 40
	codes := fireConcurrent(t, p, n)

	if leaked := countStatus(codes, http.StatusTooManyRequests) + countStatus(codes, http.StatusBadGateway) + countStatus(codes, http.StatusServiceUnavailable); leaked > 0 {
		t.Fatalf("%d/%d concurrent requests leaked an error to clients instead of the transparent keyed retry: %v", leaked, n, codes)
	}
	if ok := countStatus(codes, http.StatusOK); ok != n {
		t.Fatalf("want %d OK, got %d: %v", n, ok, codes)
	}
	if !p.inKeyMode("m") {
		t.Fatal("expected proxy to be in keyed mode after the storm")
	}
}

// When even keyed requests fail, the proxy must not loop forever: every client
// request should terminate after a bounded number of upstream attempts.
func TestConcurrentErrorsBothModesBoundedRetries(t *testing.T) {
	ts := &authTrackingServer{down: true, downStatus: http.StatusServiceUnavailable, errorAll: true}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 1
	cfg.RetryMax = 1
	cfg.RetryBaseBackoff = time.Millisecond
	cfg.RetryMaxBackoff = 5 * time.Millisecond
	p := newTestProxy(t, cfg)

	n := 20
	codes := fireConcurrent(t, p, n)

	// Every request should surface the upstream 503 (keyed also failed).
	if bad := countStatus(codes, http.StatusServiceUnavailable); bad != n {
		t.Fatalf("want %d surfaced 503s, got %d: %v", n, bad, codes)
	}
	maxAttempts := n * (cfg.RetryMax + 1) * 2
	if errs := ts.errCount(); errs > maxAttempts {
		t.Fatalf("upstream hit too many times: errs=%d (> %d): request loop did not terminate", errs, maxAttempts)
	}
}

// Keyed requests that also get 429 must terminate: each client request
// surfaces the error after its bounded keyed retries instead of restarting
// the retry loop forever.
func TestConcurrent429BothModesBoundedRetries(t *testing.T) {
	ts := &authTrackingServer{down: true, errorAll: true} // default downStatus = 429
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 1
	cfg.RetryMax = 1
	cfg.RetryBaseBackoff = time.Millisecond
	cfg.RetryMaxBackoff = 5 * time.Millisecond
	p := newTestProxy(t, cfg)

	n := 20
	codes := fireConcurrent(t, p, n)

	if bad := countStatus(codes, http.StatusTooManyRequests); bad != n {
		t.Fatalf("want %d surfaced 429s, got %d: %v", n, bad, codes)
	}
	maxAttempts := n * (cfg.RetryMax + 1) * 2
	if errs := ts.errCount(); errs > maxAttempts {
		t.Fatalf("upstream hit too many times: errs=%d (> %d): request loop did not terminate", errs, maxAttempts)
	}
}

// Under high concurrency the rotate-ip path must still open a fresh SOCKS5
// connection per request: same exit-IP rotation guarantee, no pooled reuse.
func TestConcurrentRotateIPFreshConnectionPerRequest(t *testing.T) {
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

	const n = 40
	codes := fireConcurrent(t, p, n)
	if ok := countStatus(codes, http.StatusOK); ok != n {
		t.Fatalf("want %d OK, got %d: %v", n, ok, codes)
	}
	if got := socks.handshakes.Load(); got < n {
		t.Fatalf("expected >= %d fresh SOCKS5 connections under concurrency, got %d", n, got)
	}
}

func TestConcurrent400StormNoLeakedErrors(t *testing.T) {
	ts := &authTrackingServer{down: true, downStatus: http.StatusBadRequest}
	srv := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer srv.Close()

	cfg := fallbackCfg(t, srv.URL)
	cfg.NoKeyFailThreshold = 3
	cfg.RetryMax = 2
	cfg.RetryBaseBackoff = time.Millisecond
	cfg.RetryMaxBackoff = 5 * time.Millisecond
	p := newTestProxy(t, cfg)

	n := 40
	codes := fireConcurrent(t, p, n)

	if leaked := countStatus(codes, http.StatusBadRequest) + countStatus(codes, http.StatusTooManyRequests) + countStatus(codes, http.StatusBadGateway) + countStatus(codes, http.StatusServiceUnavailable); leaked > 0 {
		t.Fatalf("%d/%d concurrent requests leaked an error to clients instead of the transparent keyed retry: %v", leaked, n, codes)
	}
	if ok := countStatus(codes, http.StatusOK); ok != n {
		t.Fatalf("want %d OK, got %d: %v", n, ok, codes)
	}
	if !p.inKeyMode("m") {
		t.Fatal("expected proxy to be in keyed mode after the storm")
	}
}
