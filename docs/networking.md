# socks5、IPv6 与高并发

## 拨号策略

- 默认（`ZEN_IPV6_PREFER=true`）：本地 DNS 解析上游域名，IPv6（AAAA）优先，失败回退 IPv4；设 `false` 恢复纯 socks5h（主机名交给代理解析）。
- `ZEN_FORCE_IPV6=true`：有 AAAA 就只走 IPv6、绝不回退 IPv4，用于确认确实经由 socks5 的 IPv6 出口。
- `ZEN_ROTATE_IP=true`（默认）：每请求新建一条上游连接并禁用复用 / HTTP/2，配合支持随机 IPv6 出口的 socks5 使用；追求吞吐可设 `false` 复用连接。429 的处理只由本代理的重试 / 熔断负责，不会靠换出口 IP 规避限流。

## 高并发下如何保持「每请求新连接」又不慢

`ZEN_ROTATE_IP=true` 时**不复用 socks5 连接**，而是把每次新建连接的固定成本压下去：

- **拼接式 socks5 握手**：greeting / 鉴权 / CONNECT 一次写完，少等 2~3 个 RTT（对比逐段协商），同时拨号受 context 与 `ZEN_DIAL_TIMEOUT_SECONDS` 限制，代理无响应时快速失败而不是让请求堆积；
- **TCP_NODELAY**：socks5 隧道与直连 socket 建立后即关闭 Nagle 聚合，流式响应里每个小 segment（一个 token / 一个 SSE 事件）立即发出，不攒包；
- **TLS 会话复用**：同一上游的 TLS ticket 在进程内缓存，新 TCP 连接握手从完整握手降为 1 个 RTT（TLS 1.3 下用 session ticket / PSK）。ticket 跟上游服务器绑定、与客户端出口 IP 无关，所以**换出口 IP 不影响复用**；socks5 连接本身依然每次新建、绝不复用；
- **本地 DNS 缓存**：`ZEN_IPV6_PREFER=true` 时高并发下大量相同域名解析会被去重合并（multi-flight 合并 + TTL），TTL 由 `ZEN_DNS_CACHE_TTL_SECONDS` 控制；
- **轻量并发控制**：回退状态读取与随机 key 选择均为无锁 / 轻锁路径，避免热路径争用。

## 流式响应快路径（chat→chat 直通）

- 上游协议与客户端协议都是 Chat Completions、且不需要模型别名重写时，流式响应**不再解析 / 重建 SSE**：上游 `data:` 事件原样转发，仅在需要时补 `data: [DONE]`（上游流中断时兜底补发）。除 DeepSeek 外的 chat 模型走这条路径；DeepSeek 流会经过轻量解析，以短暂保存 thinking 模式工具调用所需的 `reasoning_content`。
- 有协议转换（例如入站 `/v1/responses` → 上游 `/v1/chat/completions`、或出站 gemini / messages）时，仍走解析 → 规范化 ChatChunk → 重编码管线，但 `readSSE` 已改为滑动窗口消费，避免高吞吐下逐行 `slice` 的 O(n²) 拷贝。

## 判断每次连接是否真的走了 IPv6

1. `GET /debug/upstream-ip` 返回实际拨号的 `ip` 与 `family`（`ipv6` / `ipv4`），走与真实请求相同的拨号路径：

   ```bash
   curl http://localhost:8080/debug/upstream-ip
   # => {"socks5":true,"ipv6_prefer":true,"ip":"2606:4700:78::90:0:140","family":"ipv6"}
   ```

2. `LOG_LEVEL=debug` 时每次拨号打印 `dialed upstream host=... ip=[2606:...]:443 family=ipv6`，带方括号 + 冒号即 IPv6。

## 链路延迟拆解（为什么这些优化让 token 变快）

首 token 延迟 = 建连 + 握手 + 请求上行 + 首 token 下行，逐 token 延迟受下游小包发送时机影响：

- **首 token 更快**：TLS 会话复用把完整握手（1 个 RTT）省成恢复握手（同样 1 个 RTT 但省去证书交换/DHE 的 2~3 个乘法计算 + 大消息交换），真实公网下约省 30~200ms；`TCP_NODELAY` 让每个 SSE 事件立即离开内核，避免 Nagle 等待 ACK 把 40 字节的 token 包压住 40ms。
- **整体吞吐更高**：chat→chat 直通把"每个 chunk 的 JSON 解析 + 规范化对象分配 + 重新 stringify"整个移除，CPU 从 O(chunk) 分配降到接近零拷贝转发；协议转换路径的 `readSSE` 线性化消除了高吞吐下逐行 `slice` 的二次方拷贝。
- **随机 socks5 出口不受影响**：连接仍每分钟/每请求新建新建，只是复用与出口 IP 无关的 TLS 凭据。
