/**
 * The proxy request handler: OpenAI-compatible inbound surface, automatic
 * per-model outbound protocol selection (from the zen model catalog), and
 * full request/response conversion between the two.
 */
import { timingSafeEqual } from "node:crypto";
import type dns from "node:dns";
import type { Config } from "../config";
import { resolveOutboundProtocol, outboundPath, catalogModelIds } from "../catalog";
import { Logger } from "../log";
import { Circuit } from "./circuit";
import { FallbackState } from "./fallback";
import { Reporter } from "./reporter";
import { UpstreamClient, CircuitOpenError, type UpstreamResponse } from "./upstream";
import { makeLookup } from "./dial";
import { parseChatRequest, renderChatRequest, renderChatCompletion, parseChatCompletion, type ChatCompletion, type ChatRequest } from "../convert/chat";
import { parseResponsesRequest, responsesToChatRequest, chatToResponsesRequest, parseResponsesResponse, renderChatCompletionAsResponses, normalizeToolCallSequence } from "../convert/responses";
import { parseMessagesRequest, messagesToChatRequest, chatToMessagesRequest, parseMessagesResponse, renderChatCompletionAsMessages } from "../convert/messages";
import { chatToGeminiRequest, parseGeminiResponse } from "../convert/gemini";
import {
  readSSE, sseText,
  responsesToChatChunks, messagesToChatChunks, geminiToChatChunks, chatSSEToChunks,
  chatChunksToResponses, chatChunksToMessages, chatChunksToGemini,
  renderResponsesEventsFromCompletion, renderMessagesEventsFromCompletion, renderGeminiEventFromCompletion,
  type SseEvent,
} from "../convert/stream";

/** Status visibility window: a model only shows up if routed within this span. */
const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;
import type { ChatChunk } from "../convert/types";

type InboundFormat = "chat" | "responses" | "messages";
type OutboundProtocol = "chat" | "responses" | "messages" | "gemini";

/**
 * Decide which models the status page should surface. Only models actually
 * routed within the retention window appear (an empty ZEN_MODELS must not
 * dump every catalog id into the page); anything still in keyed state stays
 * visible even without fresh traffic so an in-flight degradation cannot
 * silently vanish. Aliases appear only once actually called.
 */
export interface DebugModeSource {
  knownModels(): string[];
  lastSeenAt(model: string): number;
  modelState(model: string): string;
  keyedModels(): string[];
}

export interface DebugModeEntry {
  model: string;
  state: string;
}

export function debugVisibleModels(
  now: number,
  windowMs: number,
  src: DebugModeSource,
  apiKeysEnabled: boolean,
  modelMap: Record<string, string>,
): DebugModeEntry[] {
  const cutoff = now - windowMs;
  const states: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const model of src.knownModels()) {
    if (src.lastSeenAt(model) >= cutoff || src.modelState(model) !== "anonymous") {
      states[model] = src.modelState(model);
    }
  }
  if (apiKeysEnabled) {
    for (const model of src.keyedModels()) {
      states[model] = src.modelState(model);
    }
  }
  for (const alias of Object.keys(modelMap)) {
    if (src.lastSeenAt(alias) >= cutoff && !states[alias]) states[alias] = "anonymous";
  }
  return Object.keys(states)
    .sort()
    .map((model) => ({ model, state: states[model] ?? "unknown" }));
}

export class Proxy {
  private upstream: UpstreamClient;
  private reporter?: Reporter;
  private sem: Semaphore;

  constructor(
    private cfg: Config,
    private log: Logger,
  ) {
    this.reporter = cfg.statusURL ? new Reporter(cfg.statusURL, cfg.statusToken, log) : undefined;
    const circuit = new Circuit(cfg.circuitFailures, cfg.circuitCooldownMs);
    const fallback = new FallbackState(
      cfg.noKeyFailThreshold,
      cfg.apiKeys.length > 0,
      log,
      this.reporter,
      cfg.noKeyRecoveryHoldMs,
      cfg.noKeyProbeConfirmations,
    );
    this.upstream = new UpstreamClient(cfg, log, fallback, circuit);
    this.sem = new Semaphore(cfg.maxConcurrency);
    this.reporter?.start();
    this.upstream.startProbeLoop();
    log.info("zen-proxy configured", {
      listen: cfg.listen,
      upstream: cfg.upstreamBase,
      auth_required: cfg.authKey !== "",
      socks5: cfg.socks5 !== "",
      rotate_ip: cfg.rotateIP,
      retry_max: cfg.retryMax,
      circuit_failures: cfg.circuitFailures,
      model_catalog: catalogModelIds().length,
    });
  }

