# 上游特殊适配清单

zenproxy 针对 opencode zen 网关（`https://opencode.ai/zen/v1`）及其背后 provider 的
已知行为，做了一批**绕过 / 修复 / 兜底**的特殊处理。按入站 → 出站分类记录，
改动时先对照本清单，避免误伤其他适配。

## 1. 确定性错误：原样透传，不重试、不切 key

### 1a. 多模态内容不被模型支持（400 invalid_request_error）

**触发**：请求体含图片 / 音频 / `input_image` / 未知 content type，模型只支持文本。
**上游**：返回 `400 invalid_request_error`，错误信息如
`Model only supports text input; received unsupported content type 'image_url'.`
**适配**：识别为**确定性 400**——重试（包括换 API key 重试）结果必然相同，因此
**直接原样回传**给客户端，不进重试阶梯、不触发匿名→key 回退、不影响熔断计数。

**判定关键字**：`image_url` / `input_image` / `unsupported content type` / `audio` /
`content type 'image'` / `model only supports text` 等，且错误为 `invalid_request_error`。

### 1b. deepseek 思考模式漏传 reasoning_content（400 invalid_request_error）

**触发**：所有模型 ID 以 `deepseek-` 开头的 DeepSeek 系列（包括 flash、pro、free）开 thinking 模式时，多轮对话
**必须**把上一轮 assistant 的 `reasoning_content` 原样带回；否则上游返回：
`The \`reasoning_content\` in the thinking mode must be passed back to the API.`
**适配**：代理保留 Codex 返回/回传的 `type:"reasoning"` 原始 `reasoning_text`，
在下一轮把它附回同一条 assistant 消息（包括普通文本与 `tool_calls`）的
`reasoning_content` 字段。此往返同时覆盖普通 JSON 与 SSE，并只在 DeepSeek Chat 上游发送
该专用字段。对于客户端
丢失原文的工具调用，代理会在 10 分钟内按 `call_id` 回放刚收到的原文；DeepSeek 还会
校验没有工具调用的普通 assistant 历史消息，因此任何仍缺此字段的 assistant 消息会补
单个空格作为兼容占位。这样不会把这个 DeepSeek 专用字段泄漏给其他模型，也优先保留
真实思考内容；只有无法恢复的旧历史才会降级为占位。

**判定关键字**：`reasoning_content` + `must be passed back`，且错误为
`invalid_request_error`。

### 1c. Responses 非函数工具不被 Console 支持（400 invalid_request_error）

**触发**：Codex 等 Responses 客户端可能携带 `web_search`、`computer`、`image_generation`、
`mcp`、`custom` 等内置工具。Zen 的 Console 上游只接受可转换的标准 `function` 工具，典型错误为
``tools[5] did not match any supported type``。

**适配**：代理在所有入站协议完成 canonical Chat 转换后，只保留合法的
`type:"function"` + `function.name` 工具；被移除工具对应的 `tool_choice` 也删除。这个规则对
Responses、Chat、Messages 和 Gemini 出站统一生效，保证未知内置工具不会被原样透传到任意模型。
被移除的工具不能在 Zen 端执行。若上游仍返回该错误，代理将其作为确定性请求错误直接回传，
不重试、不切换 API key。

## 2. 客户端状态丢失：代理层修复消息序列

### 2a. assistant tool_calls 后面缺 role=tool 响应（OpenAI 兼容校验）

**触发**：任意入站（`/v1/chat/completions` 直通、`/v1/responses`、
`/v1/messages`）的对话历史里，assistant 消息声明了 `tool_calls`，但之后没有
对应的 `role:"tool"` 消息回应每个 `tool_call_id`。典型来源：agent 客户端
（opencode / codex）多轮工具循环里，某一轮的 tool 结果没被持久化进下一轮，
或并行工具调用只回传了部分结果。
**上游**：400 `invalid_request_error`：
`An assistant message with 'tool_calls' must be followed by tool messages`
**适配**：在转换统一收口点（`handleCompletion`）对 `chatReq.messages` 做归一化——
为每个未被回答的 `call_id` 在其所属 assistant 消息后插入一条**空内容的
`role:"tool"` 消息**（`content: ""`）。已配对的消息**原样不动**（测试锁定），
只在原本会 400 的请求上生效，让对话从"整体报错中断"变为"继续生成"。

