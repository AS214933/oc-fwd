import { describe, expect, test } from "bun:test";
import { responsesToChatRequest, chatToResponsesRequest, renderChatCompletionAsResponses } from "./responses";
import { messagesToChatRequest, chatToMessagesRequest } from "./messages";
import { parseChatCompletion, parseChatRequest } from "./chat";
import { chatToGeminiRequest } from "./gemini";
import { chatChunksToResponses, responsesToChatChunks, chatChunksToMessages, chatChunksToGemini, readSSE, type SseEvent } from "./stream";
import type { ChatChunk } from "./types";

const chunk = (partial: Partial<ChatChunk>): ChatChunk => ({
  id: "c1",
  model: "m",
  created: 1,
  choices: [],
  ...partial,
});

function collectEvents(gen: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
  return (async () => {
    const out: SseEvent[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
  })();
}

async function* scanEvents(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const ev of events) yield ev;
}

describe("responses -> chat request", () => {
  test("fills missing tool result so chat sequence stays valid", () => {
    const req = responsesToChatRequest({
      model: "gpt-5.5",
      input: [
        { type: "function_call", call_id: "call_1", name: "search", arguments: "{}" },
      ],
    });
    expect(req.messages).toEqual([
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "" },
    ]);
  });

  test("leaves paired call+output untouched", () => {
    const req = responsesToChatRequest({
      model: "gpt-5.5",
      input: [
        { type: "function_call", call_id: "call_1", name: "search", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "results" },
      ],
    });
    expect(req.messages).toEqual([
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "results" },
    ]);
  });

  test("fills only the missing parallel call result", () => {
    const req = responsesToChatRequest({
      model: "gpt-5.5",
      input: [
        { type: "function_call", call_id: "call_a", name: "search", arguments: "{}" },
        { type: "function_call", call_id: "call_b", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_a", output: "A-result" },
      ],
    });
    const answered = req.messages.filter((m) => m.role === "tool" && m.content !== "");
    const empty = req.messages.filter((m) => m.role === "tool" && m.content === "");
    expect(answered).toHaveLength(1);
    expect(answered[0]?.tool_call_id).toBe("call_a");
    expect(empty).toHaveLength(1);
    expect(empty[0]?.tool_call_id).toBe("call_b");
  });

  test("replays raw reasoning on the assistant message that owns tool calls", () => {
    const req = responsesToChatRequest({
      model: "deepseek-v4-flash-free",
      input: [
        {
          type: "reasoning",
          content: [
            { type: "reasoning_text", text: "inspect " },
            { type: "reasoning_text", text: "the repository" },
          ],
        },
        { type: "function_call", call_id: "call_a", name: "find", arguments: "{}" },
        { type: "function_call", call_id: "call_b", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "call_a", output: "a" },
        { type: "function_call_output", call_id: "call_b", output: "b" },
      ],
    });
    expect(req.messages[0]).toEqual({
      role: "assistant",
      content: "",
      reasoning_content: "inspect the repository",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "find", arguments: "{}" } },
        { id: "call_b", type: "function", function: { name: "read", arguments: "{}" } },
      ],
    });
  });

  test("instructions + input items + tools", () => {
    const req = responsesToChatRequest({
      model: "gpt-5.4",
      instructions: "be careful",
      max_output_tokens: 50,
      temperature: 0.2,
      input: [
        { type: "function_call", call_id: "c9", name: "lookup", arguments: JSON.stringify({ q: "x" }) },
        { type: "function_call_output", call_id: "c9", output: "found" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] },
      ],
      tools: [{ type: "function", name: "lookup", description: "find", parameters: { type: "object" } }],
    });
    expect(req.messages[0]).toEqual({ role: "system", content: "be careful" });
    expect(req.messages[1]?.role).toBe("assistant");
    expect(req.messages[1]?.tool_calls?.[0]?.id).toBe("c9");
    expect(req.messages[1]?.tool_calls?.[0]?.function.arguments).toBe(JSON.stringify({ q: "x" }));
    expect(req.messages[2]).toEqual({ role: "tool", tool_call_id: "c9", content: "found" });
    expect(req.messages[3]?.content).toBe("thanks");
    expect(req.max_tokens).toBe(50);
    expect(req.tools?.length).toBe(1);
  });

  test("developer role maps to system", () => {
    const req = responsesToChatRequest({
      model: "m",
      input: [{ type: "message", role: "developer", content: "be a pro" }],
    });
    expect(req.messages[0]?.role).toBe("system");
  });

  test("plain string input", () => {
    const req = responsesToChatRequest({ model: "m", input: "hello" });
    expect(req.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("chat -> responses request", () => {
  test("round trip preserves messages and adds output tokens", () => {
    const out = chatToResponsesRequest({
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
      max_tokens: 88,
    });
    expect(out.instructions).toBe("sys");
    expect(out.max_output_tokens).toBe(88);
    expect(out.input).toEqual([
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "hello" },
      { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ]);
  });

  test("preserves assistant tool-call reasoning as a Responses item", () => {
    const completion = parseChatCompletion({
      id: "chat_1",
      model: "deepseek-v4-flash-free",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "check the workspace",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "list", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
    });
    const output = renderChatCompletionAsResponses(completion).output as Array<Record<string, unknown>>;
    expect(output[0]).toEqual({
      id: "rs_1",
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: "check the workspace" }],
    });
    expect(output[1]?.type).toBe("function_call");
  });
});

describe("messages <-> chat", () => {
  test("anthropic tool_use/tool_result blocks", () => {
    const req = messagesToChatRequest({
      model: "claude-sonnet-4-5",
      system: "sys",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "tu1", name: "find", input: { q: "a" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "nothing" }] },
        { role: "user", content: "next" },
      ],
      tools: [{ name: "find", input_schema: { type: "object" } }],
    });
    expect(req.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(req.messages[1]?.role).toBe("assistant");
    expect(req.messages[1]?.content).toBe("checking");
    expect(req.messages[1]?.tool_calls?.[0]).toEqual({
      id: "tu1",
      type: "function",
      function: { name: "find", arguments: JSON.stringify({ q: "a" }) },
    });
    expect(req.messages[2]).toEqual({ role: "tool", tool_call_id: "tu1", content: "nothing" });
    expect(req.messages[3]?.content).toBe("next");
  });

  test("chat tool_calls -> anthropic tool_use", () => {
    const out = chatToMessagesRequest({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: JSON.stringify({ x: 1 }) } }],
        },
        { role: "tool", tool_call_id: "c1", content: "done" },
      ],
    });
    const blocks = out.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect((blocks[1]?.content[0] as { type: string; id: string; name: string; input: unknown }).type).toBe("tool_use");
    expect((blocks[1]?.content[0] as { input: unknown }).input).toEqual({ x: 1 });
    expect((blocks[2]?.content[0] as { type: string; tool_use_id: string }).type).toBe("tool_result");
    expect((blocks[2]?.content[0] as { tool_use_id: string }).tool_use_id).toBe("c1");
  });
});

