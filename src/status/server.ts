/**
 * Status UI HTTP server. Serves the static frontend plus the event ingest
 * (POST /api/events) and the JSON snapshot (GET /api/status).
 */
import { Logger } from "../log";
import { Checker, type StateEvent } from "./checker";
import { JsonStore, defaultStoreFile } from "./store";

export interface StatusUIConfig {
  listen: string;
  proxy: string;
  proxyAuth: string;
  eventToken: string;
  intervalMs: number;
  timeoutMs: number;
  history: number;
  storeFile: string;
}

export function loadStatusConfig(env: NodeJS.ProcessEnv = process.env): StatusUIConfig {
  const listen = env.STATUS_LISTEN_ADDR || ":8090";
  const interval = Number(env.STATUS_INTERVAL || "15");
  const timeout = Number(env.STATUS_TIMEOUT || "30");
  const history = Number(env.STATUS_HISTORY || "120");
  const storeFile = env.STATUS_DB || defaultStoreFile();
  if (!listen) throw new Error("STATUS_LISTEN_ADDR cannot be empty");
  if (!storeFile) throw new Error("STATUS_DB cannot be empty when set");
  if (!env.STATUS_PROXY) throw new Error("STATUS_PROXY cannot be empty");
  if (!(interval > 0)) throw new Error("invalid STATUS_INTERVAL: must be > 0");
  if (!(timeout > 0)) throw new Error("invalid STATUS_TIMEOUT: must be > 0");
  if (!(history >= 1)) throw new Error("invalid STATUS_HISTORY: must be >= 1");
  return {
    listen,
    proxy: (env.STATUS_PROXY || "").replace(/\/+$/, ""),
    proxyAuth: env.STATUS_PROXY_AUTH || "",
    eventToken: env.STATUS_EVENT_TOKEN || "",
    intervalMs: interval * 1000,
    timeoutMs: timeout * 1000,
    history,
    storeFile,
  };
}

function parseListen(addr: string): { hostname: string; port: number } {
  if (addr.startsWith(":")) return { hostname: "0.0.0.0", port: Number(addr.slice(1)) || 8090 };
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return { hostname: "0.0.0.0", port: Number(addr) || 8090 };
  return { hostname: addr.slice(0, idx) || "0.0.0.0", port: Number(addr.slice(idx + 1)) || 8090 };
}

export function startStatusUI(cfg: StatusUIConfig, log: Logger) {
  const store = new JsonStore(cfg.storeFile);
  const checker = new Checker(log, {
    proxyUrl: cfg.proxy,
    proxyAuth: cfg.proxyAuth,
    eventToken: cfg.eventToken,
    intervalMs: cfg.intervalMs,
    timeoutMs: cfg.timeoutMs,
    history: cfg.history,
    store,
  });
  void checker.restoreDraft().then(() => {
    checker.start();
    log.info("status-ui history store ready", { file: cfg.storeFile });
  });

  const assetsDir = new URL("../status/assets/", import.meta.url).pathname;

  const server = Bun.serve({
    ...parseListen(cfg.listen),
    development: false,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === "POST" && path === "/api/events") {
        if (cfg.eventToken) {
          const auth = req.headers.get("Authorization") ?? "";
          const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
          if (got !== cfg.eventToken) return new Response("unauthorized", { status: 401 });
        }
        try {
          const ev = (await req.json()) as StateEvent;
          checker.ingest(ev);
          return new Response(null, { status: 204 });
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }
      if (req.method === "GET" && path === "/api/status") {
        return new Response(JSON.stringify(checker.snapshot()), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      if (req.method === "GET" && path === "/healthz") {
        return new Response("ok", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      if (req.method === "GET" && (path === "/" || path.startsWith("/assets/"))) {
        const file = path === "/" ? "index.html" : path.slice("/assets/".length);
        const full = `${assetsDir}/${file}`;
        const f = Bun.file(full);
        if (await f.exists()) {
          return new Response(f, { headers: contentType(file) });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  log.info("status-ui listening", { hostname: parseListen(cfg.listen).hostname, port: parseListen(cfg.listen).port });
  return { server, checker };
}

function contentType(file: string): Record<string, string> {
  if (file.endsWith(".html")) return { "Content-Type": "text/html; charset=utf-8" };
  if (file.endsWith(".js")) return { "Content-Type": "application/javascript" };
  if (file.endsWith(".css")) return { "Content-Type": "text/css; charset=utf-8" };
  return { "Content-Type": "application/octet-stream" };
}
