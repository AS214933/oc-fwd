package status

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestIngestTracksStateChanges(t *testing.T) {
	c := NewChecker(Config{Proxy: "http://127.0.0.1:9", Timeout: time.Second, History: 10})

	c.Ingest(StateEvent{Model: "m", From: "", To: "anonymous", Reason: "initial", At: 1000})
	c.Ingest(StateEvent{Model: "m", From: "anonymous", To: "keyed", Reason: "anonymous_failures", At: 2000})
	c.Ingest(StateEvent{Model: "m", From: "keyed", To: "keyed", Reason: "dup", At: 3000}) // ignored
	c.Ingest(StateEvent{Model: "m", From: "keyed", To: "keyed_failed", Reason: "keyed_error", At: 4000})

	snap := c.Snapshot()
	if len(snap.Models) != 1 {
		t.Fatalf("expected 1 model, got %d", len(snap.Models))
	}
	m := snap.Models[0]
	if m.Model != "m" || m.State != StateKeyedFail || m.Switches != 2 {
		t.Fatalf("unexpected model view: %+v", m)
	}
	if len(snap.Timeline) != 3 {
		t.Fatalf("expected 3 timeline events, got %+v", snap.Timeline)
	}
	if snap.Overall != "red" {
		t.Fatalf("expected overall red, got %s", snap.Overall)
	}
}

func TestOverallAggregation(t *testing.T) {
	c := NewChecker(Config{Proxy: "http://127.0.0.1:9", Timeout: time.Second, History: 10})
	c.Ingest(StateEvent{Model: "a", To: "anonymous"})
	c.Ingest(StateEvent{Model: "b", To: "anonymous"})
	if got := c.Snapshot().Overall; got != "green" {
		t.Fatalf("expected green, got %s", got)
	}
	c.Ingest(StateEvent{Model: "b", To: "keyed"})
	if got := c.Snapshot().Overall; got != "blue" {
		t.Fatalf("expected blue, got %s", got)
	}
	c.Ingest(StateEvent{Model: "b", To: "keyed_failed"})
	if got := c.Snapshot().Overall; got != "red" {
		t.Fatalf("expected red, got %s", got)
	}
	// One model recovers to anonymous: red still dominates.
	c.Ingest(StateEvent{Model: "b", To: "anonymous", Reason: "probe_recovered"})
	if got := c.Snapshot().Overall; got != "green" {
		t.Fatalf("expected green after recovery, got %s", got)
	}
}

func TestInvalidEventsIgnored(t *testing.T) {
	c := NewChecker(Config{Proxy: "http://127.0.0.1:9", Timeout: time.Second, History: 10})
	c.Ingest(StateEvent{Model: "m", To: "bogus"})
	c.Ingest(StateEvent{Model: "m", To: "", Type: "other"})
	if len(c.Snapshot().Models) != 0 {
		t.Fatalf("bogus events must be ignored, got %+v", c.Snapshot().Models)
	}
}

func TestTimelineBounded(t *testing.T) {
	c := NewChecker(Config{Proxy: "http://127.0.0.1:9", Timeout: time.Second, History: 5})
	for i := 0; i < 10; i++ {
		state := "anonymous"
		if i%2 == 0 {
			state = "keyed"
		}
		c.Ingest(StateEvent{Model: "m", To: state, At: int64(i)})
		// force alternating states so every event is recorded
		c.Ingest(StateEvent{Model: "m", To: reverse(state), At: int64(i) + 1000})
	}
	if got := len(c.Snapshot().Timeline); got != 5 {
		t.Fatalf("expected timeline capped at 5, got %d", got)
	}
}

func reverse(s string) string {
	if s == "anonymous" {
		return "keyed"
	}
	return "anonymous"
}

func TestReconcileSeedsAndRecoversState(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/debug/modes" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"models": []map[string]string{
				{"model": "m-a", "state": "anonymous"},
				{"model": "m-b", "state": "keyed"},
			},
		})
	}))
	defer proxy.Close()

	c := NewChecker(Config{Proxy: proxy.URL, ProxyAuth: "secret", Timeout: time.Second, History: 10, Interval: 50 * time.Millisecond})
	c.reconcile(context.Background())

	snap := c.Snapshot()
	if len(snap.Models) != 2 {
		t.Fatalf("expected 2 models from reconcile, got %+v", snap.Models)
	}
	states := map[string]State{}
	for _, m := range snap.Models {
		states[m.Model] = m.State
	}
	if states["m-a"] != StateAnonymous || states["m-b"] != StateKeyed {
		t.Fatalf("unexpected reconciled states: %+v", states)
	}
	if snap.Overall != "blue" {
		t.Fatalf("expected overall blue, got %s", snap.Overall)
	}

	// Proxy now reports m-b back to anonymous; next Run pass reconciles it.
	newProxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"models": []map[string]string{
				{"model": "m-a", "state": "anonymous"},
				{"model": "m-b", "state": "anonymous"},
			},
		})
	}))
	defer newProxy.Close()
	c.cfg.Proxy = newProxy.URL
	c.reconcile(context.Background())

	snap = c.Snapshot()
	if snap.Models[1].State != StateAnonymous {
		t.Fatalf("expected m-b reconciled to anonymous, got %+v", snap.Models[1])
	}
}
