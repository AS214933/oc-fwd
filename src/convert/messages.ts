/**
 * Anthropic Messages API <-> canonical Chat Completions conversion.
 */

import type { ChatCompletion, ChatMessage, ChatRequest } from "./types";
import { chatRole, contentToString, structuredParts } from "./types";

interface AnthropicBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

export interface MessagesRequest {
  model: string;
  system?: string;
  messages: Array<{ role: string; content: unknown }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  [key: string]: unknown;
}

export function parseMessagesRequest(raw: Record<string, unknown>): MessagesRequest {
  if (typeof raw.model !== "string") throw new Error("messages body requires a string \"model\"");
  const req: MessagesRequest = { model: raw.model, messages: [] };
  if (typeof raw.system === "string") req.system = raw.system;
  if (Array.isArray(raw.messages)) req.messages = raw.messages as MessagesRequest["messages"];
  for (const key of ["max_tokens", "temperature", "stream", "tools", "stop_sequences", "top_p", "thinking"]) {
    if (raw[key] !== undefined) (req as Record<string, unknown>)[key] = raw[key];
  }
  return req;
}

/** Convert an Anthropic Messages request to canonical Chat Completions. */
export function messagesToChatRequest(req: MessagesRequest): ChatRequest {
  const out: ChatRequest = { model: req.model, messages: [], stream: req.stream === true };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (typeof req.max_tokens === "number" && req.max_tokens > 0) out.max_tokens = req.max_tokens;
  if (req.thinking !== undefined) out.thinking = req.thinking;
  if (typeof req.system === "string" && req.system !== "") {
    out.messages.push({ role: "system", content: req.system });
  }
  for (const m of req.messages) {
    const role = chatRole(m.role) || "user";
    if (typeof m.content === "string") {
      out.messages.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    const blocks = m.content as AnthropicBlock[];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    const structured = blocks.filter(
      (b) => b.type !== "thinking" && b.type !== "tool_use" && b.type !== "tool_result",
    );
    const thinking = blocks.filter(
      (b) => b.type === "thinking" && typeof b.thinking === "string" && b.thinking !== "",
    );
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    const toolResults = blocks.filter((b) => b.type === "tool_result");
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        out.messages.push({
          role: "tool",
          tool_call_id: tr.tool_use_id ?? "",
          content: contentToString(tr.content),
        });
      }
      continue;
    }
    const msg: ChatMessage = { role, content: text };
    const parts = structuredParts(structured);
    if (parts) msg.parts = parts;
    if (thinking.length > 0) {
      msg.reasoning_content = thinking.map((b) => b.thinking as string).join("");
      const signature = thinking[thinking.length - 1]?.signature;
      if (typeof signature === "string" && signature !== "") msg.reasoning_signature = signature;
    }
    if (toolUses.length > 0) {
      msg.tool_calls = toolUses.map((tu, i) => ({
        id: tu.id ?? `toolu_${i + 1}`,
        type: "function",
        function: { name: tu.name ?? "", arguments: JSON.stringify(tu.input ?? {}) },
      }));
    }
    if (text !== "" || msg.parts || msg.tool_calls || msg.reasoning_content) out.messages.push(msg);
  }
  if (out.messages.length === 0) throw new Error("messages body produced no messages");
  if (Array.isArray(req.tools)) {
    out.tools = req.tools
      .filter((t) => t && typeof t.name === "string")
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.input_schema !== undefined ? { parameters: t.input_schema } : {}),
        },
      }));
  }
  return out;
}

