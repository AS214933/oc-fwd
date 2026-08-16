// Package proxy implements the opencode zen reverse proxy: OpenAI-compatible
// HTTP surface, socks5 + IPv6-aware upstream dialing, 429 retry/circuit
// breaker, and optional forced Chat Completions conversion.
package proxy

import (
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"zenproxy/internal/circuit"
	"zenproxy/internal/config"
)

var errCircuitOpen = errors.New("upstream rate limit circuit is open")

type Proxy struct {
	cfg      config.Config
	log      *slog.Logger
	client   *http.Client
	circuit  *circuit.Circuit
	sem      chan struct{}
	dns      *dnsCache
	keys     *keyRing
	fb       fallbackState
	reporter *reporter
}

func New(cfg config.Config, log *slog.Logger) (*Proxy, error) {
	dialTimeout := cfg.DialTimeout
	if dialTimeout <= 0 {
		dialTimeout = socks5DialDefault
	}
	tr := &http.Transport{
		MaxIdleConns:          2000,
		MaxIdleConnsPerHost:   512,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   dialTimeout,
		ExpectContinueTimeout: time.Second,
		ForceAttemptHTTP2:     true,
		// No total ResponseHeaderTimeout: prefill for very long prompts can
		// take minutes and streaming responses stay open for a long time.
	}
	// TLS session resumption is safe with IP rotation: tickets are tied to
	// the upstream server, not to the client's exit IP, so a fresh SOCKS5 +
	// TCP connection still skips the full TLS handshake (1 RTT instead of 2+).
	// This does NOT reuse the SOCKS5 connection itself.
	tr.TLSClientConfig = &tls.Config{
		ClientSessionCache: tls.NewLRUClientSessionCache(128),
	}
	p := &Proxy{
		cfg:     cfg,
		log:     log,
		circuit: circuit.New(cfg.CircuitFailures, cfg.CircuitCooldown),
		fb:      fallbackState{models: map[string]*modelFallback{}},
	}
	if cfg.IPv6Prefer || cfg.ForceIPv6 {
		p.dns = newDNSCache(cfg.DNSCacheTTL, nil)
	}
	if cfg.RotateIP {
		// Every request gets a fresh TCP connection through the socks5 proxy
		// so per-connection random exit IPs (e.g. rotating IPv6) actually
		// rotate. Connection pooling would pin all requests to one exit IP
		// and make upstream IP-based rate limits kick in again.
		tr.DisableKeepAlives = true
		// HTTP/2 multiplexes requests over one connection, which defeats
		// rotation; fall back to HTTP/1.1 when rotating.
		tr.ForceAttemptHTTP2 = false
		tr.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	}
	if cfg.Socks5 != "" {
		dialer, err := newSocks5Dialer(cfg.Socks5, dialTimeout)
		if err != nil {
			return nil, err
		}
		tr.DialContext = makeDialContext(cfg, log, dialer.DialContext, p.dns)
	} else {
		nd := &net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
		tr.DialContext = makeDialContext(cfg, log, nd.DialContext, p.dns)
	}
	client := &http.Client{Transport: tr} // per-request timeout applied in doUpstream
	var sem chan struct{}
	if cfg.MaxConcurrency > 0 {
		sem = make(chan struct{}, cfg.MaxConcurrency)
	}
	p.client = client
	p.sem = sem
	if len(cfg.APIKeys) > 0 {
		p.keys = newKeyRing(cfg.APIKeys)
		go p.probeLoop()
	}
	if cfg.StatusURL != "" {
		p.reporter = newReporter(cfg.StatusURL, cfg.StatusToken)
		p.reporter.start()
		p.log.Info("status reporting enabled", "url", cfg.StatusURL)
	}
	return p, nil
}

