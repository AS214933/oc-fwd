/**
 * Streaming conversion machinery.
 *
 * Every protocol stream is normalized to the canonical ChatChunk event and
 * then re-encoded into the target protocol's SSE shape:
 *
 *   responses SSE <-> ChatChunk <-> messages SSE <-> ChatChunk <-> gemini SSE
 *
 * so any inbound protocol can talk to any model family without pairwise
 * converter explosion.
 */

import type { ChatChunk, ChatCompletion, ChatUsage } from "./types";
import { parseChatChunkJSON } from "./chat";
import { geminiFinish, parseGeminiChunk } from "./gemini";

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parse an SSE byte stream into events (data:/event: fields, \n\n separated).
 *  Consumes bytes from a sliding window instead of re-slicing the whole
 *  remaining buffer after every line, so high-throughput token streams stay
 *  linear even when the upstream emits many small events. */
export async function* readSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let start = 0;
  let event = "";
  let dataLines: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n", start)) >= 0) {
        const line = buf.slice(start, idx).replace(/\r$/, "");
        start = idx + 1;
        if (line === "") {
          if (dataLines.length > 0) {
            yield { event: event || undefined, data: dataLines.join("\n") };
            event = "";
            dataLines = [];
          }
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") dataLines.push(value);
      }
      // Drop consumed bytes once they outgrow a small threshold, keeping the
      // retained buffer bounded without copying on every line.
      if (start > 65536) {
        buf = buf.slice(start);
        start = 0;
      }
    }
    if (dataLines.length > 0) yield { event: event || undefined, data: dataLines.join("\n") };
  } finally {
    reader.releaseLock();
  }
}

/** Serialize one SSE event into wire text. */
export function sseText(event: string | undefined, data: string): string {
  const out: string[] = [];
  if (event) out.push(`event: ${event}`);
  out.push(`data: ${data}`, "", "");
  return out.join("\n");
}

export function sseData(data: string): string {
  return `data: ${data}\n\n`;
}

function usageOf(chunk: ChatChunk): ChatUsage | undefined {
  return chunk.usage;
}

// ---------------------------------------------------------------------------
// responses SSE -> ChatChunk
// ---------------------------------------------------------------------------

interface PendingTool {
  id: string;
  name: string;
  args: string;
}

/** Convert Responses API SSE events into canonical chat chunks. */
export async function* responsesToChatChunks(events: AsyncGenerator<SseEvent>): AsyncGenerator<ChatChunk> {
  let id = "chatcmpl_1";
  let model = "";
  let created = Math.floor(Date.now() / 1000);
  let tools = new Map<number, PendingTool>();
  let usage: ChatUsage | undefined;
  let sentRole = false;

  for await (const ev of events) {
    if (ev.data === "[DONE]") continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (payload.type) {
      case "response.created":
      case "response.in_progress": {
        const resp = (payload.response ?? {}) as Record<string, unknown>;
        if (typeof resp.id === "string") id = resp.id;
        if (typeof resp.model === "string") model = resp.model;
        if (typeof resp.created_at === "number") created = resp.created_at;
        break;
      }
      case "response.output_item.added": {
        const item = (payload.item ?? {}) as Record<string, unknown>;
        const idx = typeof payload.output_index === "number" ? payload.output_index : 0;
        if (item.type === "function_call") {
          const tc: PendingTool = {
            id: typeof item.call_id === "string" ? item.call_id : (typeof item.id === "string" ? item.id : `call_${idx + 1}`),
            name: typeof item.name === "string" ? item.name : "",
            args: "",
          };
          tools.set(idx, tc);
          yield makeChunk(id, model, created, [
            {
              index: 0,
              delta: { tool_calls: [{ index: idx, id: tc.id, type: "function", function: { name: tc.name } }] },
            },
          ]);
        } else if (item.type === "message" && !sentRole) {
          sentRole = true;
          yield makeChunk(id, model, created, [{ index: 0, delta: { role: typeof item.role === "string" ? item.role : "assistant" } }]);
        }
        break;
      }
      case "response.content_part.added":
        break;
      case "response.output_text.delta": {
        const text = typeof payload.delta === "string" ? payload.delta : "";
        if (text) yield makeChunk(id, model, created, [{ index: 0, delta: { content: text } }]);
        break;
      }
      case "response.function_call_arguments.delta": {
        const idx = typeof payload.output_index === "number" ? payload.output_index : 0;
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const t = tools.get(idx);
        if (t) t.args += delta;
        if (delta) {
          yield makeChunk(id, model, created, [
            { index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: delta } }] } },
          ]);
        }
        break;
      }
      case "response.output_text.done":
      case "response.content_part.done":
      case "response.output_item.done":
        break;
      case "response.completed": {
        const resp = (payload.response ?? {}) as Record<string, unknown>;
        const u = resp.usage as Record<string, unknown> | undefined;
        if (u) {
          usage = {
            prompt_tokens: num(u.input_tokens),
            completion_tokens: num(u.output_tokens),
            total_tokens: num(u.total_tokens),
          };
        }
        break;
      }
      case "response.failed": {
        yield makeChunk(id, model, created, [{ index: 0, delta: {}, finish_reason: "stop" }]);
        return;
      }
    }
  }
  const finishChunk = makeChunk(id, model, created, [{ index: 0, delta: {}, finish_reason: "stop" }]);
  if (usage) finishChunk.usage = usage;
  yield finishChunk;
}