/** Convert a canonical Chat Completions request to an Anthropic Messages body. */
export function chatToMessagesRequest(req: ChatRequest): Record<string, unknown> {
  const system: string[] = [];
  const messages: unknown[] = [];
  for (const msg of req.messages) {
    if (msg.role === "system") {
      if (msg.content) system.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: msg.tool_call_id ?? "", content: msg.content }],
      });
      continue;
    }
    const content: AnthropicBlock[] = [];
    if (msg.reasoning_content) {
      content.push({
        type: "thinking",
        thinking: msg.reasoning_content,
        ...(msg.reasoning_signature ? { signature: msg.reasoning_signature } : {}),
      });
    }
    if (Array.isArray(msg.parts) && msg.parts.length > 0) {
      for (const block of anthropicBlocksFromParts(msg.parts)) content.push(block);
    } else if (msg.content) {
      content.push({ type: "text", text: msg.content });
    }
    for (const tc of msg.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    messages.push({ role: msg.role === "assistant" ? "assistant" : "user", content });
  }
  const out: Record<string, unknown> = { model: req.model, messages };
  if (system.length > 0) out.system = system.join("\n\n");
  if (req.stream === true) out.stream = true;
  if (req.thinking !== undefined) out.thinking = req.thinking;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      ...(t.function.parameters !== undefined ? { input_schema: t.function.parameters } : {}),
    }));
  }
  return out;
}

/** Render canonical content parts as Anthropic content blocks. */
function anthropicBlocksFromParts(parts: unknown[]): AnthropicBlock[] {
  const out: AnthropicBlock[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : "";
    switch (type) {
      case "text":
        if (typeof p.text === "string") out.push({ type: "text", text: p.text });
        break;
      case "image":
      case "document":
        out.push(part as AnthropicBlock);
        break;
      case "image_url":
      case "input_image": {
        const url = type === "image_url"
          ? (p.image_url as Record<string, unknown>)?.url
          : p.image_url;
        if (typeof url === "string" && url.startsWith("data:")) {
          const comma = url.indexOf(",");
          const meta = comma > 0 ? url.slice(5, comma) : "";
          const mediaType = meta.split(";")[0] || "image/png";
          const data = comma > 0 ? url.slice(comma + 1) : "";
          if (data) out.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
        } else if (typeof url === "string" && url !== "") {
          out.push({ type: "image", source: { type: "url", url } });
        }
        break;
      }
      default:
        if (typeof p.text === "string") out.push({ type: "text", text: p.text });
        break;
    }
  }
  return out;
}

/** Parse a non-streaming Anthropic Messages response into canonical chat completion. */
export function parseMessagesResponse(data: Record<string, unknown>): ChatCompletion {
  const content = Array.isArray(data.content) ? (data.content as AnthropicBlock[]) : [];
  const message: ChatMessage = { role: "assistant", content: "" };
  const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
  let thinking = "";
  let thinkingSignature: string | undefined;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      message.content = (message.content ? message.content + block.text : block.text) as string;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? `toolu_${toolCalls.length + 1}`,
        type: "function",
        function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
      });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      thinking += block.thinking;
      if (typeof block.signature === "string" && block.signature !== "") thinkingSignature = block.signature;
    }
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (thinking !== "") message.reasoning_content = thinking;
  if (thinkingSignature !== undefined) message.reasoning_signature = thinkingSignature;
  const stop = typeof data.stop_reason === "string" ? data.stop_reason : "end_turn";
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  return {
    id: typeof data.id === "string" ? data.id : "msg_1",
    object: "chat.completion",
    model: typeof data.model === "string" ? data.model : "",
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message,
        finish_reason: stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: num(usage.input_tokens),
      completion_tokens: num(usage.output_tokens),
      total_tokens: num(usage.input_tokens) + num(usage.output_tokens),
    },
  };
}

/** Render a canonical chat completion as an Anthropic Messages response. */
export function renderChatCompletionAsMessages(completion: ChatCompletion): Record<string, unknown> {
  const msg = completion.choices[0]?.message;
  const content: AnthropicBlock[] = [];
  if (msg?.reasoning_content) {
    content.push({
      type: "thinking",
      thinking: msg.reasoning_content,
      ...(msg.reasoning_signature ? { signature: msg.reasoning_signature } : {}),
    });
  }
  if (msg?.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  const finish = completion.choices[0]?.finish_reason ?? "stop";
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: completion.model,
    content,
    stop_reason: finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
