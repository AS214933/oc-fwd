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
go build -o zen-proxy ./cmd/zenproxy
ZEN_MODELS=deepseek-v4-flash-free ./zen-proxy
```

## 项目结构

```text
cmd/zenproxy/            # 入口：加载配置、启动 HTTP 服务
internal/config/         # 配置与环境变量解析
internal/circuit/        # 429 熔断器
internal/proxy/          # 代理核心
  ├── proxy.go           #   Proxy 结构、构造、路由、鉴权、日志中间件
  ├── handler.go         #   /v1/chat|responses|messages 请求处理
  ├── dial.go            #   socks5 + IPv6 优先/强制拨号、/debug/upstream-ip
  ├── convert.go         #   统一转 Chat Completions（responses/messages）
  ├── upstream.go        #   上游请求、429 重试/退避
  └── stream.go          #   SSE 流式转发与 model 改写
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LISTEN_ADDR` | `:8080` | 监听地址 |
| `ZEN_UPSTREAM` | `https://opencode.ai/zen/v1` | 上游网关（OpenAI 兼容） |
| `ZEN_UPSTREAM_API_KEY` | 空 | 调用上游的 key；留空 = 匿名调用 zen free |
| `ZEN_SOCKS5` | 空 | socks5 代理，如 `socks5://user:pass@host:port` |
| `ZEN_IPV6_PREFER` | `true` | 域名本地解析、IPv6 优先，失败回退 IPv4；`false` = 主机名透传给代理解析 |
| `ZEN_FORCE_IPV6` | `false` | `true` = 强制只走 IPv6，绝不回退 IPv4；目标无 AAAA / 拨号失败直接报错（详见下文） |
| `ZEN_ROTATE_IP` | `true` | 每请求新建一条到上游的 TCP 连接（禁用连接池）；`false` = 复用连接（更快，节省握手开销） |
| `ZEN_API_KEYS_FILE` | 空 | API key 文件（一行一个）；配置后启用“匿名失败自动回退带 key 请求”（按模型独立、key 随机抽取） |
| `ZEN_NO_KEY_FAIL_THRESHOLD` | `3` | 匿名请求连续失败多少次后切换到 API key |
| `ZEN_NO_KEY_PROBE_SECONDS` | `3` | 回退期间每多少秒探测一次匿名请求是否恢复 |
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

`ZEN_FORCE_IPV6=true` 时进一步收紧：只要有 AAAA 记录就只尝试 IPv6，IPv6 拨号失败**不会**回退 IPv4（目标只有 IPv4 或 DNS 失败时直接报错）。适合确认上游确实经由 socks5 的 IPv6 出口出网、排查“以为走了 IPv6 其实回退了 IPv4”的情况。`/debug/upstream-ip` 会同时返回 `ipv6_prefer` 与 `ipv6_force` 两个字段。

判断每次连接是否真的走了 socks5 + IPv6：开启 `LOG_LEVEL=debug` 后每次上游拨号都会打印
`dialed upstream ... ip=[2606:...]:443 family=ipv6`，带方括号+冒号的即 IPv6；也可用 `/debug/upstream-ip` 直接看 `family` 字段。

## 429 与连接复用说明

上游返回 `429` 时的处理完全由本代理的重试/熔断策略负责（见上文「429 自动屏蔽重试」），代理不会、也无法通过更换出口 IP 等方式规避上游限流。

`ZEN_ROTATE_IP=true`（默认）只是让每个请求都新建一条到上游的 TCP 连接（禁用 keep-alive、强制 HTTP/1.1），避免请求长时间复用同一条连接。这与 429 没有必然关系；是否需要注意连接复用，取决于你使用的上游与实际网络出口的具体策略。

代价是每次请求都要重新 TCP+TLS 握手，单请求延迟略增；追求吞吐可设 `false` 复用连接。

## 匿名失败自动回退 API Key

设置 `ZEN_API_KEYS_FILE=/path/to/keys`（文件里一行一个 key，`#` 开头为注释）后启用：

1. **默认匿名**请求（不带 key，例如 zen free）；
2. **每个模型独立回退**：匿名请求**连续失败** `ZEN_NO_KEY_FAIL_THRESHOLD` 次（默认 3，指 429 / 5xx / 网络错误）后，只有该模型自动切换到 API key 模式，其他模型继续匿名调用——例如模型 A 被 429 时只有 A 改走 key，模型 B 不受影响；
3. 带 key 的请求每次从 key 文件里**随机抽一个** key 使用（均匀随机，避免固定轮换导致单个 key 被打满）；
4. 触发切换的**那个请求会在同一次请求内用 key 自动重试**，用户端不会收到错误，只感知到变慢；
5. 回退期间每 `ZEN_NO_KEY_PROBE_SECONDS` 秒（默认 3）对**每个处于回退中的模型**发一次**无 key 探测请求**；该模型匿名恢复（返回 2xx）就单独切回匿名模式，其余模型保持 key 模式；
6. 所有请求（包括探测与带 key 的请求）都走配置的 socks5 代理（若 `ZEN_SOCKS5` 已设置）。

回退状态按**实际发给上游的模型**区分（`ZEN_MODEL_MAP` 别名会先解析为上游模型 id），不同模型互不影响。

熔断器与回退联动：熔断打开时也会计入匿名失败，确保持续 429 时仍能触发回退；切换模式时熔断计数清零，新模式重新累计。

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
