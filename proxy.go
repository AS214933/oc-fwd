package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	mrand "math/rand"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/proxy"
)

var errCircuitOpen = errors.New("upstream rate limit circuit is open")

type Proxy struct {
	cfg     Config
	log     *slog.Logger
	client  *http.Client
	circuit *Circuit
	sem     chan struct{}
	rnd     *mrand.Rand
	rndMu   sync.Mutex
}

func newProxy(cfg Config, log *slog.Logger) (*Proxy, error) {
	tr := &http.Transport{
		MaxIdleConns:          2000,
		MaxIdleConnsPerHost:   512,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
		ForceAttemptHTTP2:     true,
		// No total ResponseHeaderTimeout: prefill for very long prompts can
		// take minutes and streaming responses stay open for a long time.
	}
	if cfg.Socks5 != "" {
		dialer, err := newSocks5Dialer(cfg.Socks5)
		if err != nil {
			return nil, err
		}
		tr.DialContext = makeDialContext(cfg, log, func(ctx context.Context, network, address string) (net.Conn, error) {
			return dialer.Dial(network, address)
		})
	} else {
		nd := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
		tr.DialContext = makeDialContext(cfg, log, nd.DialContext)
	}
	client := &http.Client{Transport: tr} // per-request timeout applied in doUpstream
	var sem chan struct{}
	if cfg.MaxConcurrency > 0 {
		sem = make(chan struct{}, cfg.MaxConcurrency)
	}
	return &Proxy{
		cfg:     cfg,
		log:     log,
		client:  client,
		circuit: newCircuit(cfg.CircuitFailures, cfg.CircuitCooldown),
		sem:     sem,
		rnd:     mrand.New(mrand.NewSource(time.Now().UnixNano())),
	}, nil
}

// makeDialContext wraps a base dialer with optional IPv6-first preference:
// the hostname is resolved locally, IPv6 addresses are tried before IPv4,
// falling back to the other family on failure. When disabled the base dialer
// is used as-is (hostname passthrough for socks5h).
func makeDialContext(cfg Config, log *slog.Logger, base func(ctx context.Context, network, address string) (net.Conn, error)) func(ctx context.Context, network, address string) (net.Conn, error) {
	if !cfg.IPv6Prefer && !cfg.ForceIPv6 {
		return base
	}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return base(ctx, network, address)
		}
		if net.ParseIP(host) != nil {
			// explicit IP literal: force mode rejects v4 targets
			if cfg.ForceIPv6 && net.ParseIP(host).To4() != nil {
				return nil, fmt.Errorf("ipv6 forced but target %s is ipv4", host)
			}
			return base(ctx, network, address)
		}
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil || len(ips) == 0 {
			log.Debug("dns lookup failed, using hostname as-is", "host", host, "error", err)
			if cfg.ForceIPv6 {
				return nil, fmt.Errorf("ipv6 forced but dns failed for %s: %w", host, err)
			}
			return base(ctx, network, address)
		}
		for _, ip := range orderIPs(ips, true) {
			if cfg.ForceIPv6 && ip.To4() != nil {
				continue // v6 only
			}
			addr := net.JoinHostPort(ip.String(), port)
			conn, err := base(ctx, network, addr)
			if err == nil {
				log.Debug("dialed upstream", "host", host, "ip", ip.String(), "via", addr, "family", ipFamily(ip))
				return conn, nil
			}
			if cfg.ForceIPv6 {
				log.Warn("ipv6 dial failed (no ipv4 fallback in force mode)", "host", host, "ip", ip.String(), "error", err)
				return nil, fmt.Errorf("ipv6 dial failed for %s (%s): %w", host, ip.String(), err)
			}
		}
		if cfg.ForceIPv6 {
			return nil, fmt.Errorf("ipv6 forced but no ipv6 address found for %s", host)
		}
		return nil, fmt.Errorf("no usable address for %s", host)
	}
}

// orderIPs sorts addresses so the preferred family comes first.
func orderIPs(ips []net.IP, prefer6 bool) []net.IP {
	var v6, v4 []net.IP
	for _, ip := range ips {
		if ip.To4() == nil {
			v6 = append(v6, ip)
		} else {
			v4 = append(v4, ip)
		}
	}
	if prefer6 {
		return append(v6, v4...)
	}
	return append(v4, v6...)
}

