/**
 * Upstream HTTP client: retries with jittered exponential backoff, honors
 * Retry-After, shields the upstream with a 429 circuit breaker, and drives
 * the per-model anonymous -> API-key fallback.
 */
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type { Logger } from "../log";
import type { Config } from "../config";
import { Circuit } from "./circuit";
import { FallbackState } from "./fallback";
import { makeLookup, makeSocks5Agent } from "./dial";

export interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
  /** Abandon the underlying connection (used when a retry replaces it). */
  destroy?: () => void;
}

export class CircuitOpenError extends Error {
  constructor() {
    super("upstream rate limit circuit is open");
    this.name = "CircuitOpenError";
  }
}

interface RawResponse {
  status: number;
  headers: Headers;
  bodyStream: Readable;
}

export class UpstreamClient {
  private socksAgents = new Map<string, http.Agent | https.Agent>();
  private keys: string[];
  private probeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private cfg: Config,
    private log: Logger,
    private fallback: FallbackState,
    private circuit: Circuit,
  ) {
    this.keys = cfg.apiKeys;
  }

  keyedModels(): string[] {
    return this.fallback.keyedModels();
  }

  modelState(model: string): string {
    return this.fallback.state(model);
  }

  requestKey(model: string): { key: string; hasKey: boolean } {
    if (this.keys.length > 0) {
      if (this.fallback.inKeyMode(model)) {
        const key = this.keys[Math.floor(Math.random() * this.keys.length)];
        return { key: key ?? "", hasKey: true };
      }
      return { key: "", hasKey: false };
    }
    if (this.cfg.upstreamAPIKey) return { key: this.cfg.upstreamAPIKey, hasKey: true };
    return { key: "", hasKey: false };
  }

  /** Run the full retry/circuit/fallback loop for one upstream call. */
  async do(path: string, body: string, stream: boolean, signal?: AbortSignal): Promise<UpstreamResponse> {
    const model = modelFromBody(body);
    let attempt = 0;
    for (;;) {
      const { key, hasKey } = this.requestKey(model);

      if (!this.circuit.allow()) {
        if (hasKey) {
          this.fallback.reportKeyedResult(model, false, "circuit open");
          throw new CircuitOpenError();
        }
        if (this.fallback.recordNoKeyFailure(model) || this.fallback.inKeyMode(model)) {
          this.circuit.reset();
          attempt = 0;
          continue;
        }
        throw new CircuitOpenError();
      }

      const retryKeyed = (): boolean => {
        if (hasKey) return false;
        if (this.fallback.forceSwitchToKey(model) || this.fallback.inKeyMode(model)) {
          this.circuit.reset();
          return true;
        }
        return false;
      };

      let resp: UpstreamResponse;
      try {
        resp = await this.rawRequest(path, body, stream, key, hasKey, signal);
      } catch (err) {
        this.log.debug("upstream attempt failed", { attempt, error: String(err) });
        const wait = this.backoff(attempt, 0);
        if (!wait.ok) {
          if (!hasKey && (this.fallback.recordNoKeyFailure(model) || this.fallback.inKeyMode(model))) {
            attempt = 0;
            continue;
          }
          this.fallback.reportKeyedResult(model, false, `network error: ${String(err)}`);
          throw err;
        }
        await sleep(wait.ms, signal);
        attempt++;
        continue;
      }

      if (resp.status === 429) {
        const ra = retryAfterSeconds(resp);
        this.circuit.recordFailure();
        resp.destroy?.();
        const wait = this.backoff(attempt, ra);
        this.log.warn("upstream returned 429", { attempt, retry_after_s: ra, wait_ms: wait.ms });
        if (!wait.ok) {
          if (!hasKey && (this.fallback.recordNoKeyFailure(model) || this.fallback.inKeyMode(model))) {
            this.circuit.reset();
            attempt = 0;
            continue;
          }
          this.fallback.reportKeyedResult(model, false, `429 after retries (retry-after ${ra}s)`);
          return rateLimitResponse(ra);
        }
        await sleep(wait.ms, signal);
        attempt++;
        continue;
      }

      if (resp.status !== 200) {
        this.log.warn("upstream returned non-200", { status: resp.status });
        const wait = this.backoff(attempt, retryAfterSeconds(resp));
        if (wait.ok) {
          resp.destroy?.();
          await sleep(wait.ms, signal);
          attempt++;
          continue;
        }
        if (retryKeyed()) {
          resp.destroy?.();
          attempt = 0;
          continue;
        }
        this.fallback.reportKeyedResult(model, false, `HTTP ${resp.status} after retries`);
        return resp;
      }

      this.circuit.recordSuccess();
      this.fallback.recordNoKeySuccess(model);
      this.fallback.reportKeyedResult(model, true, "");
      return resp;
    }
  }

  private backoff(attempt: number, retryAfter: number): { ms: number; ok: boolean } {
    if (attempt >= this.cfg.retryMax) return { ms: 0, ok: false };
    if (retryAfter > 0) {
      const d = Math.min(retryAfter * 1000, this.cfg.retryMaxBackoffMs);
      return { ms: d, ok: true };
    }
    const base = this.cfg.retryBaseBackoffMs;
    const mult = Math.pow(2, Math.min(attempt, 20));
    const jitter = Math.floor(Math.random() * (base / 2 + 1));
    return { ms: Math.min(base * mult + jitter, this.cfg.retryMaxBackoffMs), ok: true };
  }

  /** One HTTP(S) POST request to the upstream, no retries. */
  private rawRequest(
    path: string,
    body: string,
    stream: boolean,
    key: string,
    hasKey: boolean,
    signal?: AbortSignal,
  ): Promise<UpstreamResponse> {
    const url = this.cfg.upstreamBase + path;
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": "oc-fwd/2.0 (bun)",
    };
    if (hasKey) headers.Authorization = `Bearer ${key}`;

    let agent: http.Agent | https.Agent | false = undefined as never;
    let lookup: import("node:net").LookupFunction | undefined;
    if (this.cfg.socks5) {
      const cacheKey = isHttps ? "https" : "http";
      let a = this.socksAgents.get(cacheKey);
      if (!a) {
        a = makeSocks5Agent(this.cfg.socks5, this.cfg.dialTimeoutMs, !isHttps) as http.Agent;
        this.socksAgents.set(cacheKey, a);
      }
      agent = a;
    } else {
      if (this.cfg.rotateIP) {
        agent = false; // fresh TCP connection per request => rotating exit IPs
      }
      if (this.cfg.ipv6Prefer || this.cfg.forceIPv6) {
        lookup = makeLookup(this.cfg, this.cfg.dnsCacheTTLMs);
      }
    }

    const opts: http.RequestOptions = {
      method: "POST",
      headers,
      timeout: this.cfg.dialTimeoutMs,
      ...(agent !== undefined ? { agent } : {}),
      ...(lookup ? { lookup } : {}),
    };

    let controller: AbortController | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    if (!stream && this.cfg.upstreamTimeoutSet) {
      controller = new AbortController();
      timeoutTimer = setTimeout(() => controller?.abort(), this.cfg.upstreamTimeoutMs);
    }

    return new Promise<UpstreamResponse>((resolve, reject) => {
      const req = mod.request(u, opts, (res) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve({
          status: res.statusCode ?? 0,
          headers: toHeaders(res.headers),
          body: nodeToWeb(res),
          destroy: () => res.destroy(),
        });
      });
      req.on("timeout", () => req.destroy(new Error("upstream dial/request timeout")));
      req.on("error", (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        reject(err);
      });
      const onAbort = () => req.destroy(new Error("request aborted"));
      if (controller) controller.signal.addEventListener("abort", onAbort, { once: true });
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error("request aborted"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      req.end(body);
    });
  }

  /** Tiny anonymous probe used by the recovery loop. */
  async probeAnonymous(model: string, timeoutMs: number): Promise<boolean> {
    const probeModel = model || this.cfg.models[0] || "deepseek-v4-flash-free";
    const body = JSON.stringify({ model: probeModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
    const url = this.cfg.upstreamBase + "/chat/completions";
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await new Promise<{ status: number }>((resolve, reject) => {
        const req = mod.request(
          u,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "User-Agent": "oc-fwd/2.0 (bun)",
            },
            timeout: timeoutMs,
            ...(this.cfg.socks5
              ? { agent: this.makeProbeAgent(u.protocol === "https:") }
              : this.cfg.rotateIP
                ? { agent: false }
                : {}),
            ...(this.cfg.ipv6Prefer || this.cfg.forceIPv6 ? { lookup: makeLookup(this.cfg, this.cfg.dnsCacheTTLMs) } : {}),
          },
          (res) => resolve({ status: res.statusCode ?? 0 }),
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("probe timeout")));
        controller.signal.addEventListener("abort", () => req.destroy(new Error("probe aborted")), { once: true });
        req.end(body);
      });
      return resp.status >= 200 && resp.status < 300;
    } catch {
      this.log.debug("no-key probe failed", { model: probeModel });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private makeProbeAgent(isHttps: boolean): http.Agent {
    const cacheKey = isHttps ? "https" : "http";
    let a = this.socksAgents.get(cacheKey);
    if (!a) {
      a = makeSocks5Agent(this.cfg.socks5, this.cfg.dialTimeoutMs, !isHttps) as http.Agent;
      this.socksAgents.set(cacheKey, a);
    }
    return a;
  }

  startProbeLoop() {
    if (this.keys.length === 0) return;
    this.probeTimer = setInterval(async () => {
      for (const model of this.fallback.keyedModels()) {
        const ok = await this.probeAnonymous(model, this.cfg.noKeyProbeIntervalMs);
        if (ok) this.fallback.trySwitchToNoKey(model);
      }
    }, this.cfg.noKeyProbeIntervalMs);
  }

  stop() {
    if (this.probeTimer) clearInterval(this.probeTimer);
  }
}

