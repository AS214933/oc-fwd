package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestResponsesInputWithToolRoundTrip(t *testing.T) {
	in := `{
		"model":"deepseek-v4-flash-free",
		"input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"list files"}]},
			{"type":"function_call","id":"fc_prev","call_id":"call_prev","name":"shell","arguments":"{\"command\":\"ls\"}"},
			{"type":"function_call_output","call_id":"call_prev","output":"a.txt\nb.txt"}
		],
		"tools":[{"type":"function","name":"shell","description":"run a command","parameters":{"type":"object"}}]
	}`
	out, err := convertResponsesToChat([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	var got chatBody
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Messages) != 3 {
		t.Fatalf("want 3 messages, got %d: %s", len(got.Messages), out)
	}
	asm := got.Messages[1]
	if asm.Role != "assistant" || len(asm.ToolCalls) != 1 {
		t.Fatalf("assistant tool_calls wrong: %+v", asm)
	}
	tc := asm.ToolCalls[0]
	if tc.ID != "call_prev" || tc.Type != "function" || tc.Function.Name != "shell" {
		t.Fatalf("tool call wrong: %+v", tc)
	}
	// arguments must be a JSON-encoded string in chat completions
	var argsStr string
	if err := json.Unmarshal(tc.Function.Arguments, &argsStr); err != nil {
		t.Fatalf("arguments is not a JSON string: %s (%v)", tc.Function.Arguments, err)
	}
	if argsStr != `{"command":"ls"}` {
		t.Fatalf("arguments = %q", argsStr)
	}
	tm := got.Messages[2]
	if tm.Role != "tool" || tm.ToolCallID != "call_prev" || tm.Content != "a.txt\nb.txt" {
		t.Fatalf("tool message wrong: %+v", tm)
	}
	if len(got.Tools) != 1 || got.Tools[0].Function.Name != "shell" {
		t.Fatalf("tools wrong: %+v", got.Tools)
	}
}

func TestChatToResponsesNonStream(t *testing.T) {
	in := `{
		"id":"chatcmpl-1","object":"chat.completion","model":"deepseek-v4-flash-free",
		"choices":[{"index":0,"message":{"role":"assistant","content":"Hello world"},"finish_reason":"stop"}],
		"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}
	}`
	out, err := convertChatToResponses([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["object"] != "response" || got["status"] != "completed" {
		t.Fatalf("bad response shape: %s", out)
	}
	output, _ := got["output"].([]any)
	if len(output) != 1 {
		t.Fatalf("want 1 output item, got %d: %s", len(output), out)
	}
	msg := output[0].(map[string]any)
	if msg["type"] != "message" || msg["role"] != "assistant" {
		t.Fatalf("bad message item: %v", msg)
	}
	parts, _ := msg["content"].([]any)
	txt := parts[0].(map[string]any)["text"]
	if txt != "Hello world" {
		t.Fatalf("text = %v", txt)
	}
	usage, _ := got["usage"].(map[string]any)
	if usage["input_tokens"] != float64(5) || usage["output_tokens"] != float64(2) {
		t.Fatalf("usage = %v", usage)
	}
}

func TestChatToResponsesWithToolCall(t *testing.T) {
	in := `{
		"id":"chatcmpl-1","object":"chat.completion","model":"deepseek-v4-flash-free",
		"choices":[{"index":0,"message":{"role":"assistant","content":"",
			"tool_calls":[{"id":"call_abc","type":"function","function":{"name":"shell","arguments":"{\"command\":\"ls\"}"}}]},
			"finish_reason":"tool_calls"}]
	}`
	out, err := convertChatToResponses([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Output []struct {
			Type      string `json:"type"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"output"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Output) != 1 || got.Output[0].Type != "function_call" {
		t.Fatalf("want one function_call item, got: %s", out)
	}
	fc := got.Output[0]
	if fc.CallID != "call_abc" || fc.Name != "shell" || fc.Arguments != `{"command":"ls"}` {
		t.Fatalf("function_call wrong: %+v", fc)
	}
}

func TestResponsesStreamConverterText(t *testing.T) {
	cv := newResponsesStreamConverter()
	var all []string
	collect := func(events [][]byte) {
		for _, e := range events {
			all = append(all, string(e))
		}
	}
	collect(cv.consume([]byte(`{"id":"chatcmpl-1","model":"deepseek-v4-flash-free","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`)))
	collect(cv.consume([]byte(`{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`)))
	collect(cv.consume([]byte(`{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}`)))
	collect(cv.consume([]byte(`{"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`)))
	collect(cv.finish())

	var types []string
	var deltas []string
	var completed bool
	var usageOk bool
	for _, raw := range all {
		var ev struct {
			Type     string `json:"type"`
			Delta    string `json:"delta"`
			Response struct {
				Status string            `json:"status"`
				Output []json.RawMessage `json:"output"`
				Usage  map[string]any    `json:"usage"`
			} `json:"response"`
		}
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			t.Fatalf("invalid event json %q: %v", raw, err)
		}
		types = append(types, ev.Type)
		if ev.Type == "response.output_text.delta" {
			deltas = append(deltas, ev.Delta)
		}
		if ev.Type == "response.completed" {
			completed = true
			usageOk = ev.Response.Usage != nil && ev.Response.Status == "completed"
		}
	}
	joined := strings.Join(types, ",")
	for _, want := range []string{
		"response.created", "response.output_item.added", "response.content_part.added",
		"response.output_text.delta", "response.output_text.done", "response.content_part.done",
		"response.output_item.done", "response.completed",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %s in %s", want, joined)
		}
	}
	if got := strings.Join(deltas, ""); got != "Hello world" {
		t.Fatalf("deltas = %q", got)
	}
	if !completed || !usageOk {
		t.Fatalf("completed=%v usageOk=%v", completed, usageOk)
	}
	// No chat.completion.chunk leakage
	if strings.Contains(joined, "chat.completion.chunk") || strings.Contains(joined, "choices") {
		t.Fatalf("chat format leaked into responses events: %s", joined)
	}
}

func TestResponsesStreamConverterToolCall(t *testing.T) {
	cv := newResponsesStreamConverter()
	var all []string
	for _, payload := range []string{
		`{"id":"c","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
		`{"id":"c","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}`,
		`{"id":"c","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":"}}]},"finish_reason":null}]}`,
		`{"id":"c","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]},"finish_reason":null}]}`,
		`{"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
	} {
		for _, e := range cv.consume([]byte(payload)) {
			all = append(all, string(e))
		}
	}
	for _, e := range cv.finish() {
		all = append(all, string(e))
	}

	var addedItem map[string]any
	var argsDelta []string
	var argsDone []string
	var itemDone map[string]any
	var completed map[string]any
	for _, raw := range all {
		var ev map[string]any
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			t.Fatalf("invalid event %q", raw)
		}
		switch ev["type"] {
		case "response.output_item.added":
			if item, ok := ev["item"].(map[string]any); ok && item["type"] == "function_call" {
				addedItem = item
			}
		case "response.function_call_arguments.delta":
			argsDelta = append(argsDelta, ev["delta"].(string))
		case "response.function_call_arguments.done":
			argsDone = append(argsDone, ev["arguments"].(string))
		case "response.output_item.done":
			if item, ok := ev["item"].(map[string]any); ok && item["type"] == "function_call" {
				itemDone = item
			}
		case "response.completed":
			completed = ev
		}
	}
	if addedItem == nil {
		t.Fatalf("no function_call output_item.added: %s", all)
	}
	if addedItem["call_id"] != "call_abc" || addedItem["name"] != "shell" {
		t.Fatalf("added item wrong: %v", addedItem)
	}
	if got := strings.Join(argsDelta, ""); got != `{"command":"ls"}` {
		t.Fatalf("args deltas = %q", got)
	}
	if len(argsDone) != 1 || argsDone[0] != `{"command":"ls"}` {
		t.Fatalf("args done = %v", argsDone)
	}
	if itemDone == nil || itemDone["status"] != "completed" {
		t.Fatalf("item done wrong: %v", itemDone)
	}
	if completed == nil {
		t.Fatalf("no response.completed")
	}
}
