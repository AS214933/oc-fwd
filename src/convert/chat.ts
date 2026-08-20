/**
 * Helpers for the canonical OpenAI Chat Completions representation:
 * parsing incoming bodies, rendering outgoing bodies, and parsing upstream
 * chat completion responses (streaming and non-streaming).
 */

import type { ChatCompletion, ChatChunk, ChatMessage, ChatRequest } from "./types";
import { contentToString } from "./types";

export type { ChatCompletion, ChatChunk, ChatRequest };

export function parseChatRequest(body: unknown): ChatRequest {
  if (body === null || typeof body !== "object") {
    throw new Error("chat completions body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.model !== "string") throw new Error("chat completions body requires a string \"model\"");
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const parsed: ChatMessage[] = messages.map((m) => {
    const msg = (m ?? {}) as Record<string, unknown>;
    return {
      role: typeof msg.role === "string" ? msg.role : "user",
      content: contentToString(msg.content),
      ...(typeof msg.reasoning_content === "string" ? { reasoning_content: msg.reasoning_content } : {}),
      ...(typeof msg.tool_call_id === "string" ? { tool_call_id: msg.tool_call_id } : {}),
      ...(Array.isArray(msg.tool_calls) ? { tool_calls: parseToolCalls(msg.tool_calls as unknown[]) } : {}),
    };
  });
  const req: ChatRequest = {
    model: raw.model,
    messages: parsed,
    stream: raw.stream === true,
  };
  // Preserve every extra field so chat passthrough is lossless.
  for (const key of Object.keys(raw)) {
    if (key === "model" || key === "messages" || key === "stream") continue;
    if (raw[key] !== undefined) (req as Record<string, unknown>)[key] = raw[key];
  }
  return req;
}

function parseToolCalls(list: unknown[]): NonNullable<ChatMessage["tool_calls"]> {
  const out: NonNullable<ChatMessage["tool_calls"]> = [];
  for (const item of list) {
    const tc = (item ?? {}) as Record<string, unknown>;
    const fn = (tc.function ?? {}) as Record<string, unknown>;
    out.push({
      id: typeof tc.id === "string" ? tc.id : `call_${out.length + 1}`,
      type: "function",
      function: {
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    });
  }
  return out;
}

export interface ChatParseResult {
  request: ChatRequest;
  raw: Record<string, unknown>;
}

/** Parse a JSON string chat completions request, preserving extra fields. */
export function parseChatRequestJSON(raw: string | Uint8Array): ChatRequest {
  let obj: unknown;
  try {
    obj = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    throw new Error("invalid JSON body");
  }
  return parseChatRequest(obj);
}

/** Serialize an outbound chat completions request body. */
export function renderChatRequest(req: ChatRequest): string {
  const out: Record<string, unknown> = { ...req, model: req.model, messages: req.messages, stream: req.stream === true };
  return JSON.stringify(out);
}

/** Parse an upstream non-streaming chat.completion response. */
export function parseChatCompletion(data: unknown): ChatCompletion {
  const raw = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw new Error("chat completion response has no choices");
  }
  const choice = raw.choices[0] as Record<string, unknown>;
  const msg = (choice.message ?? {}) as Record<string, unknown>;
  const usage = (raw.usage ?? {}) as Record<string, unknown>;
  return {
    id: typeof raw.id === "string" ? raw.id : "chatcmpl_1",
    object: "chat.completion",
    model: typeof raw.model === "string" ? raw.model : "",
    created: typeof raw.created === "number" ? raw.created : Math.floor(Date.now() / 1000),
    choices: [
      {
        index: typeof choice.index === "number" ? choice.index : 0,
        message: {
          role: typeof msg.role === "string" ? msg.role : "assistant",
          content: contentToString(msg.content),
          ...(typeof msg.reasoning_content === "string" ? { reasoning_content: msg.reasoning_content } : {}),
          ...(Array.isArray(msg.tool_calls) ? { tool_calls: parseToolCalls(msg.tool_calls as unknown[]) } : {}),
        },
        finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
      },
    ],
    usage: {
      prompt_tokens: num(usage.prompt_tokens),
      completion_tokens: num(usage.completion_tokens),
      total_tokens: num(usage.total_tokens),
    },
  };
}

function parseChatChunk(data: unknown): ChatChunk | null {
  const raw = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(raw.choices)) return null;
  const choices = raw.choices.map((c) => {
    const ch = (c ?? {}) as Record<string, unknown>;
    const delta = (ch.delta ?? {}) as Record<string, unknown>;
    return {
      index: typeof ch.index === "number" ? ch.index : 0,
      delta: {
        ...(typeof delta.role === "string" ? { role: delta.role } : {}),
        ...(typeof delta.content === "string" ? { content: delta.content } : {}),
        ...(typeof delta.reasoning_content === "string" ? { reasoning_content: delta.reasoning_content } : {}),
        ...(Array.isArray(delta.tool_calls) ? { tool_calls: delta.tool_calls as ChatChunk["choices"][number]["delta"]["tool_calls"] } : {}),
      },
      ...(typeof ch.finish_reason === "string" ? { finish_reason: ch.finish_reason } : {}),
    };
  });
  const usage = raw.usage as Record<string, unknown> | undefined;
  return {
    id: typeof raw.id === "string" ? raw.id : "chatcmpl_1",
    model: typeof raw.model === "string" ? raw.model : "",
    created: typeof raw.created === "number" ? raw.created : Math.floor(Date.now() / 1000),
    choices,
    ...(usage ? { usage: { prompt_tokens: num(usage.prompt_tokens), completion_tokens: num(usage.completion_tokens), total_tokens: num(usage.total_tokens) } } : {}),
  };
}

export function parseChatChunkJSON(line: string): ChatChunk | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  return parseChatChunk(obj);
}

/** Render a chat chunk as a chat.completion.chunk SSE payload. */
export function renderChatChunk(chunk: ChatChunk): string {
  return JSON.stringify(chunk);
}

/** Render a complete chat completion as JSON. */
export function renderChatCompletion(completion: ChatCompletion): string {
  return JSON.stringify(completion);
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
