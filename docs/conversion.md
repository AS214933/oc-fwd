# 强制统一为 Chat Completions

反代有两个独立的开关，分别强制「转发（上游）」与「入站（客户端）」使用 Chat Completions。

## 强制转发：`ZEN_FORCE_CHAT_COMPLETIONS=true`

所有请求统一转成 Chat Completions 转发到上游 `/v1/chat/completions`：

- `/v1/chat/completions`：原样透传（不查白名单 / 不改写）；
- `/v1/responses`：请求转 Chat Completions（`instructions`→system、`input`→user/assistant、`max_output_tokens`→`max_tokens`、tools 转换），**响应再转回 Responses 格式**（非流式 `response` 对象，流式 `response.created` / `response.output_text.delta` / `response.completed` 等事件），codex / opencode 等 `/v1/responses` 客户端可正常解析；
- 工具调用双向转换：`function_call` → `tool_calls` assistant 消息、`function_call_output` → `role=tool`，`call_id` 原样保留（`call_id` 缺失时回退到条目 `id`）；
- 角色归一化：`developer` → `system`（Codex 的开发者提示会以 `developer` 角色发送，而 zen 类 chat 上游只接受 `system` / `user` / `assistant` / `tool`）；
- `/v1/messages`（Anthropic）：`system` / `messages` / `tools` / `max_tokens` 转换后转发；
- 图片等非文本 content 目前会被忽略（纯文本转换）。

`false`（默认）时各端点按原生格式转发（`/v1/responses → /responses`、`/v1/messages → /messages`），模型白名单 / 别名对三个端点均生效。

## 强制入站：`ZEN_FORCE_CHAT_INBOUND=true`

只接受 Chat Completions 格式的入站请求：`/v1/chat/completions` 正常转发（配合 `ZEN_FORCE_CHAT_COMPLETIONS` 或不配合均可），`/v1/responses` 与 `/v1/messages` 直接返回 400 并提示客户端改用 `/v1/chat/completions`。

适用场景：客户端本身能说 Chat Completions（例如 opencode 配置 `provider` 为 `api: "openai"`、`options.baseURL` 指向本反代），希望避免 Responses ↔ Chat 双向转换的损耗与兼容性风险，强制所有客户端走 Chat Completions。

注意：新版 Codex CLI 已移除 `wire_api = "chat"`，只支持 Responses 协议；用 Codex 接入时应保持 `ZEN_FORCE_CHAT_INBOUND=false`，走上面的 `/v1/responses` 双向转换。
