package status

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// chatStub serves /v1/chat/completions with the given status. When requireKey
// is true a valid Authorization: Bearer token is required for a 2xx.
func chatStub(status int, requireKey bool, key string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"object":"list","data":[{"id":"m-a"},{"id":"m-b"}]}`))
			return
		}
		if requireKey && r.Header.Get("Authorization") != "Bearer "+key {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status >= 200 && status < 300 {
			w.Write([]byte(`{"id":"c","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"pong"},"finish_reason":"stop"}]}`))
		} else {
			w.Write([]byte(`{"error":{"message":"boom"}}`))
		}
	})
}

func setup(t *testing.T, proxyH, upstreamH http.Handler, withKey bool) (*Checker, *httptest.Server, *httptest.Server) {
	t.Helper()
	proxy := httptest.NewServer(proxyH)
	upstream := httptest.NewServer(upstreamH)
	t.Cleanup(proxy.Close)
	t.Cleanup(upstream.Close)
	cfg := Config{
		Proxy:    proxy.URL,
		Interval: time.Hour, // run cycles manually
		Timeout:  5 * time.Second,
		History:  10,
	}
	if withKey {
		cfg.APIKey = "test-key"
		cfg.Upstream = upstream.URL
	}
	return NewChecker(cfg), proxy, upstream
}

func runCycle(t *testing.T, c *Checker) Snapshot {
	t.Helper()
	c.cycle(context.Background())
	return c.Snapshot()
}

func TestGreenAnonymousSucceeds(t *testing.T) {
	c, _, _ := setup(t, chatStub(200, false, ""), chatStub(200, true, "test-key"), true)
	c.models = []string{"m-a"}

	snap := runCycle(t, c)
	if len(snap.Models) != 1 {
		t.Fatalf("expected 1 model, got %d", len(snap.Models))
	}
	if snap.Models[0].State != StateGreen {
		t.Fatalf("expected green, got %s", snap.Models[0].State)
	}
	if !snap.Models[0].Anonymous.OK {
		t.Fatalf("anonymous probe should have succeeded")
	}
	if snap.Overall != StateGreen {
		t.Fatalf("expected overall green, got %s", snap.Overall)
	}
}

func TestBlueKeyOnlySucceeds(t *testing.T) {
	// Anonymous through the proxy fails (503), but the API-key call to the
	// upstream succeeds -> blue.
	c, _, _ := setup(t, chatStub(503, false, ""), chatStub(200, true, "test-key"), true)
	c.models = []string{"m-a"}

	snap := runCycle(t, c)
	ms := snap.Models[0]
	if ms.State != StateBlue {
		t.Fatalf("expected blue, got %s", ms.State)
	}
	if ms.Anonymous.OK {
		t.Fatalf("anonymous probe should have failed")
	}
	if !ms.Keyed.OK {
		t.Fatalf("keyed probe should have succeeded")
	}
	if snap.Overall != StateBlue {
		t.Fatalf("expected overall blue, got %s", snap.Overall)
	}
}

func TestRedAllFail(t *testing.T) {
	c, _, _ := setup(t, chatStub(503, false, ""), chatStub(503, true, "test-key"), true)
	c.models = []string{"m-a"}

	snap := runCycle(t, c)
	ms := snap.Models[0]
	if ms.State != StateRed {
		t.Fatalf("expected red, got %s", ms.State)
	}
	if ms.Anonymous.Status != 503 || ms.Keyed.Status != 503 {
		t.Fatalf("expected both probes to report 503, got %d/%d", ms.Anonymous.Status, ms.Keyed.Status)
	}
	if snap.Overall != StateRed {
		t.Fatalf("expected overall red, got %s", snap.Overall)
	}
}

func TestRedWhenKeyedProbesDisabled(t *testing.T) {
	// Without STATUS_API_KEY the keyed probe is skipped: anonymous failure
	// directly yields red, and the keyed slot explains why.
	c, _, _ := setup(t, chatStub(503, false, ""), nil, false)
	c.models = []string{"m-a"}

	snap := runCycle(t, c)
	ms := snap.Models[0]
	if ms.State != StateRed {
		t.Fatalf("expected red, got %s", ms.State)
	}
	if ms.Keyed.OK || ms.Keyed.Error == "" {
		t.Fatalf("expected keyed slot to explain it is not configured, got %+v", ms.Keyed)
	}
	if snap.Keyed {
		t.Fatalf("snapshot.Keyed should be false")
	}
}

