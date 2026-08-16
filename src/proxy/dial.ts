/**
 * Upstream dialing: IPv6-preferred (optionally forced) DNS resolution with a
 * small TTL cache, and a TLS-capable socket factory that routes through the
 * configured SOCKS5 proxy when present.
 */
import dns from "node:dns";
import tls from "node:tls";
import type { LookupFunction } from "node:net";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
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

type NodeSocket = unknown;

/** Build an http/https Agent whose connections route through SOCKS5 (+TLS). */
export function makeSocks5Agent(proxyUrl: string, dialTimeoutMs: number, http: boolean): HttpAgent | HttpsAgent {
  const proxy = parseSocks5URL(proxyUrl);
  const createConnection = (
    options: { host: string; port: number; servername?: string },
    callback: (err: Error | null, socket?: NodeSocket) => void,
  ) => {
    socks5Connect(proxy, { host: options.host, port: options.port }, dialTimeoutMs)
      .then((sock) => {
        if (http) {
          callback(null, sock);
          return;
        }
        const tlsSock = tls.connect({
          socket: sock as unknown as import("node:tls").ConnectionOptions["socket"],
          servername: options.servername ?? options.host,
        });
        tlsSock.once("secureConnect", () => callback(null, tlsSock));
        tlsSock.once("error", (err) => callback(err));
      })
      .catch((err) => callback(err));
  };
  const agentOpts = {
    createConnection: createConnection as never,
    keepAlive: false,
    timeout: dialTimeoutMs,
  };
  return http ? new HttpAgent(agentOpts as never) : new HttpsAgent(agentOpts as never);
}
