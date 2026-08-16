package status

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// State is the health state of a monitored model.
type State string

const (
	// StateGreen means the anonymous call through the proxy succeeded.
	StateGreen State = "green"
	// StateBlue means the anonymous call failed but an API-key call succeeded.
	StateBlue State = "blue"
	// StateRed means every call failed (anonymous and API-key).
	StateRed State = "red"
	// StateUnknown is used before the first probe cycle completes.
	StateUnknown State = "unknown"
)

// Probe is the result of a single probe request.
type Probe struct {
	OK        bool   `json:"ok"`
	Status    int    `json:"status"`
	LatencyMS int64  `json:"latency_ms"`
	Error     string `json:"error,omitempty"`
}

// ModelStatus is the aggregated status of one model.
type ModelStatus struct {
	Model     string `json:"model"`
	State     State  `json:"state"`
	Anonymous Probe  `json:"anonymous"`
	Keyed     Probe  `json:"keyed,omitempty"`
	CheckedAt int64  `json:"checked_at"`
}

// Incident records a state transition.
type Incident struct {
	Time   int64  `json:"time"`
	Model  string `json:"model"`
	From   State  `json:"from"`
	To     State  `json:"to"`
	Detail string `json:"detail,omitempty"`
}

// Snapshot is what GET /api/status returns.
type Snapshot struct {
	Overall   State              `json:"overall"`
	CheckedAt int64              `json:"checked_at"`
	Interval  int                `json:"interval"` // seconds
	Keyed     bool               `json:"keyed"`    // whether API-key probes are enabled
	Models    []ModelStatus      `json:"models"`
	History   map[string][]State `json:"history"`
	Incidents []Incident         `json:"incidents"`
}

// Checker periodically probes the monitored models and keeps the latest
// state, per-model history and incident list.
type Checker struct {
	cfg    Config
	client *http.Client
	keyed  bool

	mu        sync.RWMutex
	models    []string
	overall   State
	checkedAt time.Time
	states    map[string]State
	anon      map[string]Probe
	keyedRes  map[string]Probe
	history   map[string][]State
	incidents []Incident
}

// NewChecker builds a checker for the given configuration.
func NewChecker(cfg Config) *Checker {
	return &Checker{
		cfg: cfg,
		client: &http.Client{
			Timeout: cfg.Timeout,
			Transport: &http.Transport{
				MaxIdleConns:        16,
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     60 * time.Second,
			},
		},
		keyed:    cfg.APIKey != "",
		states:   map[string]State{},
		anon:     map[string]Probe{},
		keyedRes: map[string]Probe{},
		history:  map[string][]State{},
		models:   append([]string(nil), cfg.Models...),
	}
}

// Run starts the probe loop. It runs the first cycle immediately, then every
// cfg.Interval. Run returns when ctx is cancelled.
func (c *Checker) Run(ctx context.Context) {
	c.cycle(ctx)
	t := time.NewTicker(c.cfg.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.cycle(ctx)
		}
	}
}

// cycle is one full probe pass.
func (c *Checker) cycle(ctx context.Context) {
	models := c.models
	if len(models) == 0 {
		models = c.discoverModels(ctx)
	}
	if len(models) == 0 {
		return
	}

	previous := c.Snapshot()
	states := map[string]State{}
	anon := map[string]Probe{}
	keyedRes := map[string]Probe{}
	checkedAt := time.Now()

	for _, model := range models {
		a := c.probeChat(ctx, c.cfg.Proxy, model, "")
		anon[model] = a
		var k Probe
		if c.keyed {
			k = c.probeChat(ctx, c.cfg.Upstream, model, c.cfg.APIKey)
			keyedRes[model] = k
		}
		states[model] = combine(a, k, c.keyed)
	}

	c.mu.Lock()
	c.models = mergeModels(c.models, models)
	c.overall = overallState(states)
	c.checkedAt = checkedAt
	c.states = states
	c.anon = anon
	c.keyedRes = keyedRes
	for _, model := range models {
		st := states[model]
		c.history[model] = append(c.history[model], st)
		if n := len(c.history[model]); n > c.cfg.History {
			c.history[model] = c.history[model][n-c.cfg.History:]
		}
		if old := previous.lookup(model); old != StateUnknown && old != st {
			c.incidents = append(c.incidents, incident(checkedAt, model, old, st, anon[model], keyedRes[model]))
		}
	}
	if n := len(c.incidents); n > 100 {
		c.incidents = c.incidents[n-100:]
	}
	c.mu.Unlock()
}

