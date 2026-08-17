/**
 * Upstream dialing: IPv6-preferred (optionally forced) DNS resolution with a
 * small TTL cache, and explicit TCP socket creation that routes through the
 * configured SOCKS5 proxy when present.
 *
 * We must own the socket: Bun's node:http/node:https ignore custom agents,
 * `createConnection` and `socket` options and silently dial the host
 * directly, so requests would egress from the box's own IP instead of the
 * rotating SOCKS5 pool (getting upstream IP-based rate limits).
 */
import dns from "node:dns";
import { connect as tcpConnect, type LookupFunction, type Socket } from "node:net";
import { socks5Connect, parseSocks5URL } from "./socks5";
import type { Config } from "../config";

export function makeLookup(cfg: Config, ttlMs: number): LookupFunction {
  const cache = new Map<string, { expires: number; addresses: dns.LookupAddress[] }>();
  const forceIPv6 = cfg.forceIPv6;

  const resolve = (hostname: string): Promise<dns.LookupAddress[]> =>
    new Promise((resolveAddr, rejectAddr) => {
      dns.lookup(hostname, { all: true, family: forceIPv6 ? 6 : 0 }, (err, addresses) => {
        if (err) rejectAddr(err);
        else resolveAddr(addresses);
      });
    });

  return (hostname, options, callback) => {
    if (options?.all) {
      resolve(hostname)
        .then((addrs) => callback(null, addrs as unknown as never))
        .catch((e) => callback(e, [] as unknown as never));
      return;
    }
    const now = Date.now();
    const hit = cache.get(hostname);
    if (hit && hit.expires > now) {
      callback(null, hit.addresses[0]?.address as string | undefined as never, hit.addresses[0]?.family as number | undefined);
      return;
    }
    resolve(hostname)
      .then((addrs) => {
        const sorted = [...addrs];
        if (!forceIPv6) sorted.sort((a, b) => Number(b.family === 6) - Number(a.family === 6));
        if (ttlMs > 0) cache.set(hostname, { expires: now + ttlMs, addresses: sorted });
        const first = sorted[0];
        callback(null, first?.address as string | undefined as never, first?.family as number | undefined);
      })
      .catch((e) => {
        cache.delete(hostname);
        callback(e, undefined as never);
      });
  };
}

export interface UpstreamSocketOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

/**
 * Open a brand-new TCP connection to the upstream, routed exactly as
 * configured: through the SOCKS5 proxy (hostname resolved by the proxy, so
 * exit IPs rotate per connection), or directly with optional IPv6-first /
 * IPv6-forced local resolution.
 */
export async function openUpstreamSocket(
  cfg: Pick<Config, "socks5" | "ipv6Prefer" | "forceIPv6" | "dnsCacheTTLMs">,
  opts: UpstreamSocketOptions,
): Promise<Socket> {
  if (cfg.socks5) {
    return socks5Connect(parseSocks5URL(cfg.socks5), { host: opts.host, port: opts.port }, opts.timeoutMs);
  }
  if (cfg.forceIPv6 || cfg.ipv6Prefer) {
    return connectWithLookup(cfg, opts);
  }
  return connectTimeout(opts.host, opts.port, opts.timeoutMs);
}

async function connectWithLookup(
  cfg: Pick<Config, "ipv6Prefer" | "forceIPv6" | "dnsCacheTTLMs">,
  opts: UpstreamSocketOptions,
): Promise<Socket> {
  const lookup = makeLookup(cfg as Config, cfg.dnsCacheTTLMs);
  const addresses = await new Promise<dns.LookupAddress[]>((resolveAddr, rejectAddr) => {
    lookup(opts.host, { all: true }, (err, addrs) => {
      if (err) rejectAddr(err);
      else resolveAddr(addrs as unknown as dns.LookupAddress[]);
    });
  });
  const forceIPv6 = cfg.forceIPv6;
  let lastErr: Error | null = null;
  for (const addr of addresses) {
    if (forceIPv6 && addr.family === 4) continue;
    if (!forceIPv6 && addr.family !== 6) continue; // prefer 6 first, v4 only after all v6 failed
    try {
      return await connectTimeout(addr.address, opts.port, opts.timeoutMs);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (forceIPv6) throw lastErr;
    }
  }
  if (!forceIPv6) {
    for (const addr of addresses) {
      if (addr.family === 6) continue;
      try {
        return await connectTimeout(addr.address, opts.port, opts.timeoutMs);
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  throw lastErr ?? new Error(`no usable address for ${opts.host}`);
}

function connectTimeout(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect({ host, port });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`dial ${host}:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}
