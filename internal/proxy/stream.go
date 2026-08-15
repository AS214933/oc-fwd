package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
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

// writeResponsesJSONEvents emits a minimal Responses SSE sequence
// (response.created -> response.completed) from an already-converted
// responses JSON object. Used when the upstream ignored stream=true and
// returned a single JSON chat.completion body instead of an SSE stream.
func writeResponsesJSONEvents(w io.Writer, ctx context.Context, data []byte) {
	if len(data) == 0 {
		return
	}
	var resp map[string]any
	if err := json.Unmarshal(data, &resp); err != nil {
		return
	}
	if err := ctx.Err(); err != nil {
		return
	}
	created := map[string]any{}
	for k, v := range resp {
		created[k] = v
	}
	created["status"] = "in_progress"
	created["output"] = []any{}
	for _, ev := range [][]byte{
		mustMarshal(map[string]any{"type": "response.created", "response": created}),
		mustMarshal(map[string]any{"type": "response.completed", "response": resp}),
	} {
		if _, werr := fmt.Fprintf(w, "data: %s\n\n", ev); werr != nil {
			return
		}
	}
	if fl, ok := w.(http.Flusher); ok {
		fl.Flush()
	}
}

func mustMarshal(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// copyResponsesStream relays an upstream Chat Completions SSE stream and
// translates every chat.completion.chunk into Responses API SSE events, so a
// client that called /v1/responses (codex, opencode, ...) can parse the output
// even though the upstream only speaks chat completions.
func (p *Proxy) copyResponsesStream(w http.ResponseWriter, ctx context.Context, src io.Reader) {
	flusher, _ := w.(http.Flusher)
	br := bufio.NewReaderSize(src, 64*1024)
	cv := newResponsesStreamConverter()
	writeEvents := func(events [][]byte) bool {
		for _, ev := range events {
			if _, werr := fmt.Fprintf(w, "data: %s\n\n", ev); werr != nil {
				return false
			}
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			trimmed := bytes.TrimSpace(line)
			if bytes.HasPrefix(trimmed, []byte("data:")) {
				payload := bytes.TrimSpace(trimmed[len("data:"):])
				if len(payload) > 0 && payload[0] == '{' {
					if !writeEvents(cv.consume(payload)) {
						return
					}
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				writeEvents(cv.finish())
				return
			}
			p.log.Debug("stream read error", "error", err)
			return
		}
	}
}

type responsesStreamConverter struct {
	started   bool
	finished  bool
	model     string
	createdAt int64

	msgAdded   bool
	partAdded  bool
	text       strings.Builder
	msgIndex   int
	contentIdx int

	tools    map[int]*responsesTool
	toolSeen int // count of tool indexes seen, for stable ids

	usage map[string]any
}

type responsesTool struct {
	index   int
	id      string
	name    string
	args    strings.Builder
	added   bool
	doneIdx int
}

func newResponsesStreamConverter() *responsesStreamConverter {
	return &responsesStreamConverter{createdAt: time.Now().Unix(), tools: map[int]*responsesTool{}}
}

func (c *responsesStreamConverter) consume(payload []byte) [][]byte {
	var chunk struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Created int64  `json:"created"`
		Choices []struct {
			Index int `json:"index"`
			Delta struct {
				Role      string `json:"role"`
				Content   string `json:"content"`
				ToolCalls []struct {
					Index    int    `json:"index"`
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return nil
	}
	var events [][]byte
	if !c.started {
		c.started = true
		c.model = chunk.Model
		if chunk.Created > 0 {
			c.createdAt = chunk.Created
		}
		events = append(events, c.respEvent("response.created", c.responseBody("in_progress", nil)))
		events = append(events, c.respEvent("response.in_progress", c.responseBody("in_progress", nil)))
	}

	for _, choice := range chunk.Choices {
		d := choice.Delta
		if !c.msgAdded {
			// The stream started with a text response (content role marker or
			// the first text fragment) - introduce the message output item.
			if d.Content != "" || d.Role != "" || len(d.ToolCalls) == 0 {
				c.msgAdded = true
				events = append(events, c.event("response.output_item.added", map[string]any{
					"output_index": 0,
					"item": map[string]any{
						"id": "msg_1", "type": "message", "status": "in_progress",
						"role": "assistant", "content": []any{},
					},
				}))
				events = append(events, c.event("response.content_part.added", map[string]any{
					"item_id": "msg_1", "output_index": 0, "content_index": 0,
					"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}},
				}))
				c.partAdded = true
			}
		}
		if d.Content != "" {
			c.text.WriteString(d.Content)
			events = append(events, c.event("response.output_text.delta", map[string]any{
				"item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": d.Content,
			}))
		}
		for _, tc := range d.ToolCalls {
			t := c.tools[tc.Index]
			if t == nil {
				t = &responsesTool{index: tc.Index}
				c.tools[tc.Index] = t
			}
			if tc.ID != "" {
				t.id = tc.ID
			}
			if tc.Function.Name != "" {
				t.name = tc.Function.Name
			}
			if tc.Function.Arguments != "" {
				t.args.WriteString(tc.Function.Arguments)
			}
			if !t.added {
				t.added = true
				c.toolSeen++
				t.doneIdx = c.msgIndex + c.toolSeen
				item := map[string]any{
					"id": "fc_" + strconv.Itoa(t.doneIdx), "type": "function_call", "status": "in_progress",
					"call_id": t.id, "name": t.name, "arguments": "",
				}
				events = append(events, c.event("response.output_item.added", map[string]any{
					"output_index": t.doneIdx, "item": item,
				}))
			}
			if tc.Function.Arguments != "" {
				events = append(events, c.event("response.function_call_arguments.delta", map[string]any{
					"item_id": "fc_" + strconv.Itoa(t.doneIdx), "output_index": t.doneIdx,
					"delta": tc.Function.Arguments,
				}))
			}
		}
	}
	if chunk.Usage != nil {
		c.usage = map[string]any{
			"input_tokens":  chunk.Usage.PromptTokens,
			"output_tokens": chunk.Usage.CompletionTokens,
			"total_tokens":  chunk.Usage.TotalTokens,
		}
	}
	for _, choice := range chunk.Choices {
		if choice.FinishReason != "" {
			events = append(events, c.finishEvents()...)
			break
		}
	}
	return events
}

func (c *responsesStreamConverter) finish() [][]byte {
	if c.finished {
		return nil
	}
	return c.finishEvents()
}

// finishEvents emits the closing events for every pending output item and the
// final response.completed event. Safe to call more than once.
func (c *responsesStreamConverter) finishEvents() [][]byte {
	if c.finished {
		return nil
	}
	c.finished = true
	var events [][]byte
	var output []any
	if c.msgAdded {
		text := c.text.String()
		events = append(events, c.event("response.output_text.done", map[string]any{
			"item_id": "msg_1", "output_index": 0, "content_index": 0, "text": text,
		}))
		events = append(events, c.event("response.content_part.done", map[string]any{
			"item_id": "msg_1", "output_index": 0, "content_index": 0,
			"part": map[string]any{"type": "output_text", "text": text, "annotations": []any{}},
		}))
		msgItem := map[string]any{
			"id": "msg_1", "type": "message", "status": "completed", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}},
		}
		events = append(events, c.event("response.output_item.done", map[string]any{
			"output_index": 0, "item": msgItem,
		}))
		output = append(output, msgItem)
	}
	for _, t := range c.tools {
		args := t.args.String()
		item := map[string]any{
			"id": "fc_" + strconv.Itoa(t.doneIdx), "type": "function_call", "status": "completed",
			"call_id": t.id, "name": t.name, "arguments": args,
		}
		events = append(events, c.event("response.function_call_arguments.done", map[string]any{
			"item_id": "fc_" + strconv.Itoa(t.doneIdx), "output_index": t.doneIdx, "arguments": args,
		}))
		events = append(events, c.event("response.output_item.done", map[string]any{
			"output_index": t.doneIdx, "item": item,
		}))
		output = append(output, item)
	}
	events = append(events, c.respEvent("response.completed", c.responseBody("completed", output)))
	return events
}

func (c *responsesStreamConverter) responseBody(status string, output []any) map[string]any {
	return map[string]any{
		"id":         "resp_1",
		"object":     "response",
		"created_at": c.createdAt,
		"status":     status,
		"model":      c.model,
		"output":     output,
		"usage":      c.usage,
	}
}

func (c *responsesStreamConverter) event(typ string, payload map[string]any) []byte {
	m := map[string]any{"type": typ}
	for k, v := range payload {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	return b
}

func (c *responsesStreamConverter) respEvent(typ string, response map[string]any) []byte {
	m := map[string]any{"type": typ, "response": response}
	b, _ := json.Marshal(m)
	return b
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
