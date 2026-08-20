/**
 * Upstream HTTP client: retries with jittered exponential backoff, honors
 * Retry-After, shields the upstream with a 429 circuit breaker, and drives
 * the per-model anonymous -> API-key fallback.
 */
import { Readable } from "node:stream";
import type { Logger } from "../log";
import type { Config } from "../config";
import { Circuit } from "./circuit";
import { FallbackState } from "./fallback";
import { openUpstreamSocket } from "./dial";
import { buildRequest, http1Request } from "./http1";

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

  knownModels(): string[] {
    return this.fallback.knownModels();
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

      if (attempt === 0 && !this.circuit.allow()) {
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
        const summary = await summarizeUpstreamError(resp);
        this.log.warn("upstream returned non-200", {
          status: resp.status,
          model,
          error_type: summary.type,
          error_code: summary.code,
          error_message: summary.message,
          body: summary.body,
        });
        if (summary.passthrough) {
          resp.destroy?.();
          this.log.info("upstream returned a non-retryable request error, passing through", {
            status: resp.status,
            model,
            error_type: summary.type,
            error_message: summary.message,
          });
          return resp;
        }
        // Fail fast to API-key mode: the first non-2xx (other than a 429
        // rate limit, which the backoff ladder handles) switches this model
        // so every later request goes straight to the keyed path instead of
        // burning the full retry ladder anonymously first.
        if (!hasKey && retryKeyed()) {
          resp.destroy?.();
          attempt = 0;
          continue;
        }
        const wait = this.backoff(attempt, retryAfterSeconds(resp));
        if (wait.ok) {
          resp.destroy?.();
          await sleep(wait.ms, signal);
          attempt++;
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
    const port = u.port ? Number(u.port) : isHttps ? 443 : 80;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": "oc-fwd/2.0 (bun)",
      Connection: "close",
    };
    if (hasKey) headers.Authorization = `Bearer ${key}`;

    const request = buildRequest("POST", u.pathname + u.search, u.host, headers, body);
    return openUpstreamSocket(this.cfg, { host: u.hostname, port, timeoutMs: this.cfg.dialTimeoutMs }).then((tcp) =>
      http1Request({
        tcp,
        tls: isHttps,
        servername: u.hostname,
        request,
        totalTimeoutMs: !stream && this.cfg.upstreamTimeoutSet ? this.cfg.upstreamTimeoutMs : undefined,
        signal,
      }),
    ).then((r) => ({
      status: r.status,
      headers: r.headers,
      body: nodeToWeb(r.body),
      destroy: r.destroy,
    }));
  }

  /** Tiny anonymous probe used by the recovery loop. */
  async probeAnonymous(model: string, timeoutMs: number): Promise<boolean> {
    const probeModel = model || this.cfg.models[0] || "deepseek-v4-flash-free";
    const body = JSON.stringify({ model: probeModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
    const url = this.cfg.upstreamBase + "/chat/completions";
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const port = u.port ? Number(u.port) : isHttps ? 443 : 80;
    const request = buildRequest("POST", u.pathname + u.search, u.host, {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "oc-fwd/2.0 (bun)",
      Connection: "close",
    }, body);
    try {
      const tcp = await openUpstreamSocket(this.cfg, { host: u.hostname, port, timeoutMs });
      const resp = await http1Request({
        tcp,
        tls: isHttps,
        servername: u.hostname,
        request,
        totalTimeoutMs: timeoutMs,
      });
      resp.destroy();
      return resp.status >= 200 && resp.status < 300;
    } catch {
      this.log.debug("no-key probe failed", { model: probeModel });
      return false;
    }
  }

  startProbeLoop() {
    if (this.keys.length === 0) return;
    this.probeTimer = setInterval(async () => {
      for (const model of this.fallback.keyedModels()) {
        if (!this.fallback.probesActive(model)) continue;
        const ok = await this.probeAnonymous(model, this.cfg.noKeyProbeIntervalMs);
        this.fallback.takeProbeResult(model, ok);
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

/**
 * Read an upstream error response body once, decide whether it is
 * deterministic (retrying it, especially with a different auth mode, would
 * produce the same failure) and expose the parsed error shape for logging.
 *
 * Zen answers unsupported multimodal (image/audio/input_image/unknown
 * content type) requests with an invalid_request_error; those must be
 * surfaced unchanged. The body is fully decoded here (which drains the
 * stream); it is re-wrapped into resp.body so callers can still stream it
 * to the client.
 */
interface UpstreamErrorSummary {
  passthrough: boolean;
  type: string;
  code: string;
  message: string;
  body: string;
}

export async function summarizeUpstreamError(resp: UpstreamResponse): Promise<UpstreamErrorSummary> {
  const empty: UpstreamErrorSummary = { passthrough: false, type: "", code: "", message: "", body: "" };
  if (resp.status < 400) return empty;
  let text: string;
  try {
    text = await readAllText(resp.body);
  } catch {
    return empty;
  }
  // Common OpenAI/Anthropic/Gemini error envelope: { error: { message, type, code } }
  let errorType = "";
  let errorCode = "";
  let errorMessage = "";
  try {
    const obj = JSON.parse(text) as { error?: { message?: unknown; type?: unknown; code?: unknown } };
    const e = obj?.error;
    if (e && typeof e === "object") {
      if (typeof e.message === "string") errorMessage = e.message;
      if (typeof e.type === "string") errorType = e.type;
      if (typeof e.code === "string") errorCode = e.code;
      else if (e.code !== undefined) errorCode = String(e.code);
    }
  } catch {
    // not JSON — keep whole body as message
    errorMessage = text.slice(0, 512);
  }
  const hay = text.toLowerCase();
  const multimodal = [
    "image_url",
    "input_image",
    "unsupported content type",
    "unknown variant `image",
    "image_url`",
    "audio",
    "content type 'image",
    "content type 'audio",
    "model only supports text",
    "does not support image",
    "does not support multimodal",
    "not support multimodal",
  ];
  const isInvalidRequest = hay.includes("invalid_request_error") || hay.includes("invalid request error");
  const passthrough = multimodal.some((k) => hay.includes(k)) && isInvalidRequest;
  const truncated = text.length > 2048 ? text.slice(0, 2048) + "…" : text;
  resp.body = new Blob([truncated]).stream();
  return { passthrough, type: errorType, code: errorCode, message: errorMessage, body: truncated };
}

async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
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
