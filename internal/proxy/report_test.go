package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// eventSink records StateEvents delivered to the status UI.
type eventSink struct {
	mu     sync.Mutex
	events []StateEvent
}

func (s *eventSink) handler(w http.ResponseWriter, r *http.Request) {
	var ev StateEvent
	_ = json.NewDecoder(r.Body).Decode(&ev)
	s.mu.Lock()
	s.events = append(s.events, ev)
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *eventSink) snapshot() []StateEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]StateEvent, len(s.events))
	copy(out, s.events)
	return out
}

func (s *eventSink) waitFor(t *testing.T, n int) []StateEvent {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if ev := s.snapshot(); len(ev) >= n {
			return ev
		}
		time.Sleep(10 * time.Millisecond)
	}
	ev := s.snapshot()
	t.Fatalf("timed out waiting for %d events, got %d: %+v", n, len(ev), ev)
	return nil
}

func TestReporterDeliversStateEvents(t *testing.T) {
	sink := &eventSink{}
	srv := httptest.NewServer(http.HandlerFunc(sink.handler))
	defer srv.Close()

	rep := newReporter(srv.URL, "")
	rep.start()
	rep.send(StateEvent{Model: "m", From: stateAnonymous, To: stateKeyed, Reason: "test"})
	rep.send(StateEvent{Model: "m", From: stateKeyed, To: stateKeyedFail, Reason: "test"})

	ev := sink.waitFor(t, 2)
	if ev[0].Type != "state_change" || ev[0].Model != "m" || ev[0].To != stateKeyed {
		t.Fatalf("unexpected first event: %+v", ev[0])
	}
	if ev[1].To != stateKeyedFail {
		t.Fatalf("unexpected second event: %+v", ev[1])
	}
	if ev[0].At == 0 || ev[1].At == 0 {
		t.Fatalf("expected timestamps, got %+v", ev)
	}
}

func TestSwitchEventsOnFallbackLifecycle(t *testing.T) {
	sink := &eventSink{}
	sinkSrv := httptest.NewServer(http.HandlerFunc(sink.handler))
	defer sinkSrv.Close()

	ts := &authTrackingServer{down: true, errorAll: true}
	upstream := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer upstream.Close()

	cfg := fallbackCfg(t, upstream.URL)
	cfg.StatusURL = sinkSrv.URL
	cfg.NoKeyFailThreshold = 2
	p := newTestProxy(t, cfg)

	// 1: anonymous 429 (failure 1/2) -> surfaced.
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions", `{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request 1 expected 429, got %d", rec.Code)
	}
	// 2: anonymous 429 crosses the threshold -> switch to keyed, keyed also
	// fails -> keyed_failed. No events yet (delivery is async).
	rec = doJSON(t, p.Handler(), "POST", "/v1/chat/completions", `{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request 2 expected 429, got %d", rec.Code)
	}

	ev := sink.waitFor(t, 2)
	if ev[0].To != stateKeyed || ev[0].Reason != "anonymous_failures" {
		t.Fatalf("expected anonymous->keyed event, got %+v", ev[0])
	}
	if ev[1].To != stateKeyedFail || ev[1].Reason != "keyed_error" {
		t.Fatalf("expected keyed->keyed_failed event, got %+v", ev[1])
	}

	// Keyed starts succeeding: next request recovers keyed mode.
	ts.mu.Lock()
	ts.errorAll = false
	ts.mu.Unlock()
	rec = doJSON(t, p.Handler(), "POST", "/v1/chat/completions", `{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 after keyed recovery, got %d", rec.Code)
	}
	ev = sink.waitFor(t, 3)
	if ev[2].To != stateKeyed || ev[2].From != stateKeyedFail {
		t.Fatalf("expected keyed_failed->keyed recovery event, got %+v", ev[2])
	}

	// Anonymous mode recovers: the probe flips the model back.
	ts.setDown(false)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && p.inKeyMode("m") {
		time.Sleep(20 * time.Millisecond)
	}
	ev = sink.waitFor(t, 4)
	if ev[3].To != stateAnonymous || ev[3].Reason != "probe_recovered" {
		t.Fatalf("expected keyed->anonymous probe recovery event, got %+v", ev[3])
	}
}

func TestServerErrorSwitchEvent(t *testing.T) {
	sink := &eventSink{}
	sinkSrv := httptest.NewServer(http.HandlerFunc(sink.handler))
	defer sinkSrv.Close()

	ts := &authTrackingServer{down: true, downStatus: http.StatusServiceUnavailable}
	upstream := httptest.NewServer(http.HandlerFunc(ts.handler))
	defer upstream.Close()

	cfg := fallbackCfg(t, upstream.URL)
	cfg.StatusURL = sinkSrv.URL
	p := newTestProxy(t, cfg)

	// Non-2xx retries exhaust quickly (RetryMax=2) -> forceSwitchToKey: the
	// very first request transparently succeeds via the key.
	rec := doJSON(t, p.Handler(), "POST", "/v1/chat/completions", `{"model":"m","messages":[]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected transparent keyed success, got %d", rec.Code)
	}
	ev := sink.waitFor(t, 1)
	if ev[0].To != stateKeyed || ev[0].Reason != "upstream_error" {
		t.Fatalf("expected upstream_error switch event, got %+v", ev[0])
	}
}

func TestDebugModes(t *testing.T) {
	cfg := fallbackCfg(t, "http://upstream.test/zen/v1")
	cfg.Models = []string{"m-a", "m-b"}
	p := newTestProxy(t, cfg)

	mode := func() map[string]string {
		rec := doJSON(t, p.Handler(), "GET", "/debug/modes", "", nil)
		var body struct {
			Models []struct {
				Model string `json:"model"`
				State string `json:"state"`
			} `json:"models"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for _, m := range body.Models {
			out[m.Model] = m.State
		}
		return out
	}

	// All configured models start anonymous.
	rec := doJSON(t, p.Handler(), "GET", "/debug/modes", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := mode(); got["m-a"] != stateAnonymous || got["m-b"] != stateAnonymous {
		t.Fatalf("expected anonymous modes, got %+v", got)
	}

	// Force the fallback into keyed mode and confirm the endpoint reflects it.
	if !p.forceSwitchToKey("m-a") {
		t.Fatal("expected switch")
	}
	if got := mode(); got["m-a"] != stateKeyed {
		t.Fatalf("expected m-a keyed, got %+v", got)
	}
}

func TestDebugModesAcceptsStatusToken(t *testing.T) {
	cfg := baseCfg()
	cfg.AuthKey = "caller-secret"     // proxy is key-guarded
	cfg.StatusToken = "status-secret" // status UI is allowed via this token
	cfg.Models = []string{"m"}
	p := newTestProxy(t, cfg)

	// Without any credential the debug endpoint is 401.
	rec := doJSON(t, p.Handler(), "GET", "/debug/modes", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without credentials, got %d", rec.Code)
	}
	// The caller key passes.
	rec = doJSON(t, p.Handler(), "GET", "/debug/modes", "", map[string]string{"Authorization": "Bearer caller-secret"})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 with caller key, got %d", rec.Code)
	}
	// The status reporting token passes via X-Status-Token.
	rec = doJSON(t, p.Handler(), "GET", "/debug/modes", "", map[string]string{"X-Status-Token": "status-secret"})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 with status token, got %d", rec.Code)
	}
	// A wrong token is rejected.
	rec = doJSON(t, p.Handler(), "GET", "/debug/modes", "", map[string]string{"X-Status-Token": "nope"})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong token, got %d", rec.Code)
	}
}