// ---------------------------------------------------------------------------
// messages SSE -> ChatChunk
// ---------------------------------------------------------------------------

/** Convert Anthropic Messages SSE events into canonical chat chunks. */
export async function* messagesToChatChunks(events: AsyncGenerator<SseEvent>): AsyncGenerator<ChatChunk> {
  let id = "chatcmpl_1";
  let model = "";
  let created = Math.floor(Date.now() / 1000);
  let usage: ChatUsage | undefined;
  let stopReason = "end_turn";
  let sentRole = false;
  let toolName = new Map<number, string>();

  for await (const ev of events) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (payload.type) {
      case "message_start": {
        const msg = (payload.message ?? {}) as Record<string, unknown>;
        if (typeof msg.id === "string") id = msg.id;
        if (typeof msg.model === "string") model = msg.model;
        const u = msg.usage as Record<string, unknown> | undefined;
        if (u) {
          usage = {
            prompt_tokens: num(u.input_tokens),
            completion_tokens: num(u.output_tokens),
            total_tokens: num(u.input_tokens) + num(u.output_tokens),
          };
        }
        if (!sentRole) {
          sentRole = true;
          yield makeChunk(id, model, created, [{ index: 0, delta: { role: "assistant" } }]);
        }
        break;
      }
      case "content_block_start": {
        const block = (payload.content_block ?? {}) as Record<string, unknown>;
        const idx = typeof payload.index === "number" ? payload.index : 0;
        if (block.type === "tool_use") {
          toolName.set(idx, typeof block.name === "string" ? block.name : "");
          yield makeChunk(id, model, created, [
            {
              index: 0,
              delta: {
                tool_calls: [{
                  index: idx,
                  id: typeof block.id === "string" ? block.id : `call_${idx + 1}`,
                  type: "function",
                  function: { name: toolName.get(idx) },
                }],
              },
            },
          ]);
        }
        break;
      }
      case "content_block_delta": {
        const delta = (payload.delta ?? {}) as Record<string, unknown>;
        const idx = typeof payload.index === "number" ? payload.index : 0;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          yield makeChunk(id, model, created, [{ index: 0, delta: { content: delta.text } }]);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json) {
          yield makeChunk(id, model, created, [
            { index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: delta.partial_json } }] } },
          ]);
        }
        break;
      }
      case "content_block_stop":
        break;
      case "message_delta": {
        const d = (payload.delta ?? {}) as Record<string, unknown>;
        if (typeof d.stop_reason === "string") stopReason = d.stop_reason;
        const u = payload.usage as Record<string, unknown> | undefined;
        if (u && typeof u.output_tokens === "number") {
          usage = {
            prompt_tokens: usage?.prompt_tokens ?? 0,
            completion_tokens: u.output_tokens,
            total_tokens: (usage?.prompt_tokens ?? 0) + u.output_tokens,
          };
        }
        break;
      }
      case "message_stop":
        break;
      case "error":
        break;
    }
  }
  const finishChunk = makeChunk(id, model, created, [
    { index: 0, delta: {}, finish_reason: anthropicStopToFinish(stopReason) },
  ]);
  if (usage) finishChunk.usage = usage;
  yield finishChunk;
}