### 2b. responses 入站的 function_call 结果缺失（`/v1/responses` → chat）

**触发**：`/v1/responses` 入站 `input` 数组里出现 `function_call` 条目，但其
`function_call_output` 不在同一请求（结果在下一轮携带，或并行调用缺结果）。
**适配**：与 2a 同一套归一化——转换完成后补空 `tool` 消息，保证上游 chat 序列合法。

## 3. 思考内容跨协议回传

zenproxy 把各协议的"思考内容"归一化为 canonical 的 `reasoning_content`
（chat 消息 / `ChatChunk.delta` 上的统一字段），并在所有协议边界双向还原。
这样任意客户端协议 × 任意模型家族都能把思考过程带回给客户端，也不会在不同
协议之间丢失或错位。

| 协议 | 入站 → canonical | canonical → 出站 |
| --- | --- | --- |
| Chat（deepseek 等） | `message.reasoning_content` / `delta.reasoning_content` | 同上（DeepSeek 必须回传，见 1b；其他 chat 模型不发送该字段） |
| Responses | `type:"reasoning"` 条目（含流式 `response.reasoning_text.delta`） | `reasoning` 输出条目 / `response.reasoning_text.delta` |
| Anthropic Messages | `type:"thinking"` 块（流式 `thinking_delta`） | `type:"thinking"` 块（流式 `content_block_start` / `thinking_delta` / `content_block_stop`） |
| Gemini | `part.thought === true` 的文本部分 | `{ text, thought: true }` 部分 |

- Responses 出站会在 `reasoning` 条目里同步填充 `summary`（`summary_text`），并流式
  发送 `response.reasoning_summary_part.added` / `response.reasoning_summary_text.delta`
  / `response.reasoning_summary_part.done`，让 Codex 这类只渲染摘要的客户端也能把
  deepseek 的思考内容直接展示给用户（摘要内容 = 完整 `reasoning_content`）。
- Anthropic 的 thinking `signature` 会随 canonical 往返保留（`reasoning_signature`），
  claude→claude 多轮续聊仍能按原样把 thinking 块（含签名）回传给上游；跨协议
  合成（deepseek / gemini / gpt 思考 → claude 上游）的 thinking 块没有签名。
- `thinking`（Anthropic）与 `reasoning`（Responses）请求参数只在同类协议往返时
  透传（messages→messages、responses→responses）；发往 Chat Completions 上游前
  会被剥除，避免未知字段被上游拒绝。
- Gemini 的思考部分不会混入正文：`thought: true` 的部分进入 `reasoning_content`，
  普通文本仍走 `content`。

## 4. 传输层优化（不影响随机 socks5 出口）

- **TLS 会话复用**：每次请求仍新建 socks5 隧道（随机出口不变），但跨连接复用
  与出口 IP 无关的 TLS ticket，握手降为 1 个 RTT。
- **TCP_NODELAY**：所有上游 socket 关闭 Nagle 聚合，SSE 逐 token 小包即时发送。
- **chat→chat 流式直通**：上游与客户端都是 Chat Completions 时字节级转发 SSE，
  不再逐 chunk 解析重建；缺 `[DONE]` 时兜底补发。
- **readSSE 线性化**：协议转换路径滑动窗口消费，避免高吞吐下 O(n²) 拷贝。

详见 [docs/networking.md](networking.md)。

## 5. 日志与观测

- 任何非 200 上游响应都会把**解析后的错误体**打进日志：
  `[WARN] upstream returned non-200 {"status":...,"model":...,"error_type":...,"error_code":...,"error_message":...,"body":"..."}`。
- 缺少客户端原文时，`reasoning_content` 类错误额外带 `"direct_pass_through":true`，方便对照本清单判断走了哪条分支。

## 判定优先级（non-200 分支）

1. 429 → 重试阶梯（尊重 Retry-After）+ 熔断
2. 多模态确定性 400 → **直接原样返回**
3. 缺少 `reasoning_content` 的确定性 400 → **直接原样返回**（不重试、不切 key）
4. 其他非 200 → 重试阶梯耗尽后，匿名模式自动切 key 重试一次（fail-fast）