  stop() {
    this.upstream.stop();
  }

  handler(): (req: Request) => Promise<Response> | Response {
    return (req) => this.route(req);
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    try {
      if (method === "POST" && path === "/v1/chat/completions") return await this.handleCompletion(req, "chat");
      if (method === "POST" && path === "/v1/responses") return await this.handleCompletion(req, "responses");
      if (method === "POST" && path === "/v1/messages") return await this.handleCompletion(req, "messages");
      if (method === "GET" && path === "/v1/models") return this.requireAuth(req) ? this.handleModels() : unauthorized();
      if (method === "GET" && path === "/debug/upstream-ip") {
        return this.requireDebugAuth(req) ? this.handleDebugUpstreamIP() : unauthorized();
      }
      if (method === "GET" && path === "/debug/modes") {
        return this.requireDebugAuth(req) ? this.handleDebugModes() : unauthorized();
      }
      if (method === "GET" && path === "/healthz") {
        return new Response("ok", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      return errorResponse(404, `no route for ${method} ${path}`, "not_found");
    } catch (err) {
      if (err instanceof BodyError) {
        return errorResponse(err.status, err.message, err.code);
      }
      if (err instanceof CircuitOpenError) {
        return errorResponse(429, "upstream temporarily rate limited (circuit open)", "upstream_error");
      }
      this.log.error("request failed", { path, error: String(err) });
      return errorResponse(502, `upstream request failed: ${String(err)}`, "upstream_error");
    }
  }

  private requireAuth(req: Request): boolean {
    return this.cfg.authKey === "" || validCallerKey(req, this.cfg.authKey);
  }

  private requireDebugAuth(req: Request): boolean {
    if (this.cfg.statusToken !== "") {
      const got = req.headers.get("X-Status-Token") ?? "";
      if (constantTimeEqual(got, this.cfg.statusToken)) return true;
    }
    return this.requireAuth(req);
  }

  private async handleCompletion(req: Request, format: InboundFormat): Promise<Response> {
    if (this.cfg.forceChatInbound && format !== "chat") {
      return errorResponse(
        400,
        "this proxy enforces Chat Completions inbound (ZEN_FORCE_CHAT_INBOUND=true): " +
          "only POST /v1/chat/completions is accepted; point your client at " +
          "/v1/chat/completions (e.g. an openai-compatible client such as opencode)",
        "invalid_request_error",
      );
    }
    if (!this.requireAuth(req)) return unauthorized();

    const raw = await this.readJSON(req);
    const clientModel = typeof raw.model === "string" ? raw.model : "";
    if (!clientModel) {
      return errorResponse(400, `missing "model" in ${format} request`, "invalid_request_error");
    }
    const clientStream = raw.stream === true;

    const upstreamModel = this.resolveModel(clientModel);
    if (!upstreamModel) {
      return errorResponse(400, `model "${clientModel}" is not allowed by this proxy`, "model_not_found");
    }
    // A reachable model counts as called even before the upstream answers, so
    // status visibility is driven by real usage (incl. aliases and traffic
    // that later passes a non-200 straight back to the client).
    this.upstream.noteCall(clientModel);

    const outboundProtocol: OutboundProtocol = this.cfg.forceChatCompletions
      ? "chat"
      : resolveOutboundProtocol(upstreamModel, this.cfg.modelEndpoints);

    let chatReq: ChatRequest;
    try {
      chatReq = this.toChatRequest(format, raw);
      chatReq.model = upstreamModel;
      // Some clients (opencode / codex agents) replay an assistant tool_calls
      // message whose tool results were not persisted into the next request.
      // Upstream stays legal by filling empty tool responses for every
      // unanswered call_id; paired calls are untouched.
      normalizeToolCallSequence(chatReq.messages);
    } catch (err) {
      return errorResponse(400, `cannot convert request to chat completions: ${String(err)}`, "invalid_request_error");
    }

    const path = this.cfg.forceChatCompletions
      ? "/chat/completions"
      : outboundPath(upstreamModel, this.cfg.modelEndpoints);
    const body = this.renderOutboundRequest(outboundProtocol, chatReq);

    await this.sem.acquire();
    let resp: UpstreamResponse;
    try {
      resp = await this.upstream.do(path, body, clientStream);
    } finally {
      this.sem.release();
    }

    const contentType = resp.headers.get("Content-Type") ?? "";
    const respSSE = isSSE(contentType);
    const rewrite = upstreamModel !== clientModel;
    const alias = rewrite ? clientModel : "";

    if (resp.status !== 200) {
      return new Response(resp.body, {
        status: resp.status,
        headers: { "Content-Type": contentType || "application/json", "X-Zen-Proxy": "1" },
      });
    }

    if (clientStream || respSSE) {
      if (respSSE) {
        return this.respondStreaming(resp, outboundProtocol, format, alias);
      }
      // Upstream ignored stream=true and returned a single JSON body: emit a
      // minimal SSE sequence so streaming clients still get valid events.
      const completion = await this.parseUpstreamCompletion(outboundProtocol, await readAllText(resp.body));
      return this.respondSSEFromCompletion(completion, format, alias);
    }

    const completion = await this.parseUpstreamCompletion(outboundProtocol, await readAllText(resp.body));
    return this.nonStreamingResponse(completion, format, alias);
  }

  private toChatRequest(format: InboundFormat, raw: Record<string, unknown>): ChatRequest {
    switch (format) {
      case "chat":
        return parseChatRequest(raw);
      case "responses":
        return responsesToChatRequest(parseResponsesRequest(raw));
      case "messages":
        return messagesToChatRequest(parseMessagesRequest(raw));
    }
  }

  private renderOutboundRequest(protocol: OutboundProtocol, req: ChatRequest): string {
    switch (protocol) {
      case "chat":
        return renderChatRequest(isDeepSeekModel(req.model) ? req : withoutReasoningContent(req));
      case "responses":
        return JSON.stringify(chatToResponsesRequest(req));
      case "messages":
        return JSON.stringify(chatToMessagesRequest(req));
      case "gemini":
        return JSON.stringify(chatToGeminiRequest(req));
    }
  }

  private async parseUpstreamCompletion(protocol: OutboundProtocol, text: string): Promise<ChatCompletion> {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error("upstream returned invalid JSON");
    }
    const data = (obj ?? {}) as Record<string, unknown>;
    switch (protocol) {
      case "responses":
        return parseResponsesResponse(data);
      case "messages":
        return parseMessagesResponse(data);
      case "gemini":
        return parseGeminiResponse(data);
      case "chat":
        return parseChatCompletion(data);
    }
  }

  private nonStreamingResponse(completion: ChatCompletion, format: InboundFormat, alias: string): Response {
    let payload: unknown;
    switch (format) {
      case "responses":
        payload = renderChatCompletionAsResponses(completion);
        break;
      case "messages":
        payload = renderChatCompletionAsMessages(completion);
        break;
      default:
        payload = completion;
        break;
    }
    if (alias && payload !== null && typeof payload === "object") {
      (payload as Record<string, unknown>).model = alias;
    }
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json", "X-Zen-Proxy": "1" },
    });
  }

  private respondStreaming(
    resp: UpstreamResponse,
    upstreamProtocol: OutboundProtocol,
    clientFormat: InboundFormat,
    alias: string,
  ): Response {
    // chat -> chat passthrough: the upstream event stream is already exactly
    // what a Chat Completions client expects, so forward it byte-for-byte
    // instead of parsing every chunk, normalizing it to ChatChunk and re-
    // serializing it. This is the hot path for zen free models (deepseek /
    // mimo / glm / ...), which come back as OpenAI Chat Completions SSE.
    if (upstreamProtocol === "chat" && clientFormat === "chat" && !alias) {
      return new Response(ssePassthrough(resp.body, () => resp.destroy?.()), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Zen-Proxy": "1",
        },
      });
    }
    const events = readSSE(resp.body);
    let chunks: AsyncGenerator<ChatChunk>;
    switch (upstreamProtocol) {
      case "responses":
        chunks = responsesToChatChunks(events);
        break;
      case "messages":
        chunks = messagesToChatChunks(events);
        break;
      case "gemini":
        chunks = geminiToChatChunks(events);
        break;
      default:
        chunks = chatSSEToChunks(events);
        break;
    }
    if (alias) chunks = mapChunks(chunks, (ch) => ({ ...ch, model: alias }));
    const sse = encodeChunksToClient(chunks, clientFormat);
    return new Response(sseToStream(sse, () => resp.destroy?.()), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Zen-Proxy": "1",
      },
    });
  }

  private respondSSEFromCompletion(completion: ChatCompletion, format: InboundFormat, alias: string): Response {
    if (alias) completion.model = alias;
    let events: SseEvent[];
    switch (format) {
      case "responses":
        events = renderResponsesEventsFromCompletion(completion);
        break;
      case "messages":
        events = renderMessagesEventsFromCompletion(completion);
        break;
      default:
        events = [
          { event: undefined, data: JSON.stringify(completion) },
          { event: undefined, data: "[DONE]" },
        ];
        break;
    }
    const body = sseToStream(asyncGen(events), () => {});
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Zen-Proxy": "1",
      },
    });
  }

  private resolveModel(clientModel: string): string | null {
    if (!clientModel) return null;
    const mapped = this.cfg.modelMap[clientModel];
    if (mapped) return mapped;
    if (this.cfg.models.length > 0) {
      return this.cfg.models.includes(clientModel) ? clientModel : null;
    }
    return clientModel;
  }

  private async readJSON(req: Request): Promise<Record<string, unknown>> {
    const buf = await readBodyLimited(req, this.cfg.maxBodyBytes);
    let obj: unknown;
    try {
      obj = JSON.parse(new TextDecoder().decode(buf));
    } catch {
      throw new BodyError(400, "invalid JSON body", "invalid_request_error");
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new BodyError(400, "body must be a JSON object", "invalid_request_error");
    }
    return obj as Record<string, unknown>;
  }

  private handleModels(): Response {
    const seen = new Set<string>();
    const ids: string[] = [];
    const add = (id: string) => {
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    };
    const list = this.cfg.models.length > 0 ? this.cfg.models : catalogModelIds();
    for (const m of list) add(m);
    for (const alias of Object.keys(this.cfg.modelMap)) add(alias);
    const created = Math.floor(Date.now() / 1000);
    return json(
      {
        object: "list",
        data: ids.map((id) => ({ id, object: "model", created, owned_by: "oc-fwd" })),
      },
      { "X-Zen-Proxy": "1" },
    );
  }

  private handleDebugModes(): Response {
    const models = debugVisibleModels(
      this.upstream.clock(),
      STATUS_WINDOW_MS,
      this.upstream,
      this.cfg.apiKeys.length > 0,
      this.cfg.modelMap,
    );
    return json({ models }, { "X-Zen-Proxy": "1" });
  }

  private fallbackModels(): string[] {
    return this.upstream.keyedModels();
  }

  private fallbackState(model: string): string {
    return this.upstream.modelState(model);
  }

  private async handleDebugUpstreamIP(): Promise<Response> {
    const u = new URL(this.cfg.upstreamBase);
    if (!u.hostname) return errorResponse(502, "no upstream host", "upstream_error");
    try {
      const addresses = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
        const lookup = makeLookup(this.cfg, this.cfg.dnsCacheTTLMs);
        lookup(u.hostname as string, { all: true }, (err, addrs) => {
          if (err) reject(err);
          else resolve(addrs as unknown as dns.LookupAddress[]);
        });
      });
      const first = addresses[0];
      if (!first) throw new Error("no addresses");
      return json(
        {
          upstream: this.cfg.upstreamBase,
          ip: first.address,
          family: first.family === 6 ? "ipv6" : "ipv4",
          socks5: this.cfg.socks5 !== "",
          ipv6_prefer: this.cfg.ipv6Prefer,
          ipv6_force: this.cfg.forceIPv6,
        },
        { "X-Zen-Proxy": "1" },
      );
    } catch {
      return errorResponse(502, "failed to resolve upstream", "upstream_error");
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class BodyError extends Error {
  constructor(
    public status: number,
    msg: string,
    public code: string,
  ) {
    super(msg);
  }
}

function isSSE(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}

function isDeepSeekModel(model: string): boolean {
  return model.toLowerCase().startsWith("deepseek-");
}

function withoutReasoningContent(req: ChatRequest): ChatRequest {
  return {
    ...req,
    messages: req.messages.map(({ reasoning_content: _reasoningContent, ...message }) => message),
  };
}

function validCallerKey(req: Request, want: string): boolean {
  let got = "";
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    got = auth.slice("Bearer ".length).trim();
  } else {
    got = (req.headers.get("x-api-key") ?? "").trim();
  }
  if (!got) return false;
  return constantTimeEqual(got, want);
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function unauthorized(): Response {
  return errorResponse(401, "Invalid API key", "invalid_api_key");
}

function errorResponse(status: number, message: string, code: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "invalid_request_error", param: null, code },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function json(body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) throw new BodyError(400, "request body too large or unreadable", "invalid_request_error");
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
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

function encodeChunksToClient(chunks: AsyncGenerator<ChatChunk>, format: InboundFormat): AsyncGenerator<SseEvent> {
  const wrap = async function* () {
    switch (format) {
      case "responses":
        yield* chatChunksToResponses(chunks);
        break;
      case "messages":
        yield* chatChunksToMessages(chunks);
        break;
      default:
        for await (const ch of chunks) {
          yield { event: undefined, data: JSON.stringify(ch) };
        }
        yield { event: undefined, data: "[DONE]" };
    }
  };
  return wrap();
}

async function* mapChunks(chunks: AsyncGenerator<ChatChunk>, fn: (ch: ChatChunk) => ChatChunk): AsyncGenerator<ChatChunk> {
  for await (const ch of chunks) yield fn(ch);
}

async function* asyncGen(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const ev of events) yield ev;
}

