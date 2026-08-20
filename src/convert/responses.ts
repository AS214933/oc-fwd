/**
 * OpenAI Responses API <-> canonical Chat Completions conversion.
 *
 * Inbound /v1/responses bodies (codex, opencode, ...) are normalized to chat
 * completions for the canonical pipeline, and upstream chat completions are
 * rendered back as Responses objects / SSE events so responses-only clients
 * can parse them.
 */

import type { ChatCompletion, ChatMessage, ChatRequest } from "./types";
import { chatRole, contentToString } from "./types";

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input?: unknown;
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  [key: string]: unknown;
}

interface InputItem {
  type?: string;
  role?: string;
  content?: unknown;
  text?: string;
  reasoning_content?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  output?: string;
}

/** Parse a raw /v1/responses request body. */
export function parseResponsesRequest(raw: Record<string, unknown>): ResponsesRequest {
  if (typeof raw.model !== "string") throw new Error("responses body requires a string \"model\"");
  const req: ResponsesRequest = {
    model: raw.model,
    stream: raw.stream === true,
  };
  for (const key of [
    "instructions", "input", "max_output_tokens", "temperature", "tools", "tool_choice",
    "parallel_tool_calls", "store", "include", "reasoning", "top_p", "metadata",
  ]) {
    if (raw[key] !== undefined) (req as Record<string, unknown>)[key] = raw[key];
  }
  return req;
}

/** Convert a parsed Responses request to canonical Chat Completions. */
export function responsesToChatRequest(req: ResponsesRequest): ChatRequest {
  const out: ChatRequest = { model: req.model, messages: [], stream: req.stream === true };
  let pendingReasoning = "";
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.max_output_tokens !== undefined) out.max_tokens = req.max_output_tokens;
  if (typeof req.instructions === "string" && req.instructions !== "") {
    out.messages.push({ role: "system", content: req.instructions });
  }
  const input = req.input;
  if (input === undefined || input === null || input === "") {
    throw new Error("responses input is empty");
  }
  if (typeof input === "string") {
    out.messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const itemRaw of input) {
      if (typeof itemRaw === "string") {
        out.messages.push({ role: "user", content: itemRaw });
        continue;
      }
      if (itemRaw === null || typeof itemRaw !== "object") continue;
      const item = itemRaw as InputItem;
      switch (item.type) {
        case "function_call": {
          const toolID = item.call_id || item.id || `call_${out.messages.length + 1}`;
          const args =
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {});
          const toolCall = { id: toolID, type: "function" as const, function: { name: item.name ?? "", arguments: args } };
          const previous = out.messages[out.messages.length - 1];
          let message: ChatMessage;
          if (previous?.role === "assistant") {
            message = previous;
          } else {
            message = { role: "assistant", content: "", tool_calls: [] };
            out.messages.push(message);
          }
          if (!message.tool_calls) message.tool_calls = [];
          message.tool_calls.push(toolCall);
          const rawReasoning = typeof item.reasoning_content === "string" ? item.reasoning_content : pendingReasoning;
          if (rawReasoning) {
            message.reasoning_content = (message.reasoning_content ?? "") + rawReasoning;
          }
          pendingReasoning = "";
          continue;
        }
        case "function_call_output": {
          pendingReasoning = "";
          out.messages.push({
            role: "tool",
            tool_call_id: item.call_id || item.id || "",
            content: typeof item.output === "string" ? item.output : "",
          });
          continue;
        }
        case "reasoning": {
          const rawReasoning = contentToString(item.content) || item.text || item.reasoning_content || "";
          pendingReasoning += rawReasoning;
          continue;
        }
      }
      const role = chatRole(item.role ?? "");
      const text = contentToString(item.content) || item.text || "";
      if (role && (item.type === "message" || item.content !== undefined || text !== "")) {
        const reasoningContent = role === "assistant"
          ? pendingReasoning || item.reasoning_content || ""
          : "";
        out.messages.push({
          role: role || "user",
          content: text,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        });
      }
      pendingReasoning = "";
    }
  } else {
    throw new Error("unsupported responses input");
  }
  if (out.messages.length === 0) throw new Error("responses input produced no messages");
  normalizeToolCallSequence(out.messages);
  if (Array.isArray(req.tools)) {
    const tools = out.tools ?? [];
    for (const t of req.tools) {
      const name = typeof t.name === "string" ? t.name : "";
      if (t.type !== "function" || !name) continue;
      tools.push({
        type: "function",
        function: {
          name,
          ...(typeof t.description === "string" ? { description: t.description } : {}),
          ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
        },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }
  return out;
}

/**
 * OpenAI Chat Completions requires every assistant message that declares
 * tool_calls to be followed by a role="tool" message answering each
 * call_id. Responses API clients often send a function_call entry without
 * its function_call_output in the same request (results arrive in the next
 * turn, or a parallel tool set is only partially answered), which would
 * otherwise be rejected upstream with
 * "assistant message with 'tool_calls' must be followed by tool messages".
 * Fill in empty tool responses so the sequence stays valid; already-paired
 * calls are left untouched.
 */
export function normalizeToolCallSequence(messages: ChatMessage[]) {
  // Pass 1: every tool_call_id that is answered by a role="tool" message
  // anywhere in the request.
  const answered = new Set<string>();
  for (const msg of messages) {
    if (msg && msg.role === "tool" && msg.tool_call_id) answered.add(msg.tool_call_id);
  }
  // Pass 2: assistant tool_calls whose id is NOT answered are missing their
  // result; remember the assistant message index so the empty tool message
  // can be inserted right after it (chat requires tool_calls -> tool adjacency).
  const pending = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant" || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      if (tc.id && !answered.has(tc.id) && !pending.has(tc.id)) pending.set(tc.id, i);
    }
  }
  if (pending.size === 0) return;
  // Pass 3: insert the missing tool messages, back-to-front so indices stay
  // valid while splicing.
  const inserts: Array<{ at: number; msg: ChatMessage }> = [];
  for (const [callId, ownerIdx] of pending) {
    inserts.push({ at: ownerIdx + 1, msg: { role: "tool", tool_call_id: callId, content: "" } });
  }
  inserts.sort((a, b) => a.at - b.at);
  for (let k = inserts.length - 1; k >= 0; k--) {
    const ins = inserts[k];
    if (!ins) continue;
    messages.splice(ins.at, 0, ins.msg);
  }
}