// probeChat sends one chat completion probe and returns its outcome.
func (c *Checker) probeChat(ctx context.Context, base, model, key string) Probe {
	body := fmt.Sprintf(
		`{"model":%q,"messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}`,
		model,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		return Probe{Error: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	} else if c.cfg.ProxyAuth != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.ProxyAuth)
	}

	start := time.Now()
	resp, err := c.client.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return Probe{Error: err.Error(), LatencyMS: latency}
	}
	defer resp.Body.Close()
	detail := strings.TrimSpace(slurp(resp.Body, 300))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return Probe{OK: true, Status: resp.StatusCode, LatencyMS: latency}
	}
	if detail == "" {
		detail = http.StatusText(resp.StatusCode)
	}
	return Probe{Status: resp.StatusCode, LatencyMS: latency, Error: detail}
}

// discoverModels lists models from the proxy's GET /v1/models endpoint.
func (c *Checker) discoverModels(ctx context.Context) []string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.Proxy+"/v1/models", nil)
	if err != nil {
		return nil
	}
	if c.cfg.ProxyAuth != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.ProxyAuth)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil
	}
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return nil
	}
	var out []string
	for _, m := range list.Data {
		if m.ID != "" {
			out = append(out, m.ID)
		}
	}
	sort.Strings(out)
	return out
}

// Snapshot returns a copy of the current state for the frontend.
func (c *Checker) Snapshot() Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.snapshotLocked()
}

func (c *Checker) snapshotLocked() Snapshot {
	s := Snapshot{
		Overall:   c.overall,
		Interval:  int(c.cfg.Interval / time.Second),
		Keyed:     c.keyed,
		History:   map[string][]State{},
		Incidents: append([]Incident(nil), c.incidents...),
	}
	if c.checkedAt.IsZero() {
		s.Overall = StateUnknown
	} else {
		s.CheckedAt = c.checkedAt.UnixMilli()
	}
	for _, model := range c.models {
		ms := ModelStatus{
			Model:     model,
			State:     c.states[model],
			Anonymous: c.anon[model],
			Keyed:     c.keyedRes[model],
			CheckedAt: s.CheckedAt,
		}
		if !c.keyed {
			ms.Keyed = Probe{Error: "STATUS_API_KEY 未配置，跳过 API Key 探测"}
		}
		s.Models = append(s.Models, ms)
	}
	for model, states := range c.history {
		s.History[model] = append([]State(nil), states...)
	}
	return s
}

// lookup returns the previous state of a model from a snapshot. The state is
// StateUnknown when the model was not part of the previous cycle yet.
func (s Snapshot) lookup(model string) State {
	for _, m := range s.Models {
		if m.Model == model {
			return m.State
		}
	}
	return StateUnknown
}

// combine maps the two probe results into the green/blue/red state:
// green  = the anonymous call through the proxy succeeded,
// blue   = anonymous failed but the API-key call succeeded,
// red    = everything failed.
func combine(anon, keyed Probe, keyedEnabled bool) State {
	if anon.OK {
		return StateGreen
	}
	if keyedEnabled && keyed.OK {
		return StateBlue
	}
	return StateRed
}

func overallState(states map[string]State) State {
	if len(states) == 0 {
		return StateUnknown
	}
	red, blue := false, false
	for _, st := range states {
		switch st {
		case StateRed:
			red = true
		case StateBlue:
			blue = true
		}
	}
	if red {
		return StateRed
	}
	if blue {
		return StateBlue
	}
	return StateGreen
}

func incident(t time.Time, model string, from, to State, anon, keyed Probe) Incident {
	detail := "匿名调用失败"
	if anon.Status > 0 {
		detail = fmt.Sprintf("匿名调用失败 (HTTP %d)", anon.Status)
	}
	if keyed.Status > 0 {
		detail += fmt.Sprintf("，API Key 探测 (HTTP %d)", keyed.Status)
	}
	return Incident{Time: t.UnixMilli(), Model: model, From: from, To: to, Detail: detail}
}

func mergeModels(existing, fresh []string) []string {
	set := map[string]bool{}
	for _, m := range append([]string(nil), existing...) {
		set[m] = true
	}
	var added []string
	for _, m := range fresh {
		if !set[m] {
			set[m] = true
			added = append(added, m)
		}
	}
	out := append([]string(nil), existing...)
	out = append(out, added...)
	sort.Strings(out)
	return out
}

func slurp(r io.Reader, n int64) string {
	lr := &io.LimitedReader{R: r, N: n}
	b, _ := io.ReadAll(lr)
	return string(b)
}
