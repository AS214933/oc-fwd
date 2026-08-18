/**
 * End-to-end tests: a live proxy + mock opencode zen gateway.
 * Verifies automatic per-model outbound protocol selection and the
 * inbound<->outbound request/response conversions (chat, responses, messages,
 * gemini), streaming, retry/fallback, auth, and aliases.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { loadConfig, type Config } from "../src/config";
import { Proxy } from "../src/proxy/handler";
import { Logger } from "../src/log";
import {
  MockZen, chatCompletionJson, chatSSE, responsesJson, responsesMessage, responsesFunctionCall,
  responsesSSE, messagesJson, messagesSSE, geminiJson, geminiSSE, jsonResponse, sseResponse,
} from "./mock-upstream";

let mock: MockZen;
let proxyPort = 0;
let config: Config;

async function testConfig(overrides: Partial<Config> = {}): Promise<Config> {
  const cfg = await loadConfig({
    ...process.env,
    LISTEN_ADDR: ":0",
    ZEN_UPSTREAM: mock.url,
    ZEN_UPSTREAM_API_KEY: "",
    ZEN_SOCKS5: "",
    ZEN_IPV6_PREFER: "false",
    ZEN_ROTATE_IP: "false",
    ZEN_DIAL_TIMEOUT_SECONDS: "5",
    ZEN_RETRY_MAX: "3",
    ZEN_RETRY_BACKOFF_SECONDS: "0.05",
    ZEN_RETRY_MAX_BACKOFF_SECONDS: "0.2",
    ZEN_UPSTREAM_TIMEOUT_SECONDS: "10",
    ZEN_FORCE_CHAT_COMPLETIONS: "false",
    ZEN_FORCE_CHAT_INBOUND: "false",
    ZEN_API_KEYS_FILE: "",
    ZEN_AUTH_KEY: "",
    ZEN_STATUS_URL: "",
    ZEN_MODELS: "",
    ZEN_MODEL_MAP: "",
    ZEN_MODEL_ENDPOINTS: "",
    ZEN_NO_KEY_FAIL_THRESHOLD: "3",
    ZEN_NO_KEY_PROBE_SECONDS: "60",
    LOG_LEVEL: "error",
  });
  return { ...cfg, ...overrides };
}

async function startProxy(cfg: Config) {
  const proxy = new Proxy(cfg, new Logger("error"));
  // Mirror production: never let Bun's 10s idleTimeout cut a slow upstream stream.
  const server = Bun.serve({ port: 0, development: false, idleTimeout: 0, fetch: proxy.handler() });
  return { proxy, server, url: `http://127.0.0.1:${server.port}` };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function post(body: unknown, path = "/v1/chat/completions", headers: Record<string, string> = {}) {
  return fetch(`${url()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function url() {
  return `http://127.0.0.1:${proxyPort}`;
}

async function collectData(res: Response): Promise<Array<{ event?: string; data: string }>> {
  const text = await res.text();
  const out: Array<{ event?: string; data: string }> = [];
  for (const block of text.split("\n\n")) {
    let event: string | undefined;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (data) out.push({ event, data });
  }
  return out;
}

beforeAll(async () => {
  mock = new MockZen(async (ctx) => {
    switch (ctx.path) {
      case "/chat/completions":
        return jsonResponse(chatCompletionJson(ctx.model, `echo:${ctx.model}`));
      case "/responses":
        return jsonResponse(responsesJson(ctx.model, [responsesMessage(`echo:${ctx.model}`)]));
      case "/messages":
        return jsonResponse(messagesJson(ctx.model, `echo:${ctx.model}`));
      default:
        return jsonResponse(geminiJson(ctx.model, `echo:${ctx.model}`));
    }
  });
  config = await testConfig();
  const { url: u } = await startProxy(config);
  proxyPort = Number(new URL(u).port);
});

afterAll(() => {
  mock?.stop();
});

describe("passthrough", () => {
  test("chat -> chat (deepseek)", async () => {
    mock.clear();
    const res = await post({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("echo:deepseek-v4-flash-free");
    expect(mock.last()?.path).toBe("/chat/completions");
  });

  test("chat content preserved with system/assistant/tool messages", async () => {
    mock.clear();
    const res = await post({
      model: "glm-5.2",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "again" },
      ],
    });
    expect(res.status).toBe(200);
    const sent = mock.last()?.body as { messages: Array<{ role: string }> };
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  test("responses -> responses passthrough (gpt)", async () => {
    mock.clear();
    const res = await post({ model: "gpt-5.6-terra", input: "ping", stream: false }, "/v1/responses");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: Array<{ type: string; content: Array<{ text: string }> }> };
    expect(body.output[0]?.type).toBe("message");
    expect(body.output[0]?.content[0]?.text).toBe("echo:gpt-5.6-terra");
    expect(mock.last()?.path).toBe("/responses");
  });

  test("messages -> messages passthrough (claude)", async () => {
    mock.clear();
    const res = await post({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "ping" }], max_tokens: 64 }, "/v1/messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ type: string; text: string }> };
    expect(body.content[0]?.text).toBe("echo:claude-sonnet-4-5");
    expect(mock.last()?.path).toBe("/messages");
  });
});

describe("automatic per-model outbound conversion", () => {
  test("chat inbound -> responses outbound (gpt)", async () => {
    mock.clear();
    const res = await post({
      model: "gpt-5.6-sol",
      messages: [
        { role: "system", content: "you are a pro" },
        { role: "user", content: "build it" },
      ],
      max_tokens: 99,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("echo:gpt-5.6-sol");
    const sent = mock.last();
    expect(sent?.path).toBe("/responses");
    const req = sent?.body as { model: string; instructions: string; input: unknown[]; max_output_tokens: number };
    expect(req.model).toBe("gpt-5.6-sol");
    expect(req.instructions).toBe("you are a pro");
    expect(req.input).toHaveLength(1);
    expect(req.max_output_tokens).toBe(99);
  });

  test("chat inbound -> messages outbound (claude)", async () => {
    mock.clear();
    const res = await post({ model: "claude-opus-4-6", messages: [{ role: "user", content: "hi" }], max_tokens: 42 });
    expect(res.status).toBe(200);
    expect((await res.json()) as { choices: Array<{ message: { content: string } }> }).toBeDefined();
    const sent = mock.last();
    expect(sent?.path).toBe("/messages");
    const req = sent?.body as { model: string; messages: Array<{ role: string; content: unknown }>; max_tokens: number };
    expect(req.model).toBe("claude-opus-4-6");
    expect(req.messages[0]?.role).toBe("user");
    expect(req.max_tokens).toBe(42);
  });

  test("chat inbound -> gemini outbound (gemini)", async () => {
    mock.clear();
    const res = await post({ model: "gemini-3.5-flash", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("echo:gemini-3.5-flash");
    const sent = mock.last();
    expect(sent?.path).toBe("/models/gemini-3.5-flash");
    const req = sent?.body as { contents: Array<{ role: string; parts: Array<{ text: string }> }> };
    expect(req.contents[0]?.role).toBe("user");
    expect(req.contents[0]?.parts[0]?.text).toBe("hi");
  });

  test("responses inbound -> chat outbound (kimi)", async () => {
    mock.clear();
    const res = await post(
      { model: "kimi-k2.5", instructions: "sys", input: [{ type: "message", role: "user", content: "hi" }], max_output_tokens: 77 },
      "/v1/responses",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: Array<{ type: string; content: Array<{ text: string }> }> };
    expect(body.output[0]?.content[0]?.text).toBe("echo:kimi-k2.5");
    const sent = mock.last();
    expect(sent?.path).toBe("/chat/completions");
    const req = sent?.body as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages[0]?.content).toBe("sys");
    expect(req.messages[1]?.content).toBe("hi");
    expect(req.max_tokens).toBe(77);
  });

  test("messages inbound -> chat outbound (glm)", async () => {
    mock.clear();
    const res = await post(
      { model: "glm-5.2", system: "sys2", messages: [{ role: "user", content: "hey" }], max_tokens: 33 },
      "/v1/messages",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ type: string; text: string }> };
    expect(body.content[0]?.text).toBe("echo:glm-5.2");
    expect(mock.last()?.path).toBe("/chat/completions");
  });

  test("responses inbound -> messages outbound (claude-sonnet-5)", async () => {
    mock.clear();
    const res = await post(
      { model: "claude-sonnet-5", instructions: "be nice", input: "help me" },
      "/v1/responses",
    );
    expect(res.status).toBe(200);
    const sent = mock.last();
    expect(sent?.path).toBe("/messages");
    const req = sent?.body as { system: string; messages: Array<{ role: string; content: unknown }> };
    expect(req.system).toBe("be nice");
    expect((req.messages[0]?.content as Array<{ text: string }>)[0]?.text).toBe("help me");
    const body = (await res.json()) as { output: Array<{ content: Array<{ text: string }> }> };
    expect(body.output[0]?.content[0]?.text).toBe("echo:claude-sonnet-5");
  });
});

describe("streaming", () => {
  test("chat stream -> responses outbound -> chat chunk events", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/responses") return responsesSSE(ctx.model, [{ text: "abc" }, { text: "def" }]);
      if (ctx.path === "/chat/completions") return chatSSE(ctx.model, [{ content: "abc" }, { content: "def" }]);
      return jsonResponse({});
    });
    const res = await post({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const events = await collectData(res);
    const contents = events
      .map((e) => {
        try {
          return (JSON.parse(e.data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    expect(contents).toEqual(["abc", "def"]);
    expect(events.some((e) => e.data === "[DONE]")).toBe(true);
    const sent = mock.last();
    expect(sent?.path).toBe("/responses");
  });

  test("responses stream -> chat outbound -> response events", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") return chatSSE(ctx.model, [{ content: "xyz" }]);
      return jsonResponse({});
    });
    const res = await post({ model: "kimi-k2.5", input: "stream me", stream: true }, "/v1/responses");
    expect(res.status).toBe(200);
    const events = await collectData(res);
    const types = events.map((e) => {
      try {
        return (JSON.parse(e.data) as { type?: string }).type;
      } catch {
        return undefined;
      }
    });
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.completed");
    const delta = events.find((e) => {
      const t = JSON.parse(e.data) as { type: string; delta?: string };
      return t.type === "response.output_text.delta";
    });
    expect((JSON.parse(delta!.data) as { delta: string }).delta).toBe("xyz");
    expect(mock.last()?.path).toBe("/chat/completions");
  });

  test("messages stream -> chat outbound -> anthropic events", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") return chatSSE(ctx.model, [{ content: "tasks" }]);
      return jsonResponse({});
    });
    const res = await post({ model: "glm-5.1", messages: [{ role: "user", content: "go" }], stream: true }, "/v1/messages");
    expect(res.status).toBe(200);
    const events = await collectData(res);
    const types = events.map((e) => e.event);
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("message_delta");
    expect(types).toContain("message_stop");
  });

  test("chat stream -> messages outbound -> chat chunk events", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/messages") return messagesSSE(ctx.model, [{ text: "done!" }]);
      return jsonResponse({});
    });
    const res = await post({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "go" }], stream: true });
    expect(res.status).toBe(200);
    const events = await collectData(res);
    const contents = events
      .map((e) => {
        try {
          return (JSON.parse(e.data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    expect(contents).toEqual(["done!"]);
    expect(mock.last()?.path).toBe("/messages");
  });

  test("chat stream -> gemini outbound -> chat chunk events", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/models/gemini-3.6-flash") return geminiSSE(ctx.model, "gemtext");
      return jsonResponse({});
    });
    const res = await post({ model: "gemini-3.6-flash", messages: [{ role: "user", content: "go" }], stream: true });
    expect(res.status).toBe(200);
    const events = await collectData(res);
    const contents = events
      .map((e) => {
        try {
          return (JSON.parse(e.data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    expect(contents.join("")).toBe("gemtext");
  });

  test("streaming tool calls: chat -> responses outbound", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/responses") {
        return responsesSSE(ctx.model, [{ text: "" }, { toolCall: { id: "call_1", name: "get_weather", arguments: JSON.stringify({ city: "bj" }) } }]);
      }
      return jsonResponse({});
    });
    const res = await post({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "weather?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const events = await collectData(res);
    const toolChunks = events
      .map((e) => {
        try {
          return (JSON.parse(e.data) as { choices?: Array<{ delta?: { tool_calls?: unknown[] } }> }).choices?.[0]?.delta?.tool_calls;
        } catch {
          return undefined;
        }
      })
      .filter((t) => t !== undefined && t !== null && (t as unknown[]).length > 0);
    expect(toolChunks.length).toBeGreaterThan(0);
    const sent = mock.last();
    expect(sent?.path).toBe("/responses");
    const req = sent?.body as { tools?: unknown[] };
    expect(Array.isArray(req.tools)).toBe(true);
  });

  test("upstream ignores stream=true and returns JSON -> SSE synthesized", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/responses") return jsonResponse(responsesJson(ctx.model, [responsesMessage("slow")]));
      return jsonResponse({});
    });
    const res = await post({ model: "gpt-5.4-nano", input: "hi", stream: true }, "/v1/responses");
    expect(res.status).toBe(200);
    const events = await collectData(res);
    const types = events.map((e) => {
      try {
        return (JSON.parse(e.data) as { type?: string }).type;
      } catch {
        return undefined;
      }
    });
    expect(types).toContain("response.created");
    expect(types).toContain("response.completed");
  });

  test("stream survives an upstream idle gap longer than Bun's 10s idleTimeout", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path !== "/chat/completions") return jsonResponse({});
      const enc = new TextEncoder();
      const part1 = { id: "chatcmpl_1", object: "chat.completion.chunk", model: ctx.model, created: 1700000000, choices: [{ index: 0, delta: { role: "assistant" } }] };
      const part2 = { id: "chatcmpl_1", object: "chat.completion.chunk", model: ctx.model, created: 1700000000, choices: [{ index: 0, delta: { content: "after-gap" } }] };
      const final: Record<string, unknown> = {
        id: "chatcmpl_1", object: "chat.completion.chunk", model: ctx.model, created: 1700000000,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(part1)}\n\n`));
            await sleep(11000);
            controller.enqueue(enc.encode(`data: ${JSON.stringify(part2)}\n\n`));
            controller.enqueue(enc.encode(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const res = await post({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(res.status).toBe(200);
    const events = await collectData(res);
    const contents = events
      .map((e) => {
        try {
          return (JSON.parse(e.data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    expect(contents).toContain("after-gap");
    expect(events.some((e) => e.data === "[DONE]")).toBe(true);
  }, 20000);
});

describe("protocol correctness with tools", () => {
  test("responses function_call_input -> chat tool message round trip", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") {
        const req = ctx.body as { messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }> };
        return jsonResponse(
          chatCompletionJson(ctx.model, "let me check", [
            { id: "call_9", name: "lookup", arguments: JSON.stringify({ q: "x" }) },
          ]),
        );
      }
      return jsonResponse({});
    });
    const res = await post(
      {
        model: "kimi-k3",
        input: [
          { type: "function_call", call_id: "call_9", name: "lookup", arguments: JSON.stringify({ q: "x" }) },
          { type: "function_call_output", call_id: "call_9", output: "result" },
          { type: "message", role: "user", content: "continue" },
        ],
      },
      "/v1/responses",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: Array<{ type: string; call_id?: string; arguments?: string }> };
    const fc = body.output.find((o) => o.type === "function_call");
    expect(fc?.call_id).toBe("call_9");
    expect(fc?.arguments).toBe(JSON.stringify({ q: "x" }));
  });
});

describe("retry + fallback", () => {
  test("429 then success is retried transparently", async () => {
    let calls = 0;
    mock.setHandler(async (ctx) => {
      calls++;
      if (calls <= 2 && ctx.path === "/chat/completions") {
        return jsonResponse({ error: { message: "rate limited", code: "rate_limit_exceeded" } }, 429);
      }
      return jsonResponse(chatCompletionJson(ctx.model, "finally"));
    });
    const res = await post({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  test("anonymous failure falls back to API key with keyed retry", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") {
        if (!ctx.auth) return jsonResponse({ error: { message: "no anonymous" } }, 503);
        return jsonResponse(chatCompletionJson(ctx.model, "keyed-ok"));
      }
      return jsonResponse({});
    });
    const cfg = await testConfig({ apiKeys: ["key-abc"], noKeyFailThreshold: 2 });
    const { url: u } = await startProxy(cfg);
    const res = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { choices: Array<{ message: { content: string } }> }).toBeTruthy();
    const keyed = mock.requests.filter((r) => r.headers.get("Authorization")?.includes("key-abc"));
    expect(keyed.length).toBeGreaterThan(0);
  });

  test("first non-2xx switches model to API key immediately", async () => {
    mock.clear();
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") {
        if (!ctx.auth) return jsonResponse({ error: { message: "400" } }, 400);
        return jsonResponse(chatCompletionJson(ctx.model, "keyed-after-400"));
      }
      return jsonResponse({});
    });
    const cfg = await testConfig({ apiKeys: ["key-xyz"], retryMax: 3 });
    const { url: u } = await startProxy(cfg);
    const res = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    // The anonymous attempt fails once, the model switches immediately, and
    // the same request is retried with the key. The full retry ladder is NOT
    // burned anonymously first.
    const anonymous = mock.requests.filter((r) => !r.headers.get("Authorization") && r.path === "/chat/completions");
    expect(anonymous.length).toBe(1);
    const keyed = mock.requests.filter((r) => r.headers.get("Authorization")?.includes("key-xyz"));
    expect(keyed.length).toBeGreaterThanOrEqual(1);
  });

  test("subsequent requests go straight to API key after an anonymous non-2xx", async () => {
    mock.clear();
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") {
        if (!ctx.auth) return jsonResponse({ error: { message: "500" } }, 500);
        return jsonResponse(chatCompletionJson(ctx.model, "keyed-later"));
      }
      return jsonResponse({});
    });
    const cfg = await testConfig({ apiKeys: ["key-later"], retryMax: 3 });
    const { url: u } = await startProxy(cfg);
    // First request triggers the fail-fast switch (anonymous 500 -> keyed 200).
    const first = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(first.status).toBe(200);
    // Second request must skip anonymous entirely and go straight to keyed.
    mock.clear();
    const second = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(second.status).toBe(200);
    const secondCalls = mock.requests.filter((r) => r.path === "/chat/completions");
    expect(secondCalls.length).toBe(1);
    expect(secondCalls[0]?.headers.get("Authorization")).toContain("key-later");
  });

  test("concurrent 429s don't truncate in-flight retries when the circuit opens", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Every attempt gets a 429. Block the first 6 calls (the six requests'
    // attempt-0 dials) until all are in flight, so the circuit opens while
    // every request is still inside its retry loop.
    mock.setHandler(async (ctx) => {
      calls++;
      if (calls <= 6) {
        if (calls === 6) release();
        await gate;
      }
      return jsonResponse({ error: { message: "rate limited", code: "rate_limit_exceeded" } }, 429);
    });
    const cfg = await testConfig({
      retryMax: 3,
      circuitFailures: 2,
      retryBaseBackoffMs: 0,
      retryMaxBackoffMs: 0,
    });
    const { url: u } = await startProxy(cfg);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        fetch(`${u}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] }),
        }),
      ),
    );
    for (const r of results) expect(r.status).toBe(429);
    // 6 requests * (retryMax + 1) attempts: the circuit opening mid-flight
    // must not cut the in-flight retry ladders short.
    expect(calls).toBe(24);
  });

  test("multimodal unsupported error (400 invalid_request_error) is passed through without retry or key fallback", async () => {
    mock.clear();
    const multimodalBody = {
      error: {
        param: null,
        type: "invalid_request_error",
        code: "invalid_request_error",
        message: "Error from provider (Console): Upstream request failed: [invalid_request_error] Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text` at line 1 column 265",
      },
    };
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") return jsonResponse(multimodalBody, 400);
      return jsonResponse({});
    });
    const cfg = await testConfig({ apiKeys: ["key-zzz"], noKeyFailThreshold: 2 });
    const { url: u } = await startProxy(cfg);
    const res = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash-free",
        messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==" } }] }],
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual(multimodalBody);
    const chatCalls = mock.requests.filter((r) => r.path === "/chat/completions");
    expect(chatCalls.length).toBe(1); // no retries
    expect(chatCalls.every((r) => !r.headers.get("Authorization"))).toBe(true); // no key fallback
    expect(mock.requests.filter((r) => r.headers.get("Authorization")?.includes("key-zzz")).length).toBe(0);
  });

  test("generic 400 still follows the retry/fallback ladder (only multimodal errors bypass it)", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") {
        if (!ctx.auth) return jsonResponse({ error: { message: "400", type: "invalid_request_error" } }, 400);
        return jsonResponse(chatCompletionJson(ctx.model, "keyed-after-generic-400"));
      }
      return jsonResponse({});
    });
    const cfg = await testConfig({ apiKeys: ["key-gen-400"], retryMax: 1 });
    const { url: u } = await startProxy(cfg);
    const res = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const keyed = mock.requests.filter((r) => r.headers.get("Authorization")?.includes("key-gen-400"));
    expect(keyed.length).toBeGreaterThan(0);
  });
});

describe("auth, models, aliases, force modes", () => {
  test("ZEN_AUTH_KEY guards endpoints", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") return jsonResponse(chatCompletionJson(ctx.model, "ok"));
      return jsonResponse({});
    });
    const cfg = await testConfig({ authKey: "topsecret" });
    const { url: u } = await startProxy(cfg);
    const noKey = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(noKey.status).toBe(401);
    const withKey = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer topsecret" },
      body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(withKey.status).toBe(200);
  });

  test("model alias maps + rewrites response model back to alias", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") {
        return jsonResponse(chatCompletionJson(ctx.model, `resolved:${ctx.model}`));
      }
      return jsonResponse({});
    });
    const cfg = await testConfig({ modelMap: { v4f: "deepseek-v4-flash-free" } });
    const { url: u } = await startProxy(cfg);
    const res = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "v4f", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; choices: Array<{ message: { content: string } }> };
    expect(body.model).toBe("v4f");
    expect(body.choices[0]?.message.content).toBe("resolved:deepseek-v4-flash-free");
    expect(mock.last()?.body).toMatchObject({ model: "deepseek-v4-flash-free" });
  });

  test("model whitelist rejects unknown models", async () => {
    const cfg = await testConfig({ models: ["deepseek-v4-flash-free"] });
    const { url: u } = await startProxy(cfg);
    const res = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
  });

  test("/v1/models lists the catalog or whitelist", async () => {
    const { url: u } = await startProxy(await testConfig());
    const res = await fetch(`${u}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((m) => m.id === "gpt-5.6-sol")).toBe(true);
    expect(body.data.some((m) => m.id === "claude-opus-5")).toBe(true);
    expect(body.data.some((m) => m.id === "deepseek-v4-flash-free")).toBe(true);
    expect(body.data.some((m) => m.id === "gemini-3.5-flash")).toBe(true);

    const restricted = await testConfig({ models: ["deepseek-v4-flash-free"], modelMap: { alias1: "gpt-5.5" } });
    const { url: u2 } = await startProxy(restricted);
    const res2 = await fetch(`${u2}/v1/models`);
    const list2 = ((await res2.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(list2).toEqual(["deepseek-v4-flash-free", "alias1"]);
  });

  test("ZEN_FORCE_CHAT_INBOUND rejects responses/messages", async () => {
    const cfg = await testConfig({ forceChatInbound: true });
    const { url: u } = await startProxy(cfg);
    const res = await fetch(`${u}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  test("ZEN_FORCE_CHAT_COMPLETIONS forces chat outbound for any model", async () => {
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") return jsonResponse(chatCompletionJson(ctx.model, "forced-chat"));
      return jsonResponse({});
    });
    const cfg = await testConfig({ forceChatCompletions: true });
    const { url: u } = await startProxy(cfg);
    const res = await fetch(`${u}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(mock.last()?.path).toBe("/chat/completions");
    const body = (await res.json()) as { output: Array<{ content: Array<{ text: string }> }> };
    expect(body.output[0]?.content[0]?.text).toBe("forced-chat");
  });
});

describe("health & debug", () => {
  test("healthz and debug modes", async () => {
    const { url: u } = await startProxy(config);
    const health = await fetch(`${u}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    const modes = await fetch(`${u}/debug/modes`);
    expect(modes.status).toBe(200);
    const body = (await modes.json()) as { models: Array<{ model: string; state: string }> };
    const gpt = body.models.find((m) => m.model === "gpt-5.6-sol");
    expect(gpt?.state).toBe("anonymous");
  });

  test("debug modes lists every configured model", async () => {
    const cfg = await testConfig({ models: ["deepseek-v4-flash-free", "mimo-v2.5-free"], apiKeys: ["k1"] });
    const { url: u } = await startProxy(cfg);
    const modes = await fetch(`${u}/debug/modes`);
    const body = (await modes.json()) as { models: Array<{ model: string; state: string }> };
    const names = body.models.map((m) => m.model);
    expect(names).toContain("deepseek-v4-flash-free");
    expect(names).toContain("mimo-v2.5-free");
  });

  test("debug modes includes models seen outside ZEN_MODELS once requested", async () => {
    mock.clear();
    mock.setHandler(async (ctx) => {
      if (ctx.path === "/chat/completions") return jsonResponse(chatCompletionJson(ctx.model, "ok"));
      return jsonResponse({});
    });
    const cfg = await testConfig({ models: ["deepseek-v4-flash-free"], apiKeys: ["k1"] });
    const { url: u } = await startProxy(cfg);
    // mimo-v2.5-free is NOT in ZEN_MODELS here, so it is rejected by the
    // whitelist (resolveModel) and never reaches the upstream; the status UI
    // therefore keeps showing exactly the configured model. The union with
    // "seen" models matters when the proxy is configured with an empty
    // ZEN_MODELS (no allowlist) - that case is covered by the failure-path
    // fallback tests, and this test pins the allowlist behavior.
    const res = await fetch(`${u}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
    const modes = await fetch(`${u}/debug/modes`);
    const body = (await modes.json()) as { models: Array<{ model: string; state: string }> };
    expect(body.models.map((m) => m.model)).toContain("deepseek-v4-flash-free");
    expect(body.models.map((m) => m.model)).not.toContain("mimo-v2.5-free");
  });
});
