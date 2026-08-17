#!/usr/bin/env bun
/**
 * oc-fwd proxy entrypoint: OpenAI-compatible sub2api for opencode zen.
 */
import { loadConfig } from "../config";
import { Logger } from "../log";
import { Proxy } from "../proxy/handler";

function parseListen(addr: string): { hostname: string; port: number } {
  if (addr.startsWith(":")) {
    return { hostname: "0.0.0.0", port: Number(addr.slice(1)) || 8080 };
  }
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return { hostname: "0.0.0.0", port: Number(addr) || 8080 };
  return { hostname: addr.slice(0, idx) || "0.0.0.0", port: Number(addr.slice(idx + 1)) || 8080 };
}

const cfg = await loadConfig();
const log = new Logger(cfg.logLevel as never);
const proxy = new Proxy(cfg, log);
const { hostname, port } = parseListen(cfg.listen);

const server = Bun.serve({
  hostname,
  port,
  development: false,
  maxRequestBodySize: cfg.maxBodyBytes,
  // Upstream zen responses can stall for longer than Bun's default 10s idle
  // window (free-tier thinking pauses); never cut a client mid-stream.
  idleTimeout: 0,
  fetch: proxy.handler(),
});

log.info("zen-proxy listening", { hostname, port });

const shutdown = (signal: string) => {
  log.info("shutting down", { signal });
  proxy.stop();
  server.stop(true);
  setTimeout(() => process.exit(0), 100);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
