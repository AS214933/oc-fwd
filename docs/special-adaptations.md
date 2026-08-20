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

**触发**：deepseek 系列（`deepseek-v4-flash-free` 等）开 thinking 模式时，多轮对话
**必须**把上一轮 assistant 的 `reasoning_content` 原样带回；客户端（opencode /
codex 等）若在下一轮请求里丢弃该字段，上游返回：
`The \`reasoning_content\` in the thinking mode must be passed back to the API.`
**适配**：识别该错误后**直接原样返回**给客户端——不重试、不进入重试阶梯、
**不触发匿名→API key 回退**、不切 key 模式。因为重试和换 key 都缺同一个字段，
结果必然不变，重试只会拖延响应、切换只会白白消耗 key 配额并引发后续探测抖动。

**判定关键字**：`reasoning_content` + `must be passed back`，且错误为
`invalid_request_error`。

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

## 3. 传输层优化（不影响随机 socks5 出口）

- **TLS 会话复用**：每次请求仍新建 socks5 隧道（随机出口不变），但跨连接复用
  与出口 IP 无关的 TLS ticket，握手降为 1 个 RTT。
- **TCP_NODELAY**：所有上游 socket 关闭 Nagle 聚合，SSE 逐 token 小包即时发送。
- **chat→chat 流式直通**：上游与客户端都是 Chat Completions 时字节级转发 SSE，
  不再逐 chunk 解析重建；缺 `[DONE]` 时兜底补发。
- **readSSE 线性化**：协议转换路径滑动窗口消费，避免高吞吐下 O(n²) 拷贝。

详见 [docs/networking.md](networking.md)。

## 4. 日志与观测

- 任何非 200 上游响应都会把**解析后的错误体**打进日志：
  `[WARN] upstream returned non-200 {"status":...,"model":...,"error_type":...,"error_code":...,"error_message":...,"body":"..."}`。
- `reasoning_content` 类错误额外带 `"direct_pass_through":true`，方便对照本清单判断走了哪条分支。

## 判定优先级（non-200 分支）

1. 429 → 重试阶梯（尊重 Retry-After）+ 熔断
2. 多模态确定性 400 → **直接原样返回**
3. `reasoning_content` 确定性 400 → **直接原样返回**（不重试、不切 key）
4. 其他非 200 → 重试阶梯耗尽后，匿名模式自动切 key 重试一次（fail-fast）
