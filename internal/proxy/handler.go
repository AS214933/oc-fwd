package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

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

		toResponses := force && format == "responses"

		if meta.Stream || isSSE(resp) {
			if toResponses && !isSSE(resp) {
				// Upstream ignored stream=true and returned a single JSON
				// chat.completion: convert and emit it as a minimal SSE
				// sequence so /v1/responses clients still get valid events.
				data, rerr := io.ReadAll(resp.Body)
				if rerr != nil {
					p.log.Error("read upstream body", "error", rerr)
					return
				}
				conv, cerr := convertChatToResponses(data)
				if cerr != nil {
					p.log.Error("convert chat completions to responses", "error", cerr)
				}
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(http.StatusOK)
				writeResponsesJSONEvents(w, r.Context(), conv)
				return
			}
			if toResponses {
				w.Header().Set("Content-Type", "text/event-stream")
			}
			w.WriteHeader(http.StatusOK)
			if toResponses {
				p.copyResponsesStream(w, r.Context(), resp.Body)
				return
			}
			alias := ""
			if rewrite {
				alias = meta.Model
			}
			p.copyStream(w, r.Context(), resp.Body, alias)
			return
		}

		data, err := io.ReadAll(resp.Body)
		if err != nil {
			p.log.Error("read upstream body", "error", err)
			return
		}
		if toResponses {
			converted, cerr := convertChatToResponses(data)
			if cerr != nil {
				p.log.Error("convert chat completions to responses", "error", cerr)
			} else {
				data = converted
				w.Header().Set("Content-Type", "application/json")
			}
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
