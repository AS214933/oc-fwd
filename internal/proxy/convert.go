package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

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