func TestAnonymousKeyNotSentByDefault(t *testing.T) {
	// Anonymous probes must not carry a key: mock upstream only answers
	// 200 without Authorization and 401 with one.
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	c, _, _ := setup(t, chatStub(200, false, ""), upstream, true)
	c.models = []string{"m-a"}

	snap := runCycle(t, c)
	if !snap.Models[0].Anonymous.OK {
		t.Fatalf("anonymous probe carried an unexpected key: %+v", snap.Models[0].Anonymous)
	}
}

func TestModelDiscoveryAndHistoryIncidents(t *testing.T) {
	proxy := httptest.NewServer(chatStub(200, false, ""))
	upstream := httptest.NewServer(chatStub(200, true, "test-key"))
	defer proxy.Close()
	defer upstream.Close()

	cfg := Config{
		Proxy:    proxy.URL,
		Upstream: upstream.URL,
		APIKey:   "test-key",
		Timeout:  5 * time.Second,
		History:  10,
	}
	c := NewChecker(cfg)
	if len(c.models) != 0 {
		t.Fatalf("expected no configured models, got %v", c.models)
	}

	snap := runCycle(t, c)
	if len(snap.Models) != 2 {
		t.Fatalf("expected 2 discovered models, got %v", snap.Models)
	}
	for _, m := range snap.Models {
		if m.State != StateGreen {
			t.Fatalf("expected green for %s, got %s", m.Model, m.State)
		}
	}
	if len(snap.History["m-a"]) != 1 {
		t.Fatalf("expected history for m-a, got %+v", snap.History)
	}

	// Flip the proxy to failing: the next cycle must record green->blue
	// incidents and history bars for both models.
	bad := chatStub(503, false, "")
	proxy.Config.Handler = bad

	snap = runCycle(t, c)
	if snap.Overall != StateBlue {
		t.Fatalf("expected overall blue, got %s", snap.Overall)
	}
	if len(snap.Incidents) < 2 {
		t.Fatalf("expected incidents for both models, got %+v", snap.Incidents)
	}
	for _, inc := range snap.Incidents {
		if inc.From != StateGreen || inc.To != StateBlue {
			t.Fatalf("expected green->blue incident, got %s->%s", inc.From, inc.To)
		}
		if !strings.Contains(inc.Detail, "503") {
			t.Fatalf("expected incident detail to mention status, got %q", inc.Detail)
		}
	}
	if got := snap.History["m-a"]; len(got) != 2 || got[0] != StateGreen || got[1] != StateBlue {
		t.Fatalf("unexpected history %v", got)
	}
}

func TestHistoryBounded(t *testing.T) {
	c, _, _ := setup(t, chatStub(200, false, ""), chatStub(200, true, "test-key"), true)
	c.models = []string{"m-a"}
	for i := 0; i < 15; i++ {
		runCycle(t, c)
	}
	if got := len(c.Snapshot().History["m-a"]); got != 10 {
		t.Fatalf("expected history capped at 10, got %d", got)
	}
}

func TestOverallAggregation(t *testing.T) {
	proxy := httptest.NewServer(chatStub(503, false, ""))
	upstream := httptest.NewServer(chatStub(200, true, "test-key"))
	defer proxy.Close()
	defer upstream.Close()

	cfg := Config{
		Proxy:    proxy.URL,
		Upstream: upstream.URL,
		APIKey:   "test-key",
		Models:   []string{"m-a", "m-b"},
		Timeout:  5 * time.Second,
		History:  10,
	}
	c := NewChecker(cfg)

	// Both models are blue -> overall blue.
	if snap := runCycle(t, c); snap.Overall != StateBlue {
		t.Fatalf("expected overall blue, got %s", snap.Overall)
	}

	// One model turns red (keyed also fails) -> overall red dominates.
	proxy.Config.Handler = chatStub(503, false, "")
	upstream.Config.Handler = chatStub(503, true, "test-key")
	if snap := runCycle(t, c); snap.Overall != StateRed {
		t.Fatalf("expected overall red, got %s", snap.Overall)
	}
}