/**
 * Byte-level SSE passthrough for the chat -> chat streaming fast path.
 * All events are forwarded verbatim and [DONE] is guaranteed to reach the
 * client even if the upstream stream ends without one.
 */
export function ssePassthrough(stream: ReadableStream<Uint8Array>, onCancel: () => void): ReadableStream<Uint8Array> {
  // sawDone: the upstream sent its own [DONE] (either in this stream or a
  // held-back partial), so nothing more needs to be appended on EOF.
  let sawDone = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let tail = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          let text = decoder.decode(value, { stream: true });
          if (tail) {
            text = tail + text;
            tail = "";
          }
          const doneAt = text.indexOf("[DONE]");
          if (doneAt >= 0) {
            // The upstream sent its own terminator: keep the event that ended
            // right before the marker, strip the marker and everything after
            // it, and emit a canonical terminator in its place.
            const evEnd = text.lastIndexOf("\n\n", doneAt);
            // Keep only the events that ended before the marker (the cut
            // includes their trailing blank line). If the marker begins a new
            // event line (no blank line before it), head is empty: the
            // previous chunk already delivered the full preceding event.
            const cut = evEnd >= 0 ? evEnd + 2 : 0;
            const head = text.slice(0, cut);
            sawDone = true;
            controller.enqueue(encoderBytes.encode(head));
            controller.enqueue(encoderBytes.encode("data: [DONE]\n\n"));
            break;
          }
          const lastNl = text.lastIndexOf("\n");
          const lineTail = (lastNl < 0 ? text : text.slice(lastNl + 1)).replace(/^data: /, "");
          const lineLen = text.length - (lastNl < 0 ? 0 : lastNl + 1);
          if (lineTail !== "" && "[DONE]".startsWith(lineTail) && lineTail.length < 6 && lineTail === text.slice(Math.max(0, text.length - lineTail.length))) {
            // The buffer ends inside a "[DONE]" marker split across TCP
            // segments (e.g. trailing "[DO"). Hold those bytes back and only
            // flush what ended cleanly at the previous blank line; the next
            // chunk completes the marker and the [DONE] branch above handles
            // it. This avoids re-serializing the stream to find the marker.
            const bs = lastNl < 0 ? -1 : text.lastIndexOf("\n\n", lastNl);
            const cut = bs >= 0 ? bs + 2 : 0;
            if (cut > 0) controller.enqueue(encoderBytes.encode(text.slice(0, cut)));
            tail = text.slice(cut);
            continue;
          }
          controller.enqueue(encoderBytes.encode(text));
        }
        const flushed = decoder.decode();
        const leftover = tail ? tail + flushed : flushed;
        // A trailing partial "[DONE]" marker (truncated stream) is nothing: the
        // canonical terminator below replaces it.
        const partialMarker = leftover !== "" && "[DONE]".startsWith(leftover) && leftover.length < 6;
        if (leftover && !partialMarker) controller.enqueue(encoderBytes.encode(leftover));
        if (!sawDone) {
          controller.enqueue(encoderBytes.encode("data: [DONE]\n\n"));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
    cancel() {
      onCancel();
    },
  });
}

const encoderBytes = new TextEncoder();

function sseToStream(sse: AsyncGenerator<SseEvent>, onCancel: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let count = 0;
        for await (const ev of sse) {
          controller.enqueue(encoder.encode(sseText(ev.event, ev.data)));
          count++;
        }
        if (count === 0) controller.enqueue(encoder.encode("\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      onCancel();
    },
  });
}

class Semaphore {
  private count = 0;
  private waiters: Array<() => void> = [];
  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.max <= 0) return;
    if (this.count < this.max) {
      this.count++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.count++;
  }

  release() {
    if (this.max <= 0) return;
    this.count--;
    this.waiters.shift()?.();
  }
}