function anthropicStopToFinish(stop: string): string {
  switch (stop) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// gemini SSE -> ChatChunk
// ---------------------------------------------------------------------------

/** Convert Gemini generateContent SSE chunks into canonical chat chunks. */
export async function* geminiToChatChunks(events: AsyncGenerator<SseEvent>): AsyncGenerator<ChatChunk> {
  const id = "chatcmpl_gemini";
  const created = Math.floor(Date.now() / 1000);
  let model = "";
  let toolIdx = 0;
  let finishSent = false;
  let usage: ChatUsage | undefined;

  for await (const ev of events) {
    if (ev.data === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const chunk = parseGeminiChunk(payload);
    for (const part of chunk.parts) {
      if (typeof part.text === "string" && part.text) {
        yield makeChunk(id, model, created, [{ index: 0, delta: { content: part.text } }]);
      }
      if (part.functionCall) {
        const idx = toolIdx++;
        yield makeChunk(id, model, created, [
          {
            index: 0,
            delta: {
              tool_calls: [{
                index: idx,
                id: `call_${idx + 1}`,
                type: "function",
                function: {
                  name: part.functionCall.name ?? "",
                  arguments: JSON.stringify(part.functionCall.args ?? {}),
                },
              }],
            },
          },
        ]);
      }
    }
    if (chunk.usage) {
      usage = {
        prompt_tokens: num(chunk.usage.promptTokenCount),
        completion_tokens: num(chunk.usage.candidatesTokenCount),
        total_tokens: num(chunk.usage.totalTokenCount),
      };
    }
    if (chunk.finishReason && !finishSent) {
      finishSent = true;
      const finish = makeChunk(id, model, created, [
        { index: 0, delta: {}, finish_reason: geminiFinish(chunk.finishReason, false) },
      ]);
      if (usage) finish.usage = usage;
      yield finish;
    }
  }
  if (!finishSent) {
    const finish = makeChunk(id, model, created, [{ index: 0, delta: {}, finish_reason: "stop" }]);
    if (usage) finish.usage = usage;
    yield finish;
  }
}

// ---------------------------------------------------------------------------
// ChatChunk -> responses SSE
// ---------------------------------------------------------------------------

interface ResponsesToolState {
  index: number;
  id: string;
  name: string;
  args: string;
  added: boolean;
  doneIdx: number;
}

/**
 * Convert canonical chat chunks into Responses API SSE events. Mirrors the
 * event sequence codex/opencode expect: response.created -> ... ->
 * response.completed.
 */
export async function* chatChunksToResponses(chunks: AsyncGenerator<ChatChunk>): AsyncGenerator<SseEvent> {
  let started = false;
  let finished = false;
  let model = "";
  let createdAt = Math.floor(Date.now() / 1000);
  let msgAdded = false;
  let text = "";
  let msgIndex = 0;
  let toolSeen = 0;
  const tools = new Map<number, ResponsesToolState>();
  let usage: ChatUsage | undefined;

  const respEvent = (typ: string, response: Record<string, unknown>): SseEvent => ({
    event: undefined,
    data: JSON.stringify({ type: typ, response }),
  });
  const event = (typ: string, payload: Record<string, unknown>): SseEvent => ({
    event: undefined,
    data: JSON.stringify({ type: typ, ...payload }),
  });

  const responseUsage = (): Record<string, unknown> | undefined => {
    if (!usage) return undefined;
    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    return {
      input_tokens: input,
      output_tokens: output,
      total_tokens: usage.total_tokens ?? input + output,
    };
  };
  const responseBody = (status: string, output: unknown[]): Record<string, unknown> => ({
    id: "resp_1",
    object: "response",
    created_at: createdAt,
    status,
    model,
    output,
    usage: responseUsage(),
  });

  const finishEvents = (): SseEvent[] => {
    if (finished) return [];
    finished = true;
    const events: SseEvent[] = [];
    const output: unknown[] = [];
    if (msgAdded) {
      events.push(event("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text }));
      events.push(event("response.content_part.done", {
        item_id: "msg_1", output_index: 0, content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      }));
      const msgItem = {
        id: "msg_1", type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      events.push(event("response.output_item.done", { output_index: 0, item: msgItem }));
      output.push(msgItem);
    }
    const sortedTools = [...tools.values()].sort((a, b) => a.index - b.index);
    for (const t of sortedTools) {
      const item = {
        id: `fc_${t.doneIdx}`, type: "function_call", status: "completed",
        call_id: t.id, name: t.name, arguments: t.args,
      };
      events.push(event("response.function_call_arguments.done", {
        item_id: `fc_${t.doneIdx}`, output_index: t.index, arguments: t.args,
      }));
      events.push(event("response.output_item.done", { output_index: t.index, item }));
      output.push(item);
    }
    events.push(respEvent("response.completed", responseBody("completed", output)));
    return events;
  };

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    if (chunk.model) model = chunk.model;
    if (chunk.created) createdAt = chunk.created;
    if (!started) {
      started = true;
      yield respEvent("response.created", responseBody("in_progress", []));
      yield respEvent("response.in_progress", responseBody("in_progress", []));
    }
    const choice = chunk.choices[0];
    if (!choice) continue;
    const d = choice.delta;
    if (d.content) {
      if (!msgAdded) {
        msgAdded = true;
        yield event("response.output_item.added", {
          output_index: 0,
          item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] },
        });
        yield event("response.content_part.added", {
          item_id: "msg_1", output_index: 0, content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }
      text += d.content;
      yield event("response.output_text.delta", {
        item_id: "msg_1", output_index: 0, content_index: 0, delta: d.content,
      });
    }
    for (const tc of d.tool_calls ?? []) {
      const index = tc.index ?? tools.size;
      let t = tools.get(index);
      if (!t) {
        t = { index, id: tc.id ?? `call_${index + 1}`, name: "", args: "", added: false, doneIdx: -1 };
        tools.set(index, t);
      }
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name = tc.function.name;
      if (tc.function?.arguments) t.args += tc.function.arguments;
      if (!t.added) {
        t.added = true;
        toolSeen++;
        t.doneIdx = toolSeen;
        const item = {
          id: `fc_${t.doneIdx}`, type: "function_call", status: "in_progress",
          call_id: t.id, name: t.name, arguments: "",
        };
        yield event("response.output_item.added", { output_index: t.index, item });
      }
      if (tc.function?.arguments) {
        yield event("response.function_call_arguments.delta", {
          item_id: `fc_${t.doneIdx}`, output_index: t.index, delta: tc.function.arguments,
        });
      }
    }
    if (choice.finish_reason) {
      for (const ev of finishEvents()) yield ev;
    }
  }
  for (const ev of finishEvents()) yield ev;
}

// ---------------------------------------------------------------------------
// ChatChunk -> messages SSE
// ---------------------------------------------------------------------------

/** Convert canonical chat chunks into Anthropic Messages SSE events. */
export async function* chatChunksToMessages(chunks: AsyncGenerator<ChatChunk>): AsyncGenerator<SseEvent> {
  let started = false;
  let finished = false;
  let model = "";
  let nextBlock = 0;
  let textBlock = -1;
  const toolBlocks = new Map<number, { block: number; id: string; name: string }>();
  let usage: ChatUsage | undefined;

  const ev = (type: string, payload: Record<string, unknown>): SseEvent => ({
    event: type,
    data: JSON.stringify({ type, ...payload }),
  });

  const stopBlocks = (): SseEvent[] => {
    const out: SseEvent[] = [];
    for (let i = 0; i < nextBlock; i++) out.push(ev("content_block_stop", { index: i }));
    return out;
  };

  for await (const chunk of chunks) {
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    if (!started) {
      started = true;
      yield ev("message_start", {
        message: {
          id: "msg_1", type: "message", role: "assistant", model,
          content: [], usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: 0 },
        },
      });
    }
    const choice = chunk.choices[0];
    if (!choice) continue;
    const d = choice.delta;
    if (d.content) {
      if (textBlock < 0) {
        textBlock = nextBlock++;
        yield ev("content_block_start", { index: textBlock, content_block: { type: "text", text: "" } });
      }
      yield ev("content_block_delta", { index: textBlock, delta: { type: "text_delta", text: d.content } });
    }
    for (const tc of d.tool_calls ?? []) {
      const key = tc.index ?? 0;
      let tb = toolBlocks.get(key);
      if (!tb) {
        const block = nextBlock++;
        tb = { block, id: tc.id ?? `toolu_${block + 1}`, name: tc.function?.name ?? "" };
        toolBlocks.set(key, tb);
        yield ev("content_block_start", {
          index: block, content_block: { type: "tool_use", id: tb.id, name: tb.name, input: {} },
        });
      } else {
        if (tc.id) tb.id = tc.id;
        if (tc.function?.name) tb.name = tc.function.name;
      }
      if (tc.function?.arguments) {
        yield ev("content_block_delta", { index: tb.block, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
      }
    }
    if (choice.finish_reason && !finished) {
      finished = true;
      for (const e of stopBlocks()) yield e;
      yield ev("message_delta", {
        delta: { stop_reason: finishToAnthropic(choice.finish_reason), stop_sequence: null },
        ...(usage ? { usage: { output_tokens: usage.completion_tokens } } : {}),
      });
      yield ev("message_stop", {});
    }
  }
  if (!finished) {
    finished = true;
    for (const e of stopBlocks()) yield e;
    yield ev("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      ...(usage ? { usage: { output_tokens: usage.completion_tokens } } : {}),
    });
    yield ev("message_stop", {});
  }
}

function finishToAnthropic(finish: string): string {
  switch (finish) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

// ---------------------------------------------------------------------------
// ChatChunk -> gemini SSE
// ---------------------------------------------------------------------------

/** Convert canonical chat chunks into Gemini generateContent SSE chunks. */
export async function* chatChunksToGemini(chunks: AsyncGenerator<ChatChunk>): AsyncGenerator<SseEvent> {
  let started = false;
  const toolArgs = new Map<number, { name: string; args: string }>();
  let usage: ChatUsage | undefined;

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    const d = choice.delta;
    if (d.content) {
      started = true;
      yield { event: undefined, data: JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: d.content }] } }],
      }) };
    }
    for (const tc of d.tool_calls ?? []) {
      const index = tc.index ?? toolArgs.size;
      const existing = toolArgs.get(index) ?? { name: "", args: "" };
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.args += tc.function.arguments;
      toolArgs.set(index, existing);
    }
    if (choice.finish_reason) {
      const parts: Array<Record<string, unknown>> = [];
      for (const t of [...toolArgs.values()]) {
        let args: unknown = {};
        try {
          args = JSON.parse(t.args);
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: t.name, args } });
      }
      if (parts.length > 0) {
        started = true;
        yield { event: undefined, data: JSON.stringify({
          candidates: [{ content: { role: "model", parts } }],
        }) };
      }
      const final: Record<string, unknown> = {
        candidates: [{
          content: { role: "model", parts: [] },
          ...(parts.length > 0 ? { finishReason: "TOOL_CALLS" } : { finishReason: "STOP" }),
        }],
      };
      if (usage) {
        final.usageMetadata = {
          promptTokenCount: usage.prompt_tokens,
          candidatesTokenCount: usage.completion_tokens,
          totalTokenCount: usage.total_tokens,
        };
      }
      yield { event: undefined, data: JSON.stringify(final) };
      started = false;
      toolArgs.clear();
      usage = undefined;
    }
  }
  if (started) {
    const final: Record<string, unknown> = {
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
    };
    if (usage) {
      final.usageMetadata = {
        promptTokenCount: usage.prompt_tokens,
        candidatesTokenCount: usage.completion_tokens,
        totalTokenCount: usage.total_tokens,
      };
    }
    yield { event: undefined, data: JSON.stringify(final) };
  }
}

