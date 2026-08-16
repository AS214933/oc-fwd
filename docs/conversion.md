# 强制统一为 Chat Completions 转发

`ZEN_FORCE_CHAT_COMPLETIONS=true` 时，所有请求统一转成 Chat Completions 转发到上游 `/v1/chat/completions`：

- `/v1/chat/completions`：原样透传（不查白名单 / 不改写）；
- `/v1/responses`：请求转 Chat Completions（`instructions`→system、`input`→user/assistant、`max_output_tokens`→`max_tokens`、tools 转换），**响应再转回 Responses 格式**（非流式 `response` 对象，流式 `response.created` / `response.output_text.delta` / `response.completed` 等事件），codex / opencode 等 `/v1/responses` 客户端可正常解析；
- 工具调用双向转换：`function_call` → `tool_calls` assistant 消息、`function_call_output` → `role=tool`，`call_id` 原样保留；
- `/v1/messages`（Anthropic）：`system` / `messages` / `tools` / `max_tokens` 转换后转发；
- 图片等非文本 content 目前会被忽略（纯文本转换）。

`false`（默认）时各端点按原生格式转发（`/v1/responses → /responses`、`/v1/messages → /messages`），模型白名单 / 别名对三个端点均生效。
