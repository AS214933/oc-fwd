# 模型驱动的入站 / 出站自动转换

本代理的核心是"sub2api 式"的协议转换：客户端用自己习惯的协议发起请求，代理根据**用户请求的模型**自动选择 zen 的上游协议并双向转换。

## 入站（客户端 → 代理）

| 端点 | 协议 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses API（codex / opencode 等） |
| `POST /v1/messages` | Anthropic Messages API |

## 出站（代理 → opencode zen）

模型 → 上游协议由内置模型表决定（数据来自 [opencode zen 官方模型表](https://opencode.ai/docs/zh-cn/zen/#%E6%A8%A1%E5%9E%8B)，2026-08-16 抓取）：

| 模型家族 | 上游端点 | 协议 |
| --- | --- | --- |
| `gpt-5.x*`、`grok-*`、`muse-*` | `/v1/responses` | OpenAI Responses |
| `claude-*`、`qwen3.x-*` | `/v1/messages` | Anthropic Messages |
| `gemini-*` | `/v1/models/<model-id>` | Google Gemini generateContent |
| `deepseek-*`、`minimax-*`、`glm-*`、`kimi-*`、免费模型 | `/v1/chat/completions` | OpenAI Chat Completions |

- 表内精确匹配优先，其次前缀启发式（如 `gpt-` → responses、`claude-` → messages），未知名模型默认走 Chat Completions；
- 可用 `ZEN_MODEL_ENDPOINTS=model=chat|responses|messages|gemini` 覆盖单个模型；
- `ZEN_MODEL_MAP` 别名先解析成上游模型 id，再按上游 id 选协议；
- 客户端请求 `/v1/models` 时，代理会缓存转发 Zen 当前模型目录；Zen 返回的仅是模型 ID，不带端点或 schema，因此不会替代上述协议映射；
- `ZEN_FORCE_CHAT_COMPLETIONS=true` 时不看模型家族，全部转 Chat Completions。

## 转换矩阵

任意入站协议 × 任意出站协议均可转换，非流式与流式（SSE）都支持：

| 入站 \\ 出站 | chat | responses | messages | gemini |
| --- | --- | --- | --- | --- |
| chat | 透传 | ✓ | ✓ | ✓ |
| responses | ✓ | 透传 | ✓ | ✓ |
| messages | ✓ | ✓ | 透传 | ✓ |

转换细节：

- **Requests**：`instructions` → system 消息、`input`（字符串 / 条目数组）→ messages、`max_output_tokens` → `max_tokens`、`function_call` / `function_call_output` → assistant `tool_calls` / `tool` 消息（`call_id` 原样保留）、`developer` 角色 → `system`；
- **Responses 响应**：chat.completion → `resp_*` response 对象（message / function_call 输出条目）；流式输出 `response.created` → `response.output_text.delta` → `response.completed` 事件序列；
- **Messages**：`system` / `messages` / `tools` / `max_tokens`；`tool_use` ↔ `tool_calls`、`tool_result` ↔ `role=tool`；响应 `stop_reason` ↔ `finish_reason`；流式输出 Anthropic 事件序列；
- **Gemini**：`contents` / `systemInstruction` / `generationConfig` / `tools.functionDeclarations`；`functionCall` ↔ `tool_calls`、`functionResponse` ↔ `role=tool`；
- **Tools**：所有入站协议统一只保留标准 `function` 工具；Codex Responses 的 `web_search`、`computer`、`image_generation`、`mcp`、`custom` 等工具以及指向它们的 `tool_choice` 不会发给 Zen，避免 Console 对不支持类型返回 400；
- 图片等非文本 content 目前会被忽略（纯文本转换）；若模型本身不支持多模态，上游
  返回的 `invalid_request_error`（如 `Model only supports text input`）会被代理
  **原样回传且不重试、不触发 key 回退**——见 [retry-and-fallback.md](retry-and-fallback.md)。

## 兼容模式开关

- `ZEN_FORCE_CHAT_COMPLETIONS=true`：所有请求统一转 Chat Completions 转发（`/v1/chat/completions` 原样透传），响应再转回入站协议；
- `ZEN_FORCE_CHAT_INBOUND=true`：只接受 `/v1/chat/completions` 入站，`/v1/responses` 与 `/v1/messages` 直接 400，客户端必须使用 Chat Completions 协议（如 opencode 配置 `provider` 为 `api: "openai"`、`options.baseURL` 指向本代理）。

## 流式注意事项

- 上游忽略 `stream=true` 返回单次 JSON 时，代理会补发最小 SSE 事件序列（chat：单条 data + `[DONE]`；responses：`response.created` / `response.completed`；messages：完整 Anthropic 事件序列），流式客户端不会挂起；
- 工具调用的流式转换同样可用：`tool_calls` 增量 → responses `function_call_arguments.delta` / anthropic `input_json_delta`。
