# socks5、IPv6 与高并发

## 拨号策略

- 默认（`ZEN_IPV6_PREFER=true`）：本地 DNS 解析上游域名，IPv6（AAAA）优先，失败回退 IPv4；设 `false` 恢复纯 socks5h（主机名交给代理解析）。
- `ZEN_FORCE_IPV6=true`：有 AAAA 就只走 IPv6、绝不回退 IPv4，用于确认确实经由 socks5 的 IPv6 出口。
- `ZEN_ROTATE_IP=true`（默认）：每请求新建一条上游连接并禁用复用 / HTTP/2，配合支持随机 IPv6 出口的 socks5 使用；追求吞吐可设 `false` 复用连接。429 的处理只由本代理的重试 / 熔断负责，不会靠换出口 IP 规避限流。

## 高并发下如何保持「每请求新连接」又不慢

`ZEN_ROTATE_IP=true` 时**不复用 socks5 连接**，而是把每次新建连接的固定成本压下去：

- **拼接式 socks5 握手**：greeting / 鉴权 / CONNECT 一次写完，少等 2~3 个 RTT（对比逐段协商），同时拨号受 context 与 `ZEN_DIAL_TIMEOUT_SECONDS` 限制，代理无响应时快速失败而不是让请求堆积；
- **TLS 会话复用**：同一上游的 TLS ticket 在进程内缓存，新 TCP 连接握手从完整握手降为 1 个 RTT。ticket 跟上游服务器绑定、与客户端出口 IP 无关，所以换出口 IP 不影响复用；socks5 连接本身依然每次新建、绝不复用；
- **本地 DNS 缓存**：`ZEN_IPV6_PREFER=true` 时高并发下大量相同域名解析会被去重合并（single-flight + TTL），TTL 由 `ZEN_DNS_CACHE_TTL_SECONDS` 控制；
- **减少热路径锁**：回退状态的读取走 RWMutex 读锁，随机 key 选择改作并发安全的全局随机，不再争用每请求互斥锁。

## 判断每次连接是否真的走了 IPv6

1. `GET /debug/upstream-ip` 返回实际拨号的 `ip` 与 `family`（`ipv6` / `ipv4`），走与真实请求相同的拨号路径：

   ```bash
   curl http://localhost:8080/debug/upstream-ip
   # => {"socks5":true,"ipv6_prefer":true,"ip":"2606:4700:78::90:0:140","family":"ipv6"}
   ```

2. `LOG_LEVEL=debug` 时每次拨号打印 `dialed upstream host=... ip=[2606:...]:443 family=ipv6`，带方括号 + 冒号即 IPv6。