func newSocks5Dialer(s string) (proxy.Dialer, error) {
	u, err := url.Parse(s)
	if err != nil {
		return nil, fmt.Errorf("invalid ZEN_SOCKS5: %w", err)
	}
	if u.Scheme != "socks5" && u.Scheme != "socks5h" {
		return nil, fmt.Errorf("invalid ZEN_SOCKS5 scheme %q (want socks5://)", u.Scheme)
	}
	var auth *proxy.Auth
	if u.User != nil {
		auth = &proxy.Auth{User: u.User.Username()}
		auth.Password, _ = u.User.Password()
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "1080")
	}
	return proxy.SOCKS5("tcp", host, auth, proxy.Direct)
}

// Handler builds the full HTTP routing table.
func (p *Proxy) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat/completions", p.requireAuth(p.handleCompletion("chat")))
	mux.HandleFunc("POST /v1/responses", p.requireAuth(p.handleCompletion("responses")))
	mux.HandleFunc("POST /v1/messages", p.requireAuth(p.handleCompletion("messages")))
	mux.HandleFunc("GET /v1/models", p.requireAuth(p.handleModels))
	mux.HandleFunc("GET /debug/upstream-ip", p.requireAuth(p.handleDebugUpstreamIP))
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

type completionMeta struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
}

func (p *Proxy) handleCompletion(format string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, p.cfg.MaxBodyBytes))
		if err != nil {
			writeError(w, http.StatusBadRequest, "request body too large or unreadable", "invalid_request_error")
			return
		}
		var meta completionMeta
		if err := json.Unmarshal(body, &meta); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error")
			return
		}

		upstreamPath := map[string]string{
			"chat":      "/chat/completions",
			"responses": "/responses",
			"messages":  "/messages",
		}[format]

		force := p.cfg.ForceChatCompletions
		rewrite := false
		if force {
			// Normalize everything to Chat Completions before forwarding.
			if format != "chat" {
				body, err = convertToChatCompletions(format, body)
				if err != nil {
					writeError(w, http.StatusBadRequest, "cannot convert request to chat completions: "+err.Error(), "invalid_request_error")
					return
				}
				upstreamPath = "/chat/completions"
			}
			// chat/completions with force=true is a raw passthrough.
		} else {
			upstreamModel, ok := p.resolveModel(meta.Model)
			if !ok {
				writeError(w, http.StatusBadRequest,
					fmt.Sprintf("model %q is not allowed by this proxy", meta.Model), "model_not_found")
				return
			}
			rewrite = upstreamModel != meta.Model
			if rewrite {
				body = rewriteBodyModel(body, upstreamModel)
			}
		}

		if p.sem != nil {
			select {
			case p.sem <- struct{}{}:
				defer func() { <-p.sem }()
			case <-r.Context().Done():
				return
			}
		}

		resp, err := p.doUpstream(r.Context(), upstreamPath, body, meta.Stream)
		if err != nil {
			status := http.StatusBadGateway
			msg := "upstream request failed: " + err.Error()
			if errors.Is(err, errCircuitOpen) {
				status = http.StatusTooManyRequests
				msg = "upstream temporarily rate limited (circuit open)"
			}
			writeError(w, status, msg, "upstream_error")
			return
		}
		defer resp.Body.Close()

		if ct := resp.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.Header().Set("X-Zen-Proxy", "1")

		if resp.StatusCode != http.StatusOK {
			w.WriteHeader(resp.StatusCode)
			io.Copy(w, resp.Body)
			return
		}

		if meta.Stream || isSSE(resp) {
			alias := ""
			if rewrite {
				alias = meta.Model
			}
			w.WriteHeader(http.StatusOK)
			p.copyStream(w, r.Context(), resp.Body, alias)
			return
		}

		data, err := io.ReadAll(resp.Body)
		if err != nil {
			p.log.Error("read upstream body", "error", err)
			return
		}
		if rewrite {
			data = rewriteResponseModel(data, meta.Model)
		}
		w.WriteHeader(http.StatusOK)
		w.Write(data)
	}
}

// resolveModel maps an incoming model id to an upstream model id.
// With no ZEN_MODELS / ZEN_MODEL_MAP configured everything passes through.
func (p *Proxy) resolveModel(clientModel string) (string, bool) {
	if clientModel == "" {
		return "", false
	}
	if up, ok := p.cfg.ModelMap[clientModel]; ok {
		return up, true
	}
	if len(p.cfg.Models) > 0 {
		for _, m := range p.cfg.Models {
			if m == clientModel {
				return clientModel, true
			}
		}
		return "", false
	}
	return clientModel, true // allow any model when no restriction configured
}

