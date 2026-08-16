package status

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"sync"
	"time"
)

// State is the status-page state of a monitored model. It mirrors the state
// machine in the proxy's fallback logic.
type State string

const (
	// StateAnonymous means requests go upstream without an API key and succeed.
	StateAnonymous State = "anonymous"
	// StateKeyed means anonymous mode is failing, so the proxy switched this
	// model to API-key calls.
	StateKeyed State = "keyed"
	// StateKeyedFail means even the keyed calls are failing.
	StateKeyedFail State = "keyed_failed"
	// StateUnknown is reported before any data arrives.
	StateUnknown State = "unknown"
)

func validState(s State) bool {
	switch s {
	case StateAnonymous, StateKeyed, StateKeyedFail:
		return true
	}
	return false
}

// StateEvent is one model state-change reported by the proxy.
type StateEvent struct {
	Type   string `json:"type"`
	Model  string `json:"model"`
	From   string `json:"from,omitempty"`
	To     string `json:"to"`
	Reason string `json:"reason,omitempty"`
	Detail string `json:"detail,omitempty"`
	At     int64  `json:"at"`
}

// ModelView is the current status of one model.
type ModelView struct {
	Model     string     `json:"model"`
	State     State      `json:"state"`
	Since     int64      `json:"since"`
	Switches  int        `json:"switches"`
	LastEvent StateEvent `json:"last_event"`
}

// Snapshot is what GET /api/status returns.
type Snapshot struct {
	Overall       State        `json:"overall"`
	LastEventAt   int64        `json:"last_event_at"`
	LastReconcile int64        `json:"last_reconcile"`
	Interval      int          `json:"interval"`
	Models        []ModelView  `json:"models"`
	Timeline      []StateEvent `json:"timeline"`
}

// Checker receives model state-change events from the proxy, keeps the
// current per-model state plus a timeline of every switch, and periodically
// reconciles with the proxy's /debug/modes endpoint so restarts or missed
// webhook deliveries cannot leave the page stale.
type Checker struct {
	cfg    Config
	client *http.Client

	mu            sync.RWMutex
	models        map[string]*ModelView
	timeline      []StateEvent
	lastReconcile time.Time
}

// NewChecker builds the event collector for the given configuration.
func NewChecker(cfg Config) *Checker {
	return &Checker{
		cfg: cfg,
		client: &http.Client{
			Timeout:   cfg.Timeout,
			Transport: &http.Transport{MaxIdleConns: 8, MaxIdleConnsPerHost: 2, IdleConnTimeout: 60 * time.Second},
		},
		models: map[string]*ModelView{},
	}
}

// Run starts the reconcile loop. The first reconcile happens immediately,
// then every cfg.Interval. Run returns when ctx is cancelled.
func (c *Checker) Run(ctx context.Context) {
	c.reconcile(ctx)
	t := time.NewTicker(c.cfg.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.reconcile(ctx)
		}
	}
}

// Ingest processes one reported state change.
func (c *Checker) Ingest(ev StateEvent) {
	if ev.Type != "" && ev.Type != "state_change" {
		return
	}
	to := State(ev.To)
	if !validState(to) {
		return
	}
	if ev.At == 0 {
		ev.At = time.Now().UnixMilli()
	}
	c.mu.Lock()
	c.applyLocked(ev)
	c.mu.Unlock()
}

// applyLocked applies an event to the internal state; caller holds c.mu.
func (c *Checker) applyLocked(ev StateEvent) {
	mv := c.models[ev.Model]
	if mv == nil {
		mv = &ModelView{Model: ev.Model}
		c.models[ev.Model] = mv
	}
	to := State(ev.To)
	if mv.State == to {
		return // same state: nothing to record
	}
	mv.State = to
	mv.Since = ev.At
	if ev.From != "" {
		mv.Switches++
	}
	mv.LastEvent = ev
	c.timeline = append(c.timeline, ev)
	if n := len(c.timeline); n > c.cfg.History {
		c.timeline = c.timeline[n-c.cfg.History:]
	}
}

// reconcile pulls the current per-model state from the proxy and records any
// difference as an event, so the page self-heals after a UI restart or a
// missed webhook.
func (c *Checker) reconcile(ctx context.Context) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.Proxy+"/debug/modes", nil)
	if err != nil {
		return
	}
	if c.cfg.ProxyAuth != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.ProxyAuth)
	}
	if c.cfg.EventToken != "" {
		req.Header.Set("X-Status-Token", c.cfg.EventToken)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		c.reconcileWhenUnavailable()
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		c.reconcileWhenUnavailable()
		return
	}
	var body struct {
		Models []struct {
			Model string `json:"model"`
			State string `json:"state"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return
	}
	now := time.Now()
	c.mu.Lock()
	c.lastReconcile = now
	for _, m := range body.Models {
		to := State(m.State)
		if !validState(to) {
			continue
		}
		mv := c.models[m.Model]
		ev := StateEvent{
			Type:  "state_change",
			Model: m.Model,
			To:    string(to),
			At:    now.UnixMilli(),
		}
		if mv == nil {
			ev.From = ""
			ev.Reason = "initial"
		} else if mv.State != to {
			ev.From = string(mv.State)
			ev.Reason = "reconciled"
		} else {
			continue
		}
		c.applyLocked(ev)
	}
	c.mu.Unlock()
}

// reconcileWhenUnavailable keeps the page alive when the proxy is down: the
// per-model state stays and the page can still show reported events.
func (c *Checker) reconcileWhenUnavailable() {
	c.mu.Lock()
	c.lastReconcile = time.Now()
	c.mu.Unlock()
}

// Snapshot returns a copy of the current state for the frontend.
func (c *Checker) Snapshot() Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	s := Snapshot{
		Interval: int(c.cfg.Interval / time.Second),
		Models:   []ModelView{},
	}
	for _, mv := range c.models {
		s.Models = append(s.Models, *mv)
	}
	sort.Slice(s.Models, func(i, j int) bool { return s.Models[i].Model < s.Models[j].Model })
	s.Timeline = append([]StateEvent(nil), c.timeline...)
	if !c.lastReconcile.IsZero() {
		s.LastReconcile = c.lastReconcile.UnixMilli()
	}
	for _, ev := range s.Timeline {
		if ev.At > s.LastEventAt {
			s.LastEventAt = ev.At
		}
	}
	switch {
	case len(s.Models) == 0:
		s.Overall = StateUnknown
	default:
		red, blue := false, false
		for _, m := range s.Models {
			switch m.State {
			case StateKeyedFail:
				red = true
			case StateKeyed:
				blue = true
			}
		}
		switch {
		case red:
			s.Overall = "red"
		case blue:
			s.Overall = "blue"
		default:
			s.Overall = "green"
		}
	}
	return s
}
