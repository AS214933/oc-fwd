# zen-proxy

一个简单、高并发的 [opencode ai zen](https://opencode.ai/zen) 反向代理，使用 Go 编写。

- 对外暴露 **OpenAI 兼容**接口：`/v1/chat/completions`（支持 SSE 流式）、`/v1/responses`、`/v1/messages`、`/v1/models`、`/healthz`
- 调用上游可**匿名**（zen free）或带 key（`ZEN_UPSTREAM_API_KEY`），caller 鉴权可选（`ZEN_AUTH_KEY`）
- 支持模型白名单与别名映射（`ZEN_MODELS` / `ZEN_MODEL_MAP`）
- 支持 **socks5** 代理，默认 **IPv6 优先**（可强制只走 IPv6）
- 内置 **429 自动重试 + 熔断**（退避 + 抖动 + Retry-After），可选「匿名失败自动回退 API key」
- 附赠独立的 **Status UI** 状态页：模型每次 匿名 / API Key / 全部失败 切换都会实时上报展示

## 快速开始

### Docker Compose

```bash
cp .env.example .env
docker compose up -d --build   # 反代 :8080 + Status UI :8090
```

### 直接运行

```bash
go build -o zen-proxy ./cmd/zenproxy
ZEN_MODELS=deepseek-v4-flash-free ./zen-proxy
```

## 项目结构

```text
cmd/zenproxy/            # 反代入口
cmd/status-ui/           # Status UI 入口（独立进程 / 端口，嵌入静态前端）
 status/                  # Status UI：配置、事件采集器、HTTP 服务与前端资源
internal/config/         # 配置与环境变量解析
internal/circuit/        # 429 熔断器
internal/proxy/          # 代理核心（proxy/handler/dial/convert/upstream/stream）
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LISTEN_ADDR` | `:8080` | 监听地址 |
| `ZEN_UPSTREAM` | `https://opencode.ai/zen/v1` | 上游网关（OpenAI 兼容） |
| `ZEN_UPSTREAM_API_KEY` | 空 | 调用上游的 key；留空 = 匿名调用 zen free |
| `ZEN_SOCKS5` | 空 | socks5 代理，如 `socks5://user:pass@host:port` |
| `ZEN_IPV6_PREFER` | `true` | 本地解析域名、IPv6 优先、失败回退 IPv4；`false` = 主机名透传给代理解析 |
| `ZEN_FORCE_IPV6` | `false` | 强制只走 IPv6，绝不回退 IPv4 |
| `ZEN_ROTATE_IP` | `true` | 每请求新建上游连接（配合 socks5 随机出口）；`false` = 复用连接 |
| `ZEN_API_KEYS_FILE` | 空 | key 文件（一行一个）；启用「匿名失败自动回退 key」 |
| `ZEN_NO_KEY_FAIL_THRESHOLD` | `3` | 匿名 429 连续失败多少次后切 key（5xx 重试耗尽即切） |
| `ZEN_NO_KEY_PROBE_SECONDS` | `3` | 回退期间探测匿名恢复的间隔 |
| `ZEN_STATUS_URL` | 空 | Status UI 地址；模型状态切换（匿名↔key↔失败）会实时上报到该地址 `/api/events` |
| `ZEN_STATUS_TOKEN` | 空 | 上报到 Status UI 时携带的 bearer token（与 `STATUS_EVENT_TOKEN` 一致） |
| `ZEN_FORCE_CHAT_COMPLETIONS` | `false` | 所有请求统一转成 Chat Completions 转发 |
| `ZEN_MODELS` | 空 | 允许反代的模型，逗号分隔；留空 = 全部放行 |
| `ZEN_MODEL_MAP` | 空 | 别名映射，如 `v4f=deepseek-v4-flash-free` |
| `ZEN_AUTH_KEY` | 空 | 调用本反代需带的 key；留空 = 免鉴权 |
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
# 非流式 / 流式
curl http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ZEN_AUTH_KEY 若配置>' \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}]}'

curl -N http://localhost:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}],"stream":true}'

# 模型列表 / 上游 IP 诊断
curl http://localhost:8080/v1/models
curl http://localhost:8080/debug/upstream-ip
# => {"socks5":true,"ipv6_prefer":true,"ip":"2606:4700:78::90:0:140","family":"ipv6"}
```

接入 opencode / 任意 OpenAI 兼容客户端时，把 baseURL 指向 `http://<host>:8080/v1` 即可。

## 429 自动屏蔽重试

- 429 优先按 `Retry-After` 等待，否则指数退避 + 抖动，最多重试 `ZEN_RETRY_MAX` 次；
- 连续 `ZEN_CIRCUIT_FAILURES` 次 429 后熔断：冷却期内直接返回 429，冷却结束半开重试；
- 重试耗尽返回 OpenAI 格式的 429 错误体。

## 强制统一为 Chat Completions 转发

`ZEN_FORCE_CHAT_COMPLETIONS=true` 时，所有请求统一转成 Chat Completions 转发到上游 `/v1/chat/completions`：

- `/v1/chat/completions`：原样透传（不查白名单 / 不改写）；
- `/v1/responses`：请求转 Chat Completions（`instructions`→system、`input`→user/assistant、`max_output_tokens`→`max_tokens`、tools 转换），**响应再转回 Responses 格式**（非流式 `response` 对象，流式 `response.created` / `response.output_text.delta` / `response.completed` 等事件），codex / opencode 等 `/v1/responses` 客户端可正常解析；
- 工具调用双向转换：`function_call` → `tool_calls` assistant 消息、`function_call_output` → `role=tool`，`call_id` 原样保留；
- `/v1/messages`（Anthropic）：`system` / `messages` / `tools` / `max_tokens` 转换后转发；
- 图片等非文本 content 目前会被忽略（纯文本转换）。

`false`（默认）时各端点按原生格式转发（`/v1/responses → /responses`、`/v1/messages → /messages`），模型白名单 / 别名对三个端点均生效。

## socks5 与 IPv6

- 默认（`ZEN_IPV6_PREFER=true`）：本地 DNS 解析上游域名，IPv6（AAAA）优先，失败回退 IPv4；设 `false` 恢复纯 socks5h（主机名交给代理解析）。
- `ZEN_FORCE_IPV6=true`：有 AAAA 就只走 IPv6、绝不回退 IPv4，用于确认确实经由 socks5 的 IPv6 出口。
- `ZEN_ROTATE_IP=true`（默认）：每请求新建一条上游连接并禁用复用 / HTTP/2，配合支持随机 IPv6 出口的 socks5 使用；追求吞吐可设 `false` 复用连接。429 的处理只由本代理的重试 / 熔断负责，不会靠换出口 IP 规避限流。
- 判断每次连接是否真的走了 IPv6：
  1. `GET /debug/upstream-ip` 返回实际拨号的 `ip` 与 `family`（`ipv6` / `ipv4`），走与真实请求相同的拨号路径；
  2. `LOG_LEVEL=debug` 时每次拨号打印 `dialed upstream host=... ip=[2606:...]:443 family=ipv6`，带方括号 + 冒号即 IPv6。

## 匿名失败自动回退 API Key

配置 `ZEN_API_KEYS_FILE`（文件一行一个 key，`#` 开头为注释）后启用，按上游模型独立工作：

1. 默认匿名调用；匿名 429 / 网络错误连续 `ZEN_NO_KEY_FAIL_THRESHOLD` 次后该模型切 key，5xx 重试耗尽立即切 key——触发切换的请求会在同一次请求内用 key 透明重试（并发在途请求同样会被兜底），不会把 429 / 5xx 漏给用户；
2. 带 key 请求从 key 文件**随机抽一个** key（均匀随机，避免固定轮换打满单个 key）；
3. 回退期间每 `ZEN_NO_KEY_PROBE_SECONDS` 秒对该模型发无 key 探测，恢复（2xx）即单独切回匿名；
4. 每个请求最多做一轮透明 key 重试，带 key 仍失败即返回错误，不无限重试；熔断打开也计为匿名失败，切模式时熔断计数清零。

## 状态页 Status UI

Status UI 关注的是**各模型的切换情况**：当且仅当某模型在状态之间切换时，反代会**主动上报**一条状态变更事件，页面实时展示——反映的是项目实际发生的切换历史，而不是从外部探测猜测。

- 配置 `ZEN_STATUS_URL` 后，反代在以下时机上报（异步、不阻塞请求、不影响反代功能）：
  - 匿名请求连续失败达到阈值 → 模型切到 **keyed**（API Key）；
  - 上游 5xx 重试耗尽 → 模型切到 **keyed**；
  - keyed 请求失败 → 模型变 **keyed_failed**（全部失败），key 恢复后再切回；
  - 匿名探测恢复 → 模型切回 **anonymous**。
- **绿色** = 匿名模式运行中；**蓝色** = 已切换 API Key（匿名失败，降级）；**红色** = key 也失败（全部失败）。
- 页面展示每个模型的当前状态、持续时长、累计切换次数、最近原因，以及完整切换时间线（旧状态 → 新状态 + 原因）。
- Status UI 定期拉取反代的 `/debug/modes` 校准：即使 UI 重启或某次上报丢失，页面也能与反代当前真实状态对齐。
- **401 说明**：反代配了 `ZEN_AUTH_KEY` 时，校准请求也需要凭证。两种方式任选其一：
  - 给 Status UI 配 `STATUS_PROXY_AUTH=<同一个 ZEN_AUTH_KEY>`（Docker Compose 会自动从 `.env` 同步）；
  - 或给反代配 `ZEN_STATUS_TOKEN`、给 Status UI 配 `STATUS_EVENT_TOKEN=<同一个值>`（校准请求用 `X-Status-Token` 访问 `/debug/modes`）。

### 运行

```bash
# 若反代配了 ZEN_AUTH_KEY，STATUS_PROXY_AUTH 填同一个值，否则校准会 401
STATUS_PROXY=http://127.0.0.1:8080 STATUS_PROXY_AUTH=<反代的 ZEN_AUTH_KEY> go run ./cmd/status-ui
# 让反代把模型切换上报到这个状态页
ZEN_STATUS_URL=http://127.0.0.1:8090 ./zen-proxy
```

Docker Compose 已内置 `status-ui` 服务（`http://<host>:8090`），在 `.env` 配置 `STATUS_*` 即可。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `STATUS_LISTEN_ADDR` | `:8090` | 监听地址 |
| `STATUS_PROXY` | `http://127.0.0.1:8080` | 反代基础地址（用于校准 `/debug/modes`） |
| `STATUS_PROXY_AUTH` | 空 | 反代若配了 `ZEN_AUTH_KEY`，填同一个值让校准请求通过鉴权 |
| `STATUS_EVENT_TOKEN` | 空 | 上报接口 `/api/events` 的 bearer token（与反代 `ZEN_STATUS_TOKEN` 一致） |
| `STATUS_INTERVAL` | `15` | 与反代校准的间隔（秒） |
| `STATUS_TIMEOUT` | `30` | 单次校准请求超时（秒） |
| `STATUS_HISTORY` | `120` | 保留的切换事件条数（时间线） |

### HTTP 接口

- `GET /`：状态页（零依赖原生 HTML / CSS / JS）
- `POST /api/events`：反代上报模型状态变更（body 为一个 `StateEvent` JSON：`type` / `model` / `from` / `to` / `reason` / `detail` / `at`）
- `GET /api/status`：JSON 快照（总状态、每模型当前状态、累计切换、时间线），前端每 5 秒轮询

## 构建与测试

```bash
go test ./...
go vet ./...
docker build -t zen-proxy .
```

## GHCR 自动构建推送

推送到 `main` 自动构建 `latest`，推送 `v*` 标签构建对应版本，手动触发亦可；Buildx 构建 `linux/amd64,linux/arm64` 双架构镜像并推送到 `ghcr.io/<owner>/<repo>`。

```bash
git tag v0.1.0
git push origin v0.1.0
```
