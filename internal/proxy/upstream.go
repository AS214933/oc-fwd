package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"time"
)

func (p *Proxy) doUpstream(ctx context.Context, path string, body []byte, stream bool) (*http.Response, error) {
	model := modelFromBody(body)
	for attempt := 0; ; attempt++ {
		if !p.circuit.Allow() {
			// An open breaker can strand anonymous mode (the requests never
			// reach the give-up points below). Count it as a no-key failure
			// so a persistent 429 storm still trips the API-key fallback.
			if p.recordNoKeyFailure(model) {
				p.circuit.Reset()
				attempt = -1
				continue
			}
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
		if key, ok := p.requestKey(model); ok {
			req.Header.Set("Authorization", "Bearer "+key)
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
				if p.recordNoKeyFailure(model) {
					// Anonymous mode is down and the threshold was reached:
					// retry this very request with an API key, transparently.
					attempt = -1
					continue
				}
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
				if p.recordNoKeyFailure(model) {
					p.circuit.Reset()
					attempt = -1
					continue
				}
				return newRateLimitResponse(ra), nil
			}
			if err := sleepCtx(ctx, wait); err != nil {
				return nil, err
			}
			continue
		}

		if resp.StatusCode >= 500 {
			p.log.Warn("upstream returned server error", "status", resp.StatusCode)
			if p.recordNoKeyFailure(model) {
				resp.Body.Close()
				cancel()
				p.circuit.Reset()
				attempt = -1
				continue
			}
		}

		p.circuit.RecordSuccess()
		p.recordNoKeySuccess(model)
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

// modelFromBody extracts the upstream model id from a request body so the
// per-model fallback can key its state on exactly what the upstream sees
// (already alias-resolved / rewritten where applicable).
func modelFromBody(body []byte) string {
	var m struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &m); err != nil {
		return ""
	}
	return m.Model
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
