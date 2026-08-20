# oc-fwd (zen-proxy)

一个专门转发 [opencode ai zen](https://opencode.ai/zen) 的 **sub2api** 风格反向代理，使用 **TypeScript + Bun** 编写（无 Go 依赖）。

对外暴露 **OpenAI 兼容**接口，内部自动按用户请求的模型选择 zen 的上游协议并做**入站 ⇄ 出站双向转换**：

- 入站：`/v1/chat/completions`、`/v1/responses`（codex / opencode）、`/v1/messages`（Anthropic）
- 出站：按模型自动选择，数据来自 [opencode zen 官方模型表](https://opencode.ai/docs/zh-cn/zen/#模型)：
  - `gpt-5.x` / `grok-*` / `muse-*` → `/v1/responses`（Responses API）
  - `claude-*` / `qwen3.x-*` → `/v1/messages`（Anthropic Messages）
  - `gemini-*` → `/v1/models/<id>`（Gemini generateContent）
  - `deepseek-*` / `minimax-*` / `glm-*` / `kimi-*` / 免费模型 → `/v1/chat/completions`
- 任意客户端协议 × 任意模型都能互相转换（含流式 SSE 与工具调用），例如：
  - `chat` 客户端请求 `gpt-5.6-sol` → 自动转成 Responses 请求发到 `/v1/responses`，再把响应转回 `chat.completion`；
  - `responses` 客户端请求 `claude-opus-5` → 自动转成 Anthropic `messages` 请求，响应再转回 Responses 事件流。

## 特性

- 模型白名单 / 别名（`ZEN_MODELS` / `ZEN_MODEL_MAP`）、协议覆盖（`ZEN_MODEL_ENDPOINTS`）、上游 `/models` 动态目录缓存
- 匿名调用（zen free）或带 key（`ZEN_UPSTREAM_API_KEY` / `ZEN_API_KEYS_FILE` 随机轮换）
- 调用方鉴权（`ZEN_AUTH_KEY`）
- 429 自动重试 + 熔断 + 匿名失败自动回退 API key
- 上游特殊适配（deepseek reasoning_content、多模态 400、tool_calls 序列修复等）：见 [docs/special-adaptations.md](docs/special-adaptations.md)
- socks5 代理、IPv6 优先、每请求新连接（`ZEN_SOCKS5` / `ZEN_IPV6_PREFER` / `ZEN_ROTATE_IP`）
- 兼容模式：`ZEN_FORCE_CHAT_COMPLETIONS`（统一 chat 出站）、`ZEN_FORCE_CHAT_INBOUND`（只收 chat）
- Codex / Responses 的内置工具类型自动过滤为 Zen 可接受的标准 `function` 工具
- 附赠 Status UI 状态页（模型 匿名 / API Key / 全部失败 实时展示）

## 快速开始

### 直接运行（需要 [Bun](https://bun.sh) ≥ 1.1）

```bash
bun install
ZEN_MODELS=deepseek-v4-flash-free bun run src/cmd/zenproxy.ts
curl http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}]}'
```

### Docker Compose

```bash
cp .env.example .env
docker compose up -d --build   # 反代 :8080 + Status UI :8090
```

## 测试

```bash
bun run typecheck   # tsc --noEmit
bun test            # 单元测试
bun run test:e2e    # 端到端（启动真实代理 + mock zen 网关，覆盖全部转换矩阵）
```

## 文档

| 主题 | 链接 |
| --- | --- |
| 配置与环境变量、调用示例 | [docs/configuration.md](docs/configuration.md) |
| 模型驱动的入站/出站自动转换 | [docs/conversion.md](docs/conversion.md) |
| socks5、IPv6 与高并发 | [docs/networking.md](docs/networking.md) |
| 重试、熔断与匿名回退 API Key | [docs/retry-and-fallback.md](docs/retry-and-fallback.md) |
| 状态页 Status UI | [docs/status-ui.md](docs/status-ui.md) |

## 项目结构

```text
src/cmd/zenproxy.ts       # 反代入口
src/cmd/status-ui.ts      # Status UI 入口（独立进程 / 端口）
src/proxy/                # 代理核心（handler / upstream / circuit / fallback / dial）
src/convert/              # 转换层（chat / responses / messages / gemini，含流式）
src/status/               # Status UI（事件采集 + HTTP 服务 + 静态前端）
e2e/                      # 端到端测试（mock zen 网关）
```
