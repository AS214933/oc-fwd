/**
 * Mock opencode zen gateway. Records every request and lets each test decide
 * exactly what to return for any path/protocol.
 */


export interface MockRequest {
  path: string;
  body: unknown;
  headers: Headers;
}

export interface MockContext {
  path: string;
  body: unknown;
  stream: boolean;
  model: string;
  auth?: string;
}

export class MockZen {
  requests: MockRequest[] = [];
  server: ReturnType<typeof Bun.serve>;
  handler: (ctx: MockContext) => Response | Promise<Response> = () => new Response("not found", { status: 404 });

  constructor(handler: (ctx: MockContext) => Response | Promise<Response>) {
    this.setHandler(handler);
    this.server = Bun.serve({
      port: 0,
      development: false,
      idleTimeout: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const rawPath = url.pathname;
        const path = rawPath.startsWith("/zen/v1") ? rawPath.slice("/zen/v1".length) : rawPath;
        const raw = await req.text();
        let body: unknown = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = raw;
        }
        this.requests.push({ path, body, headers: req.headers });
        const model = (body as { model?: string })?.model ?? "";
        const ctx: MockContext = {
          path,
          body,
          stream: (body as { stream?: boolean })?.stream === true,
          model,
          auth: req.headers.get("Authorization") ?? undefined,
        };
        return this.handler(ctx);
      },
    });
  }

  setHandler(handler: (ctx: MockContext) => Response | Promise<Response>) {
    this.handler = handler;
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}/zen/v1`;
  }

  last(): MockRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  clear() {
    this.requests = [];
  }

  stop() {
    this.server.stop(true);
  }
}

// ---------------------------------------------------------------------------
// canned response builders
// ---------------------------------------------------------------------------

export function chatCompletionJson(model: string, content: string, toolCalls?: Array<{ id: string; name: string; arguments: string }>) {
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    model,
    created: 1700000000,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls ? null : content,
          ...(toolCalls ? { tool_calls: toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) } : {}),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

export function chatSSE(model: string, parts: Array<{ content?: string; reasoning?: string; toolCall?: { id: string; name: string; arguments: string } }>, usage = true) {
  const chunks: unknown[] = [];
  chunks.push({ id: "chatcmpl_1", object: "chat.completion.chunk", model, created: 1700000000, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  let idx = 0;
  for (const part of parts) {
    if (part.reasoning) {
      chunks.push({ id: "chatcmpl_1", object: "chat.completion.chunk", model, created: 1700000000, choices: [{ index: 0, delta: { reasoning_content: part.reasoning } }] });
    }
    if (part.content) {
      chunks.push({ id: "chatcmpl_1", object: "chat.completion.chunk", model, created: 1700000000, choices: [{ index: 0, delta: { content: part.content } }] });
    }
    if (part.toolCall) {
      chunks.push({
        id: "chatcmpl_1", object: "chat.completion.chunk", model, created: 1700000000,
        choices: [{ index: 0, delta: { tool_calls: [{ index: idx++, id: part.toolCall.id, type: "function", function: { name: part.toolCall.name, arguments: part.toolCall.arguments } }] } }],
      });
    }
  }
  const final: Record<string, unknown> = {
    id: "chatcmpl_1", object: "chat.completion.chunk", model, created: 1700000000,
    choices: [{ index: 0, delta: {}, finish_reason: parts.some((p) => p.toolCall) ? "tool_calls" : "stop" }],
  };
  if (usage) final.usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  chunks.push(final);
  return sseResponse(chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n") + "\n\ndata: [DONE]\n\n");
}

export function responsesJson(model: string, output: unknown[], usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 }) {
  return {
    id: "resp_123",
    object: "response",
    created_at: 1700000000,
    status: "completed",
    model,
    output,
    usage,
  };
}

export function responsesMessage(text: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function responsesFunctionCall(id: string, name: string, args: string) {
  return { id: `fc_${id}`, type: "function_call", status: "completed", call_id: id, name, arguments: args };
}

export function responsesSSE(model: string, parts: Array<{ text?: string; toolCall?: { id: string; name: string; arguments: string } }>) {
  const lines: string[] = [];
  const created = { id: "resp_123", object: "response", created_at: 1700000000, status: "in_progress", model, output: [] };
  lines.push(JSON.stringify({ type: "response.created", response: created }));
  lines.push(JSON.stringify({ type: "response.in_progress", response: created }));
  let outIdx = 0;
  let textAccum = "";
  let toolIdx = 0;
  const output: unknown[] = [];
  for (const part of parts) {
    if (part.text) {
      if (outIdx === 0) {
        lines.push(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] } }));
        lines.push(JSON.stringify({ type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
      }
      textAccum += part.text;
      lines.push(JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: part.text }));
    }
    if (part.toolCall) {
      const item = { id: `fc_${toolIdx + 1}`, type: "function_call", status: "in_progress", call_id: part.toolCall.id, name: part.toolCall.name, arguments: "" };
      lines.push(JSON.stringify({ type: "response.output_item.added", output_index: toolIdx + 1, item }));
      lines.push(JSON.stringify({ type: "response.function_call_arguments.delta", item_id: `fc_${toolIdx + 1}`, output_index: toolIdx + 1, delta: part.toolCall.arguments }));
      toolIdx++;
    }
  }
  if (outIdx === 0) outIdx = 1;
  if (textAccum) {
    lines.push(JSON.stringify({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: textAccum }));
    lines.push(JSON.stringify({ type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: textAccum, annotations: [] } }));
    const msgItem = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: textAccum, annotations: [] }] };
    lines.push(JSON.stringify({ type: "response.output_item.done", output_index: 0, item: msgItem }));
    output.push(msgItem);
  }
  const completed = { id: "resp_123", object: "response", created_at: 1700000000, status: "completed", model, output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  lines.push(JSON.stringify({ type: "response.completed", response: completed }));
  return sseResponse(lines.map((l) => `data: ${l}\n\n`).join(""));
}

export function messagesJson(model: string, text: string, toolUse?: { id: string; name: string; input: unknown }) {
  return {
    id: "msg_123",
    type: "message",
    role: "assistant",
    model,
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...(toolUse ? [{ type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input }] : []),
    ],
    stop_reason: toolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

export function messagesSSE(model: string, parts: Array<{ text?: string; toolUse?: { id: string; name: string; input: string } }>) {
  const lines: string[] = [];
  lines.push(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_123", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`);
  let block = 0;
  for (const part of parts) {
    if (part.text) {
      lines.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: block, content_block: { type: "text", text: "" } })}\n\n`);
      lines.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: block, delta: { type: "text_delta", text: part.text } })}\n\n`);
      lines.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: block })}\n\n`);
      block++;
    }
    if (part.toolUse) {
      lines.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: block, content_block: { type: "tool_use", id: part.toolUse.id, name: part.toolUse.name, input: {} } })}\n\n`);
      lines.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: block, delta: { type: "input_json_delta", partial_json: part.toolUse.input } })}\n\n`);
      lines.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: block })}\n\n`);
      block++;
    }
  }
  lines.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: parts.some((p) => p.toolUse) ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`);
  lines.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  return sseTextResponse(lines.join(""));
}

export function geminiJson(model: string, text: string) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    modelVersion: model,
  };
}

export function geminiSSE(model: string, text: string) {
  const a = JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: text.slice(0, Math.ceil(text.length / 2)) }] } }] });
  const b = JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: text.slice(Math.ceil(text.length / 2)) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    modelVersion: model,
  });
  return sseResponse(`data: ${a}\n\ndata: ${b}\n\n`);
}

export function sseResponse(payload: string): Response {
  return new Response(payload, { headers: { "Content-Type": "text/event-stream" } });
}

export function sseTextResponse(payload: string): Response {
  return new Response(payload, { headers: { "Content-Type": "text/event-stream" } });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
