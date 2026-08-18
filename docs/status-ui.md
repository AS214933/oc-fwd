# 状态页 Status UI

Status UI 关注的是**各模型的切换情况**：当且仅当某模型在状态之间切换时，反代会**主动上报**一条状态变更事件，页面实时展示——反映的是项目实际发生的切换历史，而不是从外部探测猜测。

## 工作原理

- 配置 `ZEN_STATUS_URL` 后，反代在以下时机上报（异步、不阻塞请求、不影响反代功能）：
  - 匿名请求连续失败达到阈值 → 模型切到 **keyed**（API Key）；
  - 上游 5xx 重试耗尽 → 模型切到 **keyed**；
  - keyed 请求失败 → 模型变 **keyed_failed**（全部失败），key 恢复后再切回；
  - 匿名探测恢复 → 模型切回 **anonymous**。
- **绿色** = 匿名模式运行中；**蓝色** = 已切换 API Key（匿名失败，降级）；**红色** = key 也失败（全部失败）。
- 页面展示每个模型的当前状态、持续时长、累计切换次数、最近原因，以及完整切换时间线（旧状态 → 新状态 + 原因）。
- 时间线和模型状态会**落盘持久化**（`STATUS_DB`，默认 `./data/status.json`）：Status UI 重启后自动恢复最近 24h 记录，不丢历史。
- Status UI 定期拉取反代的 `/debug/modes` 校准：即使 UI 重启或某次上报丢失，页面也能与反代当前真实状态对齐。
- **401 说明**：反代配了 `ZEN_AUTH_KEY` 时，校准请求也需要凭证。两种方式任选其一：
  - 给 Status UI 配 `STATUS_PROXY_AUTH=<同一个 ZEN_AUTH_KEY>`（Docker Compose 会自动从 `.env` 同步）；
  - 或给反代配 `ZEN_STATUS_TOKEN`、给 Status UI 配 `STATUS_EVENT_TOKEN=<同一个值>`（校准请求用 `X-Status-Token` 访问 `/debug/modes`）。

## 运行

```bash
# 若反代配了 ZEN_AUTH_KEY，STATUS_PROXY_AUTH 填同一个值，否则校准会 401
STATUS_PROXY=http://127.0.0.1:8080 STATUS_PROXY_AUTH=<反代的 ZEN_AUTH_KEY> bun run src/cmd/status-ui.ts
# 让反代把模型切换上报到这个状态页
ZEN_STATUS_URL=http://127.0.0.1:8090 bun run src/cmd/zenproxy.ts
```

Docker Compose 已内置 `status-ui` 服务（`http://<host>:8090`），在 `.env` 配置 `STATUS_*` 即可；
Compose 会把 `status-ui-data` volume 挂到 `/data`，Status UI 重启后历史记录仍在。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `STATUS_LISTEN_ADDR` | `:8090` | 监听地址 |
| `STATUS_PROXY` | `http://127.0.0.1:8080` | 反代基础地址（用于校准 `/debug/modes`） |
| `STATUS_PROXY_AUTH` | 空 | 反代若配了 `ZEN_AUTH_KEY`，填同一个值让校准请求通过鉴权 |
| `STATUS_EVENT_TOKEN` | 空 | 上报接口 `/api/events` 的 bearer token（与反代 `ZEN_STATUS_TOKEN` 一致） |
| `STATUS_INTERVAL` | `15` | 与反代校准的间隔（秒） |
| `STATUS_TIMEOUT` | `30` | 单次校准请求超时（秒） |
| `STATUS_HISTORY` | `120` | 保留的切换事件条数（时间线） |
| `STATUS_DB` | `./data/status.json` | 落盘持久化文件路径（Docker 固定 `/data/status.json`，挂 volume 重启不丢） |

## HTTP 接口

- `GET /`：状态页（零依赖原生 HTML / CSS / JS）
- `POST /api/events`：反代上报模型状态变更（body 为一个 `StateEvent` JSON：`type` / `model` / `from` / `to` / `reason` / `detail` / `at`）
- `GET /api/status`：JSON 快照（总状态、每模型当前状态、累计切换、时间线），前端每 5 秒轮询