describe("chat -> gemini request", () => {
  test("structure with system, roles, tools", () => {
    const out = chatToGeminiRequest({
      model: "gemini-3.5-flash",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
      max_tokens: 10,
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
    });
    expect(out.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    const contents = out.contents as Array<{ role: string }>;
    expect(contents[0]?.role).toBe("user");
    expect(contents[1]?.role).toBe("model");
    expect(out.generationConfig).toEqual({ maxOutputTokens: 10 });
    expect((out.tools as Array<{ functionDeclarations: unknown[] }>)[0]?.functionDeclarations).toHaveLength(1);
  });
});

describe("chat chunk -> responses SSE", () => {
  test("emits created, deltas, completed", async () => {
    async function* chunks() {
      yield chunk({ model: "gpt-5.4", choices: [{ index: 0, delta: { role: "assistant" } }] });
      yield chunk({ model: "gpt-5.4", choices: [{ index: 0, delta: { content: "he" } }] });
      yield chunk({ model: "gpt-5.4", choices: [{ index: 0, delta: { content: "llo" } }] });
      yield chunk({ model: "gpt-5.4", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    }
    const events = await collectEvents(chatChunksToResponses(chunks()));
    const types = events.map((e) => (JSON.parse(e.data) as { type: string }).type);
    expect(types[0]).toBe("response.created");
    expect(types[1]).toBe("response.in_progress");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.completed");
    const completed = JSON.parse(events[events.length - 1]!.data) as {
      response: { output: unknown[]; usage: { input_tokens: number; output_tokens: number; total_tokens: number } };
    };
    expect(completed.response.output).toHaveLength(1);
    expect(completed.response.usage.input_tokens).toBe(1);
    expect(completed.response.usage.output_tokens).toBe(2);
    expect(completed.response.usage.total_tokens).toBe(3);
  });

  test("tool calls round trip", async () => {
    async function* chunks() {
      yield chunk({ model: "gpt-5.4", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "f" } }] } }] });
      yield chunk({ model: "gpt-5.4", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] });
      yield chunk({ model: "gpt-5.4", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    }
    const events = await collectEvents(chatChunksToResponses(chunks()));
    const data = events.map((e) => JSON.parse(e.data) as Record<string, unknown>);
    const added = data.find((d) => d.type === "response.output_item.added" && (d.item as { type: string }).type === "function_call");
    expect(added).toBeDefined();
    const fc = added?.item as { call_id: string; name: string };
    expect(fc.call_id).toBe("c1");
    expect(fc.name).toBe("f");
    const completed = data[data.length - 1] as { response: { output: Array<{ type: string; arguments: string }> } };
    expect(completed.response.output[0]?.type).toBe("function_call");
    expect(completed.response.output[0]?.arguments).toBe("{}");
  });

  test("preserves DeepSeek reasoning deltas as a completed Responses reasoning item", async () => {
    async function* chunks() {
      yield chunk({ model: "deepseek-v4-flash-free", choices: [{ index: 0, delta: { reasoning_content: "inspect " } }] });
      yield chunk({ model: "deepseek-v4-flash-free", choices: [{ index: 0, delta: { reasoning_content: "files" } }] });
      yield chunk({ model: "deepseek-v4-flash-free", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "list" } }] } }] });
      yield chunk({ model: "deepseek-v4-flash-free", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] });
      yield chunk({ model: "deepseek-v4-flash-free", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    }
    const events = await collectEvents(chatChunksToResponses(chunks()));
    const data = events.map((e) => JSON.parse(e.data) as Record<string, unknown>);
    expect(data.some((event) => event.type === "response.reasoning_text.delta" && event.delta === "inspect ")).toBe(true);
    const reasoningDone = data.find((event) => {
      const item = event.item as Record<string, unknown> | undefined;
      return event.type === "response.output_item.done" && item?.type === "reasoning";
    });
    expect(reasoningDone?.item).toMatchObject({
      content: [{ type: "reasoning_text", text: "inspect files" }],
    });
  });
});