type chatBody struct {
	Model       string     `json:"model"`
	Messages    []chatMsg  `json:"messages"`
	MaxTokens   *int       `json:"max_tokens,omitempty"`
	Temperature *float64   `json:"temperature,omitempty"`
	Stream      bool       `json:"stream"`
	Tools       []chatTool `json:"tools,omitempty"`
}

type chatMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatTool struct {
	Type     string       `json:"type"`
	Function chatToolFunc `json:"function"`
}

type chatToolFunc struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

// convertToChatCompletions normalizes an incoming /v1/responses or /v1/messages
// body into OpenAI Chat Completions format.
func convertToChatCompletions(format string, body []byte) ([]byte, error) {
	switch format {
	case "responses":
		return convertResponsesToChat(body)
	case "messages":
		return convertMessagesToChat(body)
	}
	return body, nil
}

func convertResponsesToChat(body []byte) ([]byte, error) {
	var in struct {
		Model           string            `json:"model"`
		Instructions    string            `json:"instructions"`
		Input           json.RawMessage   `json:"input"`
		MaxOutputTokens *int              `json:"max_output_tokens"`
		Temperature     *float64          `json:"temperature"`
		Stream          bool              `json:"stream"`
		Tools           []json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, err
	}
	out := chatBody{Model: in.Model, Stream: in.Stream, Temperature: in.Temperature}
	if in.MaxOutputTokens != nil {
		out.MaxTokens = in.MaxOutputTokens
	}
	if in.Instructions != "" {
		out.Messages = append(out.Messages, chatMsg{Role: "system", Content: in.Instructions})
	}
	input := bytes.TrimSpace(in.Input)
	if len(input) == 0 {
		return nil, fmt.Errorf("responses input is empty")
	}
	if input[0] == '"' {
		var text string
		if err := json.Unmarshal(input, &text); err != nil {
			return nil, err
		}
		out.Messages = append(out.Messages, chatMsg{Role: "user", Content: text})
	} else {
		var items []json.RawMessage
		if err := json.Unmarshal(input, &items); err != nil {
			return nil, fmt.Errorf("unsupported responses input: %w", err)
		}
		for _, raw := range items {
			var it struct {
				Type    string          `json:"type"`
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
				Text    string          `json:"text"`
			}
			if err := json.Unmarshal(raw, &it); err != nil {
				// OpenAI responses input arrays may contain plain strings.
				var s string
				if serr := json.Unmarshal(raw, &s); serr == nil {
					out.Messages = append(out.Messages, chatMsg{Role: "user", Content: s})
					continue
				}
				return nil, fmt.Errorf("unsupported responses input item: %w", err)
			}
			if it.Type == "function_call" || it.Type == "function_call_output" {
				continue
			}
			if it.Text != "" {
				out.Messages = append(out.Messages, chatMsg{Role: "user", Content: it.Text})
				continue
			}
			role := it.Role
			if role == "" {
				role = "user"
			}
			content := responsesContentToString(it.Content)
			if it.Type == "message" || it.Content != nil || content != "" {
				out.Messages = append(out.Messages, chatMsg{Role: role, Content: content})
			}
		}
	}
	if len(out.Messages) == 0 {
		return nil, fmt.Errorf("responses input produced no messages")
	}
	for _, tool := range in.Tools {
		var t struct {
			Type        string          `json:"type"`
			Name        string          `json:"name"`
			Description string          `json:"description"`
			Parameters  json.RawMessage `json:"parameters"`
		}
		if err := json.Unmarshal(tool, &t); err != nil {
			continue
		}
		if t.Type != "function" && t.Name == "" {
			continue
		}
		out.Tools = append(out.Tools, chatTool{
			Type:     "function",
			Function: chatToolFunc{Name: t.Name, Description: t.Description, Parameters: t.Parameters},
		})
	}
	return json.Marshal(out)
}