/** Convert a canonical Chat Completions request to a Responses request body. */
export function chatToResponsesRequest(req: ChatRequest): Record<string, unknown> {
  const instructions: string[] = [];
  const input: unknown[] = [];
  for (const msg of req.messages) {
    if (msg.role === "system") {
      if (msg.content) instructions.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      input.push({ type: "function_call_output", call_id: msg.tool_call_id ?? "", output: msg.content });
      continue;
    }
    if (msg.role === "assistant") {
      if (msg.reasoning_content) input.push(responsesReasoningItem(msg.reasoning_content));
      if (msg.tool_calls?.length) {
        if (msg.content) {
          input.push({ type: "message", role: "assistant", content: msg.content });
        }
        for (const tc of msg.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
        continue;
      }
      if (msg.content) {
        input.push({ type: "message", role: "assistant", content: msg.content });
      }
      continue;
    }
    input.push({ type: "message", role: msg.role === "developer" ? "developer" : msg.role, content: msg.content });
  }
  const out: Record<string, unknown> = { model: req.model, input };
  if (instructions.length > 0) out.instructions = instructions.join("\n\n");
  if (req.stream === true) out.stream = true;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.max_tokens !== undefined) out.max_output_tokens = req.max_tokens;
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      ...(t.function.parameters !== undefined ? { parameters: t.function.parameters } : {}),
    }));
  }
  if (req.tool_choice !== undefined) out.tool_choice = req.tool_choice;
  return out;
}

/** Parse a non-streaming Responses response into canonical chat completion. */
export function parseResponsesResponse(data: Record<string, unknown>): ChatCompletion {
  const output = Array.isArray(data.output) ? data.output : [];
  const message: ChatMessage = { role: "assistant", content: "" };
  const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
  let reasoningContent = "";
  for (const itemRaw of output) {
    const item = (itemRaw ?? {}) as Record<string, unknown>;
    switch (item.type) {
      case "message": {
        message.role = typeof item.role === "string" ? item.role : "assistant";
        message.content = contentToString(item.content);
        break;
      }
      case "function_call": {
        toolCalls.push({
          id: typeof item.call_id === "string" ? item.call_id : (typeof item.id === "string" ? item.id : `call_${toolCalls.length + 1}`),
          type: "function",
          function: {
            name: typeof item.name === "string" ? item.name : "",
            arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        });
        break;
      }
      case "reasoning":
        reasoningContent += contentToString(item.content);
        break;
    }
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoningContent) message.reasoning_content = reasoningContent;
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  return {
    id: typeof data.id === "string" ? data.id : "resp_1",
    object: "chat.completion",
    model: typeof data.model === "string" ? data.model : "",
    created: typeof data.created_at === "number" ? data.created_at : Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message,
        finish_reason: output.length === 0 || toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: num(usage.input_tokens),
      completion_tokens: num(usage.output_tokens),
      total_tokens: num(usage.total_tokens),
    },
  };
}

/** Render a canonical chat completion as a Responses response object. */
export function renderChatCompletionAsResponses(completion: ChatCompletion): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: "resp_1",
    object: "response",
    created_at: completion.created,
    status: "completed",
    model: completion.model,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
      total_tokens: completion.usage?.total_tokens ?? 0,
    },
  };
  const output: unknown[] = [];
  const msg = completion.choices[0]?.message;
  if (msg?.reasoning_content) {
    output.push(responsesReasoningItem(msg.reasoning_content));
  }
  if (msg && (msg.content !== "" || !msg.tool_calls?.length)) {
    output.push({
      id: "msg_1",
      type: "message",
      status: "completed",
      role: msg.role || "assistant",
      content: [{ type: "output_text", text: msg.content, annotations: [] }],
    });
  }
  (msg?.tool_calls ?? []).forEach((tc, i) => {
    output.push({
      id: `fc_${i + 1}`,
      type: "function_call",
      status: "completed",
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    });
  });
  out.output = output;
  return out;
}

function responsesReasoningItem(content: string): Record<string, unknown> {
  return {
    id: "rs_1",
    type: "reasoning",
    summary: [],
    content: [{ type: "reasoning_text", text: content }],
  };
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