describe("responses SSE -> chat chunks", () => {
  test("decodes deltas and completion", async () => {
    const wire = [
      { type: "response.created", response: { id: "r1", model: "gpt-5.4", created_at: 5 } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ab" },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "cd" },
      { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
    ].map((o) => ({ event: undefined, data: JSON.stringify(o) }));
    const chunks: ChatChunk[] = [];
    for await (const c of responsesToChatChunks(scanEvents(wire))) chunks.push(c);
    const content = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.content ?? "")).join("");
    expect(content).toBe("abcd");
    expect(chunks[chunks.length - 1]?.choices[0]?.finish_reason).toBe("stop");
    expect(chunks[chunks.length - 1]?.usage?.total_tokens).toBe(5);
  });
});

describe("chat chunks -> messages / gemini SSE", () => {
  test("emits anthropic events", async () => {
    async function* chunks() {
      yield chunk({ model: "claude-opus-5", choices: [{ index: 0, delta: { role: "assistant" } }] });
      yield chunk({ model: "claude-opus-5", choices: [{ index: 0, delta: { content: "ok" } }] });
      yield chunk({ model: "claude-opus-5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    const events = await collectEvents(chatChunksToMessages(chunks()));
    const types = events.map((e) => e.event);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("message_delta");
    expect(types[types.length - 1]).toBe("message_stop");
  });

  test("emits gemini chunks", async () => {
    async function* chunks() {
      yield chunk({ model: "gemini-3.5-flash", choices: [{ index: 0, delta: { content: "hi" } }] });
      yield chunk({ model: "gemini-3.5-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    const events = await collectEvents(chatChunksToGemini(chunks()));
    expect(JSON.parse(events[0]!.data)).toMatchObject({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] });
    const last = JSON.parse(events[1]!.data) as { candidates: Array<{ finishReason: string }>; usageMetadata: { totalTokenCount: number } };
    expect(last.candidates[0]?.finishReason).toBe("STOP");
    expect(last.usageMetadata.totalTokenCount).toBe(2);
  });
});

describe("SSE parsing", () => {
  test("readSSE handles multi-line data and events", async () => {
    const body = new Response("event: x\ndata: {\"a\":1}\ndata: more\n\ndata: [DONE]\n\n").body!;
    const events: SseEvent[] = [];
    for await (const ev of readSSE(body)) events.push(ev);
    expect(events[0]?.event).toBe("x");
    expect(events[0]?.data).toBe('{"a":1}\nmore');
    expect(events[1]?.data).toBe("[DONE]");
  });
});
