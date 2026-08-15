package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	mrand "math/rand"
	"net/http"
	"sync"
	"time"
)

// keyRing hands out API keys uniformly at random so concurrent keyed requests
// spread across the whole pool instead of following a fixed rotation order.
type keyRing struct {
	keys []string
	mu   sync.Mutex
	rnd  *mrand.Rand
}

func newKeyRing(keys []string) *keyRing {
	return &keyRing{keys: keys, rnd: mrand.New(mrand.NewSource(time.Now().UnixNano()))}
}

func (k *keyRing) pick() string {
	if k == nil || len(k.keys) == 0 {
		return ""
	}
	k.mu.Lock()
	n := k.rnd.Intn(len(k.keys))
	k.mu.Unlock()
	return k.keys[n]
}

// modelFallback tracks the no-key -> API-key state for one upstream model.
type modelFallback struct {
	keyMode    bool
	noKeyFails int
}

// fallbackState holds fallback state per upstream model: a 429 storm on one
// model (say model A) only switches that model to API-key mode, while other
// models keep going anonymously.
type fallbackState struct {
	mu     sync.Mutex
	models map[string]*modelFallback
}

// keysEnabled reports whether the no-key -> API-key fallback is active.
func (p *Proxy) keysEnabled() bool {
	return p.keys != nil
}

// inKeyMode reports whether the given upstream model is currently in keyed mode.
func (p *Proxy) inKeyMode(model string) bool {
	if !p.keysEnabled() {
		return false
	}
	p.fb.mu.Lock()
	defer p.fb.mu.Unlock()
	st := p.fb.models[model]
	return st != nil && st.keyMode
}

// keyedModels lists the upstream models currently in keyed mode.
func (p *Proxy) keyedModels() []string {
	if !p.keysEnabled() {
		return nil
	}
	p.fb.mu.Lock()
	defer p.fb.mu.Unlock()
	var out []string
	for model, st := range p.fb.models {
		if st.keyMode {
			out = append(out, model)
		}
	}
	return out
}

// requestKey returns the API key to attach to the upstream call, if any.
// With the key file configured a key is used only when the model is in keyed
// mode, and one key is picked at random from the pool each time; otherwise the
// legacy single ZEN_UPSTREAM_API_KEY is used when set.
func (p *Proxy) requestKey(model string) (string, bool) {
	if !p.keysEnabled() {
		if p.cfg.UpstreamAPIKey != "" {
			return p.cfg.UpstreamAPIKey, true
		}
		return "", false
	}
	if p.inKeyMode(model) {
		return p.keys.pick(), true
	}
	return "", false
}

// recordNoKeyFailure counts one failed anonymous request for the model. It
// returns true and switches that model to keyed mode once the threshold is
// reached.
func (p *Proxy) recordNoKeyFailure(model string) (switched bool) {
	if !p.keysEnabled() {
		return false
	}
	p.fb.mu.Lock()
	defer p.fb.mu.Unlock()
	st := p.fb.models[model]
	if st == nil {
		st = &modelFallback{}
		p.fb.models[model] = st
	} else if st.keyMode {
		return false
	}
	st.noKeyFails++
	if st.noKeyFails >= p.cfg.NoKeyFailThreshold {
		p.log.Info("no-key upstream failing repeatedly, switching model to API-key mode",
			"model", model, "failures", st.noKeyFails)
		st.keyMode = true
		st.noKeyFails = 0
		return true
	}
	return false
}

// recordNoKeySuccess resets the anonymous failure counter for the model.
func (p *Proxy) recordNoKeySuccess(model string) {
	if !p.keysEnabled() {
		return
	}
	p.fb.mu.Lock()
	defer p.fb.mu.Unlock()
	st := p.fb.models[model]
	if st == nil || st.keyMode {
		return
	}
	st.noKeyFails = 0
}

// trySwitchToNoKey flips the model back to anonymous mode; used by the
// recovery probe.
func (p *Proxy) trySwitchToNoKey(model string) bool {
	if !p.keysEnabled() {
		return false
	}
	p.fb.mu.Lock()
	defer p.fb.mu.Unlock()
	st := p.fb.models[model]
	if st == nil || !st.keyMode {
		return false
	}
	p.log.Info("no-key upstream recovered, switching model back to anonymous mode", "model", model)
	st.keyMode = false
	st.noKeyFails = 0
	p.circuit.Reset()
	return true
}

// probeLoop periodically probes every keyed model anonymously (through the
// same transport, so via the socks5 proxy when configured) and switches each
// model back to anonymous mode as soon as the upstream accepts it.
func (p *Proxy) probeLoop() {
	t := time.NewTicker(p.cfg.NoKeyProbeInterval)
	defer t.Stop()
	for range t.C {
		for _, model := range p.keyedModels() {
			ctx, cancel := context.WithTimeout(context.Background(), p.cfg.NoKeyProbeInterval)
			ok := p.probeAnonymous(ctx, model)
			cancel()
			if ok {
				p.trySwitchToNoKey(model)
			}
		}
	}
}

// probeAnonymous sends a tiny chat completion for the given model without any
// API key and reports whether the upstream accepted it.
func (p *Proxy) probeAnonymous(ctx context.Context, model string) bool {
	if model == "" {
		if len(p.cfg.Models) > 0 {
			model = p.cfg.Models[0]
		} else {
			model = "deepseek-v4-flash-free"
		}
	}
	body, _ := json.Marshal(map[string]any{
		"model":      model,
		"messages":   []map[string]string{{"role": "user", "content": "ping"}},
		"max_tokens": 1,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.cfg.UpstreamBase+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "zen-proxy/1.0")
	resp, err := p.client.Do(req)
	if err != nil {
		p.log.Debug("no-key probe failed", "model", model, "error", err)
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