// Handler builds the full HTTP routing table.
func (p *Proxy) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat/completions", p.requireAuth(p.handleCompletion("chat")))
	mux.HandleFunc("POST /v1/responses", p.requireAuth(p.handleCompletion("responses")))
	mux.HandleFunc("POST /v1/messages", p.requireAuth(p.handleCompletion("messages")))
	mux.HandleFunc("GET /v1/models", p.requireAuth(p.handleModels))
	// Debug endpoints are consumed by ops tooling (the bundled Status UI).
	// Besides the caller key they also accept the status reporting token so
	// the UI can talk to a key-guarded proxy without juggling two secrets.
	mux.HandleFunc("GET /debug/upstream-ip", p.requireDebugAuth(p.handleDebugUpstreamIP))
	mux.HandleFunc("GET /debug/modes", p.requireDebugAuth(p.handleDebugModes))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "ok")
	})
	return p.logMiddleware(mux)
}

// requireAuth enforces the optional caller API key (ZEN_AUTH_KEY).
func (p *Proxy) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if p.cfg.AuthKey != "" && !validCallerKey(r, p.cfg.AuthKey) {
			writeError(w, http.StatusUnauthorized, "Invalid API key", "invalid_api_key")
			return
		}
		next(w, r)
	}
}

// requireDebugAuth guards the debug endpoints: a caller key (ZEN_AUTH_KEY)
// passes, and so does the status reporting token (ZEN_STATUS_TOKEN) sent as
// X-Status-Token when it is configured.
func (p *Proxy) requireDebugAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if p.cfg.StatusToken != "" {
			got := r.Header.Get("X-Status-Token")
			if subtle.ConstantTimeCompare([]byte(got), []byte(p.cfg.StatusToken)) == 1 {
				next(w, r)
				return
			}
		}
		p.requireAuth(next)(w, r)
	}
}

func validCallerKey(r *http.Request, want string) bool {
	got := ""
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		got = strings.TrimSpace(h[len("Bearer "):])
	} else if h := r.Header.Get("x-api-key"); h != "" {
		got = strings.TrimSpace(h)
	}
	if got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (p *Proxy) handleModels(w http.ResponseWriter, r *http.Request) {
	seen := map[string]bool{}
	ids := []string{}
	created := time.Now().Unix()
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, m := range p.cfg.Models {
		add(m)
	}
	for alias := range p.cfg.ModelMap {
		add(alias)
	}
	payload := map[string]any{
		"object": "list",
		"data":   []any{},
	}
	if len(ids) > 0 {
		items := make([]map[string]any, 0, len(ids))
		for _, id := range ids {
			items = append(items, map[string]any{
				"id":       id,
				"object":   "model",
				"created":  created,
				"owned_by": "zen-proxy",
			})
		}
		payload["data"] = items
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payload)
}

// handleDebugModes reports the current anonymous/keyed/keyed_failed state of
// every configured model. The Status UI polls this endpoint to reconcile its
// event timeline (e.g. after a restart or a missed webhook event).
func (p *Proxy) handleDebugModes(w http.ResponseWriter, r *http.Request) {
	states := map[string]string{}
	if p.keysEnabled() {
		p.fb.mu.RLock()
		for model, st := range p.fb.models {
			states[model] = st.state()
		}
		p.fb.mu.RUnlock()
	}
	for _, m := range p.cfg.Models {
		if _, ok := states[m]; !ok {
			states[m] = stateAnonymous
		}
	}
	for alias := range p.cfg.ModelMap {
		if _, ok := states[alias]; !ok {
			states[alias] = stateAnonymous
		}
	}
	models := make([]string, 0, len(states))
	for m := range states {
		models = append(models, m)
	}
	sort.Strings(models)
	out := make([]map[string]string, 0, len(models))
	for _, m := range models {
		out = append(out, map[string]string{"model": m, "state": states[m]})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"models": out})
}

func writeError(w http.ResponseWriter, status int, msg, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": msg,
			"type":    "invalid_request_error",
			"param":   nil,
			"code":    code,
		},
	})
}

// logMiddleware adds request logging and a request id.
func (p *Proxy) logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		reqID := r.Header.Get("X-Request-Id")
		if reqID == "" {
			reqID = newRequestID()
		}
		w.Header().Set("X-Request-Id", reqID)
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		p.log.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", sw.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"req_id", reqID,
		)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func newRequestID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
