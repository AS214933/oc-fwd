# 配置与环境变量

所有配置均可选，通过环境变量驱动，同一个二进制在 Docker 内外都能跑。

## 反代环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LISTEN_ADDR` | `:8080` | 监听地址 |
| `ZEN_UPSTREAM` | `https://opencode.ai/zen/v1` | 上游网关（OpenAI 兼容） |
| `ZEN_UPSTREAM_API_KEY` | 空 | 调用上游的 key；留空 = 匿名调用 zen free |
| `ZEN_SOCKS5` | 空 | socks5 代理，如 `socks5://user:pass@host:port` |
| `ZEN_IPV6_PREFER` | `true` | 本地解析域名、IPv6 优先、失败回退 IPv4；`false` = 主机名透传给代理解析 |
| `ZEN_FORCE_IPV6` | `false` | 强制只走 IPv6，绝不回退 IPv4 |
| `ZEN_ROTATE_IP` | `true` | 每请求新建上游连接（配合 socks5 随机出口）；`false` = 复用连接 |
| `ZEN_DIAL_TIMEOUT_SECONDS` | `15` | 单次上游拨号超时（含 socks5 握手 / TLS 握手）；用于高并发下快速失败、避免请求堆积 |
| `ZEN_DNS_CACHE_TTL_SECONDS` | `60` | 本地 DNS 缓存 TTL；`0` = 关闭缓存 |
| `ZEN_API_KEYS_FILE` | 空 | key 文件（一行一个）；启用「匿名失败自动回退 key」 |
| `ZEN_NO_KEY_FAIL_THRESHOLD` | `3` | 匿名 429 连续失败多少次后切 key（任意非 200 重试耗尽即切） |
| `ZEN_NO_KEY_PROBE_SECONDS` | `3` | 回退期间探测匿名恢复的间隔 |
| `ZEN_STATUS_URL` | 空 | Status UI 地址；模型状态切换（匿名↔key↔失败）会实时上报到该地址 `/api/events` |
| `ZEN_STATUS_TOKEN` | 空 | 上报到 Status UI 时携带的 bearer token（与 `STATUS_EVENT_TOKEN` 一致） |
| `ZEN_FORCE_CHAT_COMPLETIONS` | `false` | 所有请求统一转成 Chat Completions 转发 |
| `ZEN_FORCE_CHAT_INBOUND` | `false` | 只接受 `/v1/chat/completions` 入站，`/v1/responses` 与 `/v1/messages` 直接报错 |
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

Status UI 的变量见 [docs/status-ui.md](status-ui.md)。

## 调用示例

```bash
# 非流式 / 流式
curl http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ZEN_AUTH_KEY 若配置>' \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}]}'

curl -N http://localhost:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}],"stream":true}'

# 模型列表
curl http://localhost:8080/v1/models
```

接入 opencode / 任意 OpenAI 兼容客户端时，把 baseURL 指向 `http://<host>:8080/v1` 即可。