func responsesContentToString(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return ""
	}
	if raw[0] == '"' {
		var s string
		_ = json.Unmarshal(raw, &s)
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		if p.Text != "" {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

func convertMessagesToChat(body []byte) ([]byte, error) {
	var in struct {
		Model    string          `json:"model"`
		System   json.RawMessage `json:"system"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
		MaxTokens   int      `json:"max_tokens"`
		Temperature *float64 `json:"temperature"`
		Stream      bool     `json:"stream"`
		Tools       []struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			InputSchema json.RawMessage `json:"input_schema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, err
	}
	out := chatBody{Model: in.Model, Stream: in.Stream, Temperature: in.Temperature}
	if in.MaxTokens > 0 {
		out.MaxTokens = &in.MaxTokens
	}
	if sys := anthropicContentToString(in.System); sys != "" {
		out.Messages = append(out.Messages, chatMsg{Role: "system", Content: sys})
	}
	for _, m := range in.Messages {
		role := m.Role
		if role == "" {
			role = "user"
		}
		out.Messages = append(out.Messages, chatMsg{Role: role, Content: anthropicContentToString(m.Content)})
	}
	if len(out.Messages) == 0 {
		return nil, fmt.Errorf("messages body produced no messages")
	}
	for _, t := range in.Tools {
		out.Tools = append(out.Tools, chatTool{
			Type:     "function",
			Function: chatToolFunc{Name: t.Name, Description: t.Description, Parameters: t.InputSchema},
		})
	}
	return json.Marshal(out)
}

func anthropicContentToString(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return ""
	}
	if raw[0] == '"' {
		var s string
		_ = json.Unmarshal(raw, &s)
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		if p.Type == "text" && p.Text != "" {
			b.WriteString(p.Text)
		}
	}
	return b.String()
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

// doUpstream sends the request to opencode zen, retrying on 429 with
// exponential backoff (+ jitter), honoring Retry-After, and opening the
// circuit breaker after consecutive 429s so the upstream is shielded.
// handleDebugUpstreamIP reports which IP family/address the proxy would use
// to reach the upstream (through the same socks5 + ipv6-prefer dial path).
func (p *Proxy) handleDebugUpstreamIP(w http.ResponseWriter, r *http.Request) {
	ip, family, err := p.probeUpstreamIP(r.Context())
	payload := map[string]any{
		"upstream":    p.cfg.UpstreamBase,
		"socks5":      p.cfg.Socks5 != "",
		"ipv6_prefer": p.cfg.IPv6Prefer,
		"ipv6_force":  p.cfg.ForceIPv6,
	}
	if err != nil {
		payload["error"] = err.Error()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(payload)
		return
	}
	payload["ip"] = ip.String()
	payload["family"] = family
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payload)
}

func (p *Proxy) probeUpstreamIP(ctx context.Context) (net.IP, string, error) {
	u, err := url.Parse(p.cfg.UpstreamBase)
	if err != nil || u.Hostname() == "" {
		return nil, "", fmt.Errorf("invalid upstream: %s", p.cfg.UpstreamBase)
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "443"
	}

	var base func(ctx context.Context, network, address string) (net.Conn, error)
	if p.cfg.Socks5 != "" {
		d, err := newSocks5Dialer(p.cfg.Socks5)
		if err != nil {
			return nil, "", err
		}
		base = func(ctx context.Context, network, address string) (net.Conn, error) {
			return d.Dial(network, address)
		}
	} else {
		nd := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
		base = nd.DialContext
	}

	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil, "", err
	}
	var lastErr error
	for _, ip := range orderIPs(ips, true) {
		if p.cfg.ForceIPv6 && ip.To4() != nil {
			continue
		}
		conn, err := base(ctx, "tcp", net.JoinHostPort(ip.String(), port))
		if err == nil {
			conn.Close()
			return ip, ipFamily(ip), nil
		}
		lastErr = err
		if p.cfg.ForceIPv6 {
			break
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no usable %s address for %s", func() string {
			if p.cfg.ForceIPv6 {
				return "ipv6"
			}
			return "ip"
		}(), host)
	}
	return nil, "", lastErr
}

func ipFamily(ip net.IP) string {
	if ip == nil {
		return "unknown"
	}
	if ip.To4() != nil {
		return "ipv4"
	}
	return "ipv6"
}

