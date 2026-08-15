package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// keyRing hands out API keys round-robin.
type keyRing struct {
	keys []string
	idx  atomic.Uint64
}

func newKeyRing(keys []string) *keyRing {
	return &keyRing{keys: keys}
}

func (k *keyRing) next() string {
	if k == nil || len(k.keys) == 0 {
		return ""
	}
	return k.keys[k.idx.Add(1)%uint64(len(k.keys))]
}

// fallbackState tracks whether upstream calls are sent anonymously (no key)
// or with an API key from the key file. Anonymous failures accumulate; once
// NoKeyFailThreshold consecutive requests fail, the proxy switches to keyed
// mode and probes every NoKeyProbeInterval to detect recovery.
type fallbackState struct {
	mu         sync.Mutex
	keyMode    bool
	noKeyFails int
}

// keysEnabled reports whether the no-key -> API-key fallback is active.
func (p *Proxy) keysEnabled() bool {
	return p.keys != nil
}

// inKeyMode reports whether keyed mode is currently active.
func (p *Proxy) inKeyMode() bool {
	if !p.keysEnabled() {
		return false
	}
	p.fb.mu.Lock()
	defer p.fb.mu.Unlock()
	return p.fb.keyMode
}

// requestKey returns the API key to attach to the upstream call, if any.
// With the key file configured the key is used only while in keyed mode;
// otherwise the legacy single ZEN_UPSTREAM_API_KEY is used when set.
func (p *Proxy) requestKey() (string, bool) {
	if !p.keysEnabled() {
		if p.cfg.UpstreamAPIKey != "" {
			return p.cfg.UpstreamAPIKey, true
		}
		return "", false
	}
	if p.inKeyMode() {
		return p.keys.next(), true
	}
	return "", false
}

// recordNoKeyFailure counts one failed anonymous request. It returns true and
// switches to keyed mode once the threshold is reached.
func (p *Proxy) recordNoKeyFailure() (switched bool) {
	if !p.keysEnabled() {
		return false
	}
	p.fb.mu.Lock()
	defer p.fb.mu.Unlock()
	if p.fb.keyMode {
		return false
	}
	p.fb.noKeyFails++
	if p.fb.noKeyFails >= p.cfg.NoKeyFailThreshold {
		p.log.Info("no-key upstream failing repeatedly, switching to API-key mode",
			"failures", p.fb.noKeyFails)
		p.fb.keyMode = true
		p.fb.noKeyFails = 0
		return true
	}
	return false
}

// recordNoKeySuccess resets the anonymous failure counter.
func (p *Proxy) recordNoKeySuccess() {
	if !p.keysEnabled() {
		return
	}
	p.fb.mu.Lock()
	defer p.fb.mu.Unlock()
	if !p.fb.keyMode {
		p.fb.noKeyFails = 0
	}
}

// trySwitchToNoKey flips back to anonymous mode; used by the recovery probe.
func (p *Proxy) trySwitchToNoKey() bool {
	if !p.keysEnabled() {
		return false
	}
	p.fb.mu.Lock()
	defer p.fb.mu.Unlock()
	if !p.fb.keyMode {
		return false
	}
	p.log.Info("no-key upstream recovered, switching back to anonymous mode")
	p.fb.keyMode = false
	p.fb.noKeyFails = 0
	p.circuit.Reset()
	return true
}

// probeLoop periodically sends a no-key probe (through the same transport,
// so via the socks5 proxy when configured) while keyed mode is active and
// switches back to anonymous mode as soon as the upstream accepts it.
func (p *Proxy) probeLoop() {
	t := time.NewTicker(p.cfg.NoKeyProbeInterval)
	defer t.Stop()
	for range t.C {
		if !p.inKeyMode() {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), p.cfg.NoKeyProbeInterval)
		ok := p.probeAnonymous(ctx)
		cancel()
		if ok {
			p.trySwitchToNoKey()
		}
	}
}

// probeAnonymous sends a tiny chat completion without any API key and reports
// whether the upstream accepted it.
func (p *Proxy) probeAnonymous(ctx context.Context) bool {
	model := "deepseek-v4-flash-free"
	if len(p.cfg.Models) > 0 {
		model = p.cfg.Models[0]
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
		p.log.Debug("no-key probe failed", "error", err)
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
