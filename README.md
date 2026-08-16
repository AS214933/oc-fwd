# zen-proxy

一个简单、高并发的 [opencode ai zen](https://opencode.ai/zen) 反向代理，使用 Go 编写。

- 对外暴露 **OpenAI 兼容**接口：`/v1/chat/completions`（支持 SSE 流式）、`/v1/responses`、`/v1/messages`、`/v1/models`、`/healthz`
- 强制 Chat Completions：`ZEN_FORCE_CHAT_COMPLETIONS` 统一把 responses/messages 转成 Chat Completions 转发（codex 可正常解析回传的 Responses 格式），`ZEN_FORCE_CHAT_INBOUND` 则强制客户端只用 `/v1/chat/completions`
- 调用上游可**匿名**（zen free）或带 key（`ZEN_UPSTREAM_API_KEY`），caller 鉴权可选（`ZEN_AUTH_KEY`）
- 支持模型白名单与别名映射（`ZEN_MODELS` / `ZEN_MODEL_MAP`）
- 支持 **socks5** 代理，默认 **IPv6 优先**（可强制只走 IPv6）
- 内置 **429 自动重试 + 熔断**（退避 + 抖动 + Retry-After），上游非 200（400/503 等）一律走重试与「匿名失败自动回退 API key」，错误不会漏给用户
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

## 文档

| 主题 | 链接 |
| --- | --- |
| 配置与环境变量、调用示例 | [docs/configuration.md](docs/configuration.md) |
| socks5、IPv6 与高并发 | [docs/networking.md](docs/networking.md) |
| 重试、熔断与匿名回退 API Key | [docs/retry-and-fallback.md](docs/retry-and-fallback.md) |
| 强制统一为 Chat Completions 转发 | [docs/conversion.md](docs/conversion.md) |
| 状态页 Status UI | [docs/status-ui.md](docs/status-ui.md) |

## 项目结构

```text
cmd/zenproxy/            # 反代入口
cmd/status-ui/           # Status UI 入口（独立进程 / 端口，嵌入静态前端）
 status/                  # Status UI：配置、事件采集器、HTTP 服务与前端资源
internal/config/         # 配置与环境变量解析
internal/circuit/        # 429 熔断器
internal/proxy/          # 代理核心（proxy/handler/dial/convert/upstream/stream）
```

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