func (p *Proxy) doUpstream(ctx context.Context, path string, body []byte, stream bool) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		if !p.circuit.Allow() {
			return nil, errCircuitOpen
		}

		reqCtx := ctx
		var cancel context.CancelFunc = func() {}
		if !stream && p.cfg.UpstreamTimeoutSet {
			reqCtx, cancel = context.WithTimeout(ctx, p.cfg.UpstreamTimeout)
		}

		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, p.cfg.UpstreamBase+path, bytes.NewReader(body))
		if err != nil {
			cancel()
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "zen-proxy/1.0")
		if p.cfg.UpstreamAPIKey != "" {
			req.Header.Set("Authorization", "Bearer "+p.cfg.UpstreamAPIKey)
		}
		if stream {
			req.Header.Set("Accept", "text/event-stream")
		}

		resp, err := p.client.Do(req)
		if err != nil {
			cancel()
			p.log.Debug("upstream attempt failed", "attempt", attempt, "error", err)
			wait, ok := p.backoff(attempt, 0)
			if !ok {
				return nil, err
			}
			if err := sleepCtx(ctx, wait); err != nil {
				return nil, err
			}
			continue
		}

		if resp.StatusCode == http.StatusTooManyRequests {
			ra := retryAfterSeconds(resp)
			p.circuit.RecordFailure()
			resp.Body.Close()
			cancel()
			wait, ok := p.backoff(attempt, ra)
			p.log.Warn("upstream returned 429", "attempt", attempt, "retry_after_s", ra, "wait", wait)
			if !ok {
				return newRateLimitResponse(ra), nil
			}
			if err := sleepCtx(ctx, wait); err != nil {
				return nil, err
			}
			continue
		}

		p.circuit.RecordSuccess()
		resp.Body = &cancelOnCloseBody{ReadCloser: resp.Body, cancel: cancel}
		return resp, nil
	}
}

func (p *Proxy) backoff(attempt int, retryAfter int) (time.Duration, bool) {
	if attempt >= p.cfg.RetryMax {
		return 0, false
	}
	if retryAfter > 0 {
		d := time.Duration(retryAfter) * time.Second
		if d > p.cfg.RetryMaxBackoff {
			d = p.cfg.RetryMaxBackoff
		}
		return d, true
	}
	base := p.cfg.RetryBaseBackoff
	mult := 1 << uint(math.Min(float64(attempt), 20))
	d := base * time.Duration(mult)
	p.rndMu.Lock()
	jitter := time.Duration(p.rnd.Int63n(int64(p.cfg.RetryBaseBackoff/2) + 1))
	p.rndMu.Unlock()
	d += jitter
	if d > p.cfg.RetryMaxBackoff {
		d = p.cfg.RetryMaxBackoff
	}
	return d, true
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func retryAfterSeconds(resp *http.Response) int {
	if v := resp.Header.Get("Retry-After"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return 0
}

func newRateLimitResponse(retryAfter int) *http.Response {
	msg := "Upstream rate limit exceeded after retries."
	if retryAfter > 0 {
		msg += fmt.Sprintf(" Retry-After: %ds.", retryAfter)
	}
	b, _ := json.Marshal(map[string]any{
		"error": map[string]any{
			"message": msg,
			"type":    "rate_limit_error",
			"param":   nil,
			"code":    "rate_limit_exceeded",
		},
	})
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	return &http.Response{
		StatusCode:    http.StatusTooManyRequests,
		Header:        h,
		Body:          io.NopCloser(bytes.NewReader(b)),
		ContentLength: int64(len(b)),
		Request:       nil,
	}
}

type cancelOnCloseBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelOnCloseBody) Close() error {
	err := b.ReadCloser.Close()
	b.cancel()
	return err
}

func isSSE(resp *http.Response) bool {
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(ct, "text/event-stream")
}

// copyStream relays an SSE stream, optionally rewriting the model field of
// each JSON data chunk back to the alias the caller used.
func (p *Proxy) copyStream(w http.ResponseWriter, ctx context.Context, src io.Reader, alias string) {
	flusher, _ := w.(http.Flusher)
	br := bufio.NewReaderSize(src, 64*1024)
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			out := line
			if alias != "" {
				if trimmed := bytes.TrimSpace(line); bytes.HasPrefix(trimmed, []byte("data:")) {
					payload := bytes.TrimSpace(trimmed[len("data:"):])
					if len(payload) > 0 && payload[0] == '{' {
						rewritten := rewriteResponseModel(payload, alias)
						out = append(append([]byte("data: "), rewritten...), '\n')
					}
				}
			}
			if _, werr := w.Write(out); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			if err == io.EOF {
				return
			}
			p.log.Debug("stream read error", "error", err)
			return
		}
	}
}

// rewriteBodyModel replaces the "model" field of a JSON request body.
func rewriteBodyModel(body []byte, model string) []byte {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body
	}
	b, err := json.Marshal(model)
	if err != nil {
		return body
	}
	m["model"] = b
	out, err := json.Marshal(m)
	if err != nil {
		return body
	}
	return out
}

// rewriteResponseModel replaces the "model" field of a JSON response body.
func rewriteResponseModel(data []byte, model string) []byte {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return data
	}
	b, err := json.Marshal(model)
	if err != nil {
		return data
	}
	m["model"] = b
	out, err := json.Marshal(m)
	if err != nil {
		return data
	}
	return out
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
