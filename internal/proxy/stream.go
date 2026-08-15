package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

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