function modelFromBody(body: string): string {
  try {
    const obj = JSON.parse(body) as { model?: unknown };
    return typeof obj.model === "string" ? obj.model : "";
  } catch {
    return "";
  }
}

function retryAfterSeconds(resp: UpstreamResponse): number {
  const v = resp.headers.get("Retry-After");
  if (v) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return 0;
}

function rateLimitResponse(retryAfter: number): UpstreamResponse {
  let msg = "Upstream rate limit exceeded after retries.";
  if (retryAfter > 0) msg += ` Retry-After: ${retryAfter}s.`;
  const body = JSON.stringify({
    error: { message: msg, type: "rate_limit_error", param: null, code: "rate_limit_exceeded" },
  });
  const headers = new Headers({ "Content-Type": "application/json" });
  if (retryAfter > 0) headers.set("Retry-After", String(retryAfter));
  return { status: 429, headers, body: new Blob([body]).stream() };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => finish(new Error("aborted"));
    function finish(err?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    }
    timer = setTimeout(() => finish(), ms);
    if (signal) {
      if (signal.aborted) {
        finish(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const x of v) h.append(k, x);
    } else {
      h.set(k, v);
    }
  }
  return h;
}

/** Convert a Node Readable into a web ReadableStream, preserving backpressure. */
function nodeToWeb(stream: Readable): ReadableStream<Uint8Array> {
  const toWeb = (Readable as unknown as { toWeb?: (s: Readable) => ReadableStream<Uint8Array> }).toWeb;
  if (typeof toWeb === "function") return toWeb(stream);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("readable", () => {
        let chunk: Buffer | null;
        while ((chunk = stream.read() as Buffer | null) !== null) {
          controller.enqueue(new Uint8Array(chunk));
          if (controller.desiredSize !== null && controller.desiredSize <= 0) break;
        }
      });
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}