// ---------------------------------------------------------------------------
// Non-streaming fallbacks: render a complete completion as SSE sequences
// ---------------------------------------------------------------------------

/** Render a complete chat completion as a minimal Responses SSE sequence. */
export function renderResponsesEventsFromCompletion(completion: ChatCompletion): SseEvent[] {
  const resp: Record<string, unknown> = {
    id: "resp_1",
    object: "response",
    created_at: completion.created,
    model: completion.model,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
      total_tokens: completion.usage?.total_tokens ?? 0,
    },
  };
  const output: unknown[] = [];
  const msg = completion.choices[0]?.message;
  if (msg?.content) {
    output.push({
      id: "msg_1", type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: msg.content, annotations: [] }],
    });
  }
  (msg?.tool_calls ?? []).forEach((tc, i) => {
    output.push({
      id: `fc_${i + 1}`, type: "function_call", status: "completed",
      call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
    });
  });
  resp.output = output;
  const created = { ...resp, status: "in_progress", output: [] };
  return [
    { event: undefined, data: JSON.stringify({ type: "response.created", response: created }) },
    { event: undefined, data: JSON.stringify({ type: "response.completed", response: resp }) },
  ];
}

/** Render a complete chat completion as an Anthropic Messages SSE sequence. */
export function renderMessagesEventsFromCompletion(completion: ChatCompletion): SseEvent[] {
  const msg = completion.choices[0]?.message;
  const events: SseEvent[] = [];
  events.push({
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_1", type: "message", role: "assistant", model: completion.model,
        content: [], usage: { input_tokens: completion.usage?.prompt_tokens ?? 0, output_tokens: 0 },
      },
    }),
  });
  if (msg?.content) {
    events.push({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) });
    events.push({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: msg.content } }) });
    events.push({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) });
  }
  (msg?.tool_calls ?? []).forEach((tc, i) => {
    events.push({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: i + 1, content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} } }) });
    events.push({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: i + 1, delta: { type: "input_json_delta", partial_json: tc.function.arguments } }) });
    events.push({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: i + 1 }) });
  });
  events.push({
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: finishToAnthropic(completion.choices[0]?.finish_reason ?? "stop"), stop_sequence: null },
      usage: { output_tokens: completion.usage?.completion_tokens ?? 0 },
    }),
  });
  events.push({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
  return events;
}

/** Render a complete chat completion as one Gemini generateContent chunk. */
export function renderGeminiEventFromCompletion(completion: ChatCompletion): SseEvent {
  const msg = completion.choices[0]?.message;
  const parts: Array<Record<string, unknown>> = [];
  if (msg?.content) parts.push({ text: msg.content });
  for (const tc of msg?.tool_calls ?? []) {
    let args: unknown = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      args = {};
    }
    parts.push({ functionCall: { name: tc.function.name, args } });
  }
  const finish = completion.choices[0]?.finish_reason ?? "stop";
  const payload: Record<string, unknown> = {
    candidates: [{
      content: { role: "model", parts },
      finishReason: finish === "tool_calls" ? "TOOL_CALLS" : finish === "length" ? "MAX_TOKENS" : "STOP",
    }],
  };
  if (completion.usage) {
    payload.usageMetadata = {
      promptTokenCount: completion.usage.prompt_tokens,
      candidatesTokenCount: completion.usage.completion_tokens,
      totalTokenCount: completion.usage.total_tokens,
    };
  }
  return { event: undefined, data: JSON.stringify(payload) };
}

function makeChunk(id: string, model: string, created: number, choices: ChatChunk["choices"]): ChatChunk {
  return { id, model, created, choices };
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** Parse chat SSE data payloads into chunks (passthrough path). */
export async function* chatSSEToChunks(events: AsyncGenerator<SseEvent>): AsyncGenerator<ChatChunk> {
  for await (const ev of events) {
    if (ev.data === "[DONE]") continue;
    const chunk = parseChatChunkJSON(ev.data);
    if (chunk) yield chunk;
  }
}
