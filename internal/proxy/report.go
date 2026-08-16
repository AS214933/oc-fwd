package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"
)

// Model states reported to the status UI. A model lives in exactly one of
// these states at a time:
//
//	anonymous    - calls go upstream without an API key and succeed (green)
//	keyed        - anonymous mode is failing, so calls go out with an API key (blue)
//	keyed_failed - even the keyed calls are failing (red)
const (
	stateAnonymous = "anonymous"
	stateKeyed     = "keyed"
	stateKeyedFail = "keyed_failed"
)

// StateEvent is a model state change pushed to the status UI. Clients are
// expected to POST these to /api/events, optionally wrapped in an array.
type StateEvent struct {
	Type   string `json:"type"`
	Model  string `json:"model"`
	From   string `json:"from,omitempty"`
	To     string `json:"to"`
	Reason string `json:"reason,omitempty"`
	Detail string `json:"detail,omitempty"`
	At     int64  `json:"at"`
}

// reporter forwards state changes to the status UI. It is fire-and-forget:
// events are queued on a buffered channel and dropped when the queue is full
// or the UI is unreachable, so reporting can never slow down or break the
// proxy request path.
type reporter struct {
	url    string
	token  string
	client *http.Client
	ch     chan StateEvent
}

func newReporter(url, token string) *reporter {
	return &reporter{
		url:    url,
		token:  token,
		client: &http.Client{Timeout: 3 * time.Second},
		ch:     make(chan StateEvent, 1024),
	}
}

// start launches the background delivery loop.
func (r *reporter) start() {
	go r.loop()
}

// send queues an event without blocking the caller.
func (r *reporter) send(ev StateEvent) {
	if r == nil {
		return
	}
	if ev.Type == "" {
		ev.Type = "state_change"
	}
	if ev.At == 0 {
		ev.At = time.Now().UnixMilli()
	}
	select {
	case r.ch <- ev:
	default: // drop on overflow
	}
}

// loop drains the queue and delivers each event as an HTTP POST to the UI.
func (r *reporter) loop() {
	for ev := range r.ch {
		payload, _ := json.Marshal(ev)
		req, err := http.NewRequest(http.MethodPost, r.url+"/api/events", bytes.NewReader(payload))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		if r.token != "" {
			req.Header.Set("Authorization", "Bearer "+r.token)
		}
		resp, err := r.client.Do(req)
		if err != nil {
			// The UI is optional; never retry and never surface errors.
			continue
		}
		resp.Body.Close()
	}
}
