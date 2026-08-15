# zen-proxy

一个简单、高并发的 [opencode ai zen](https://opencode.ai/zen) 反向代理，使用 Go 编写。

- 对外暴露 **OpenAI 兼容** 接口（`/v1/chat/completions`，支持 SSE 流式；另含 `/v1/responses`、`/v1/models`、`/healthz`）
- 调用上游时可以**不带 key**（匿名调用 zen free），也可以指定 key（`ZEN_UPSTREAM_API_KEY`）
- 别人调用本反代时鉴权**可选**（`ZEN_AUTH_KEY`，留空即免鉴权）
- 可**指定反代的模型**（白名单）以及**别名映射**（alias -> 上游模型）
- 支持**socks5 代理**（socks5h 语义，域名由代理解析）
- 内置 **429 自动屏蔽 + 重试**：指数退避 + 抖动 + Retry-After 优先，连续 429 触发熔断，冷却期内不再请求上游，保护上游配额
- 高负载友好：Go 原生并发、连接池调优、可选并发上限、优雅退出、请求级日志

## 快速开始

### Docker Compose

```bash
cp .env.example .env
# 按需编辑 .env
docker compose up -d --build
```

### 直接运行

```bash
go build -o zen-proxy .
ZEN_MODELS=deepseek-v4-flash-free ./zen-proxy
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LISTEN_ADDR` | `:8080` | 监听地址 |
| `ZEN_UPSTREAM` | `https://opencode.ai/zen/v1` | 上游网关（OpenAI 兼容） |
| `ZEN_UPSTREAM_API_KEY` | 空 | 调用上游的 key；留空 = 匿名调用 zen free |
| `ZEN_SOCKS5` | 空 | socks5 代理，如 `socks5://user:pass@host:port` |
| `ZEN_IPV6_PREFER` | `true` | 域名本地解析、IPv6 优先，失败回退 IPv4；`false` = 主机名透传给代理解析 |
| `ZEN_FORCE_CHAT_COMPLETIONS` | `false` | `true` = 全部请求统一转成 Chat Completions 转发（详见下文） |
| `ZEN_MODELS` | 空 | 允许反代的模型，逗号分隔；留空 = 全部放行 |
| `ZEN_MODEL_MAP` | 空 | 别名映射，如 `v4f=deepseek-v4-flash-free` |
| `ZEN_AUTH_KEY` | 空 | 调用本反代所需的 key；留空 = 免鉴权 |
| `ZEN_RETRY_MAX` | `3` | 429 最大重试次数 |
| `ZEN_RETRY_BACKOFF_SECONDS` | `2` | 退避基数（指数增长 + 抖动） |
| `ZEN_RETRY_MAX_BACKOFF_SECONDS` | `30` | 退避上限（同时封顶 Retry-After） |
| `ZEN_CIRCUIT_FAILURES` | `5` | 连续 429 达到该次数后熔断 |
| `ZEN_CIRCUIT_COOLDOWN_SECONDS` | `30` | 熔断冷却期 |
| `ZEN_MAX_BODY_MB` | `128` | 请求体上限（MB） |
| `ZEN_UPSTREAM_TIMEOUT_SECONDS` | `600` | 非流式请求超时；`0` = 不限制 |
| `ZEN_MAX_CONCURRENCY` | `0` | 并发上限；`0` = 不限制 |
| `LOG_LEVEL` | `info` | debug / info / warn / error |

## 调用示例

```bash
# 非流式
curl http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ZEN_AUTH_KEY 若配置>' \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}]}'

# 流式
curl -N http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}],"stream":true}'

# 模型列表
curl http://localhost:8080/v1/models

# 诊断：查询代理连上游会用的 IP 与地址族（IPv4/IPv6）
curl http://localhost:8080/debug/upstream-ip
# => {"upstream":"https://opencode.ai/zen/v1","socks5":true,"ipv6_prefer":true,"ip":"2606:4700:78::90:0:140","family":"ipv6"}
```

接入 opencode / 任意 OpenAI 兼容客户端时，把 baseURL 指向 `http://<host>:8080/v1` 即可。

## 429 自动屏蔽重试

- 上游返回 `429` 时：优先按 `Retry-After` 等待，否则指数退避 + 随机抖动，最多重试 `ZEN_RETRY_MAX` 次；
- 连续 `ZEN_CIRCUIT_FAILURES` 次 429 后熔断打开：冷却期内直接返回 `429`（不再打上游），冷却结束自动半开重试；
- 重试耗尽后返回 `429`，错误体为 OpenAI 格式。

## 强制统一为 Chat Completions 转发

设置 `ZEN_FORCE_CHAT_COMPLETIONS=true` 后，所有进来的请求都会以 **Chat Completions 格式**转发到上游 `/v1/chat/completions`，返回体统一为 `chat.completion`：

- `POST /v1/chat/completions`：原样透传（不检查模型白名单/不做别名改写）；
- `POST /v1/responses`：自动转换为 Chat Completions（`instructions` → system 消息，`input` → user/assistant 消息，`max_output_tokens` → `max_tokens`，function tools 转换后透传）；
- `POST /v1/messages`（Anthropic）：`system`/`messages`/`tools`/`max_tokens` 转换为 Chat Completions 等价字段；
- 图片等非文本 content 会在转换时忽略（当前为纯文本转换）。

`false`（默认）时各端点按原生格式转发：`/v1/responses → /responses`、`/v1/messages → /messages`，此时模型白名单/别名检查对三个端点都生效。

## 怎么判断是不是 IPv6

1. **`GET /debug/upstream-ip`**（已内置）：返回上游解析后实际拨号的 `ip` 与 `family`（`ipv6`/`ipv4`），走的是与真实请求相同的 socks5 + IPv6 优先拨号路径；
2. **debug 日志**：`LOG_LEVEL=debug` 时每次新拨号打印 `dialed upstream host=... ip=[2606:...]:443`，带方括号+冒号即 IPv6；
3. **外部对照**：`getent ahosts opencode.ai`（看 AAAA 记录），或 `curl -6 -x socks5h://user:pass@host:port https://api6.ipify.org`（经代理的 IPv6 出口 IP）。

## IPv6 优先说明

`ZEN_IPV6_PREFER=true`（默认）时：上游域名由本代理本地 DNS 解析，优先使用 AAAA（IPv6）地址连接，IPv6 失败自动回退 IPv4——配合支持 IPv6 出口的 socks5 代理使用。设为 `false` 则恢复纯 socks5h 行为（主机名直接交给代理解析，不本地解析）。

## 构建与测试

```bash
go test ./...
go vet ./...
docker build -t zen-proxy .
```

## GHCR 自动构建推送

`.github/workflows/docker-publish.yml` 会在推送到 `main`（打 `latest`）、推送 `v*` 标签（`{{version}}` 等）以及手动触发时，
用 Buildx 构建 `linux/amd64,linux/arm64` 双架构镜像并推送到 `ghcr.io/<owner>/<repo>`，带 GHA 缓存。

推送 tag 示例：

```bash
git tag v0.1.0
git push origin v0.1.0
```
