package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	mrand "math/rand/v2"
	"net/http"
	"strconv"
	"time"
)

func (p *Proxy) doUpstream(ctx context.Context, path string, body []byte, stream bool) (*http.Response, error) {
	model := modelFromBody(body)
	for attempt := 0; ; attempt++ {
		// hasKey reports whether this attempt cycle is already issued with an
		// API key. It is tracked per request so that a transparent keyed
		// retry happens at most once per mode switch: after a keyed attempt
		// fails, the error is surfaced instead of looping forever.
		key, hasKey := p.requestKey(model)
		if !p.circuit.Allow() {
			if hasKey {
				// A keyed attempt hit the open breaker: shielding applies.
				p.reportKeyedResult(model, false, "circuit open")
				return nil, errCircuitOpen
			}
			// An open breaker can strand anonymous mode (the requests never
			// reach the give-up points below). Count it as a no-key failure
			// so a persistent 429 storm still trips the API-key fallback.
			if p.recordNoKeyFailure(model) || p.inKeyMode(model) {
				// Either this call tripped the threshold, or a concurrent
				// request switched the model while we were retrying
				// anonymously: restart this very request with a key.
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
		if hasKey {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		if stream {
			req.Header.Set("Accept", "text/event-stream")
		}

		// retryKeyed restarts the attempt loop with an API key whenever the
		// model is in keyed mode and this request has not tried a key yet:
		// - recordNoKeyFailure / forceSwitchToKey returned true -> this request
		//   just switched the model (429 threshold / 5xx retry-exhaustion)
		// - inKeyMode -> a concurrent request switched the model while this
		//   request was still retrying anonymously; without this, all the
		//   in-flight requests that lost the race leak 429/5xx to clients.
		retryKeyed := func() bool {
			if hasKey {
				return false
			}
			if force := p.forceSwitchToKey(model); force || p.inKeyMode(model) {
				p.circuit.Reset()
				return true
			}
			return false
		}

		resp, err := p.client.Do(req)
		if err != nil {
			cancel()
			p.log.Debug("upstream attempt failed", "attempt", attempt, "error", err)
			wait, ok := p.backoff(attempt, 0)
			if !ok {
				if !hasKey && (p.recordNoKeyFailure(model) || p.inKeyMode(model)) {
					// Anonymous mode is down and the threshold was reached
					// (here or by a concurrent request): retry with a key.
					// A keyed attempt that still fails is surfaced, never
					// restarted, so the loop always terminates.
					attempt = -1
					continue
				}
				p.reportKeyedResult(model, false, "network error: "+err.Error())
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
				if !hasKey && (p.recordNoKeyFailure(model) || p.inKeyMode(model)) {
					p.circuit.Reset()
					attempt = -1
					continue
				}
				p.reportKeyedResult(model, false, fmt.Sprintf("429 after retries (retry-after %ds)", ra))
				return newRateLimitResponse(ra), nil
			}
			if err := sleepCtx(ctx, wait); err != nil {
				return nil, err
			}
			continue
		}

		if resp.StatusCode != http.StatusOK {
			// Every non-200 status (400/401/404/5xx/...) follows the same
			// fallback flow as 5xx: backoff retries first, and once retries
			// are exhausted the model switches to API-key mode and the very
			// same request is transparently retried with a key, so the client
			// never sees the error. Only when the keyed retry also fails does
			// the response reach the client.
			p.log.Warn("upstream returned non-200", "status", resp.StatusCode)
			wait, ok := p.backoff(attempt, retryAfterSeconds(resp))
			if ok {
				resp.Body.Close()
				cancel()
				if err := sleepCtx(ctx, wait); err != nil {
					return nil, err
				}
				continue
			}
			if retryKeyed() {
				resp.Body.Close()
				cancel()
				attempt = -1
				continue
			}
			p.reportKeyedResult(model, false, fmt.Sprintf("HTTP %d after retries", resp.StatusCode))
		} else {
			p.circuit.RecordSuccess()
			p.recordNoKeySuccess(model)
			p.reportKeyedResult(model, true, "")
		}
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
	jitter := time.Duration(mrand.Int64N(int64(p.cfg.RetryBaseBackoff/2) + 1))
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
