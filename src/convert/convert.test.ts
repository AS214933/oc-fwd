import { describe, expect, test } from "bun:test";
import { responsesToChatRequest, chatToResponsesRequest, renderChatCompletionAsResponses } from "./responses";
import { messagesToChatRequest, chatToMessagesRequest, parseMessagesResponse, renderChatCompletionAsMessages } from "./messages";
import { parseChatCompletion, parseChatRequest, renderChatRequest } from "./chat";
import { chatToGeminiRequest, parseGeminiResponse } from "./gemini";
import { parseResponsesRequest } from "./responses";
import { parseMessagesRequest } from "./messages";
import {
  chatChunksToResponses, responsesToChatChunks, chatChunksToMessages, chatChunksToGemini,
  messagesToChatChunks, geminiToChatChunks, renderMessagesEventsFromCompletion,
  renderGeminiEventFromCompletion, readSSE, type SseEvent,
} from "./stream";
import { sanitizeFunctionTools, type ChatChunk, type ChatRequest } from "./types";

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

  test("replays raw reasoning on a text-only assistant message", () => {
    const req = responsesToChatRequest({
      model: "deepseek-v4-flash-free",
      input: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "inspect the repository" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "The repository is ready." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });
    expect(req.messages).toEqual([
      { role: "assistant", content: "The repository is ready.", reasoning_content: "inspect the repository" },
      { role: "user", content: "continue" },
    ]);
  });

  test("preserves the reasoning param across a responses round trip", () => {
    const req = responsesToChatRequest({ model: "gpt-5.5", reasoning: { effort: "high" }, input: "hi" });
    expect((req as unknown as Record<string, unknown>).reasoning).toEqual({ effort: "high" });
    const out = chatToResponsesRequest(req) as Record<string, unknown>;
    expect(out.reasoning).toEqual({ effort: "high" });
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

  test("drops named non-function Responses tools instead of recoding them as functions", () => {
    const req = responsesToChatRequest({
      model: "muse-spark-1.2-contributor-free",
      input: "hi",
      tools: [
        { type: "function", name: "read_file", parameters: { type: "object" } },
        { type: "web_search", name: "search", search_context_size: "medium" },
        { type: "custom", name: "apply_patch", format: { type: "grammar" } },
      ],
    });
    expect(req.tools).toEqual([
      { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
    ]);
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
      summary: [{ type: "summary_text", text: "check the workspace" }],
      content: [{ type: "reasoning_text", text: "check the workspace" }],
    });
    expect(output[1]?.type).toBe("function_call");
  });

  test("preserves text-only assistant reasoning as a Responses item", () => {
    const completion = parseChatCompletion({
      id: "chat_1",
      model: "deepseek-v4-flash-free",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "The repository is ready.", reasoning_content: "inspect the repository" },
        finish_reason: "stop",
      }],
    });
    const output = renderChatCompletionAsResponses(completion).output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "inspect the repository" }],
    });
    expect(output[1]).toMatchObject({ type: "message", role: "assistant" });
  });
});

describe("Zen tool compatibility", () => {
  test("retains only standard functions and removes an incompatible tool choice", () => {
    const req = {
      model: "muse-spark-1.2-contributor-free",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
        { type: "computer", name: "computer" },
        { type: "custom", function: { name: "patch" } },
      ],
      tool_choice: { type: "computer" },
    } as unknown as ChatRequest;

    const result = sanitizeFunctionTools(req);
    expect(req.tools).toEqual([
      { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
    ]);
    expect(req.tool_choice).toBeUndefined();
    expect(result).toEqual({ discardedTypes: ["computer", "custom"], discardedToolChoice: true });
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

  test("anthropic thinking blocks -> reasoning_content + signature", () => {
    const req = messagesToChatRequest({
      model: "claude-opus-5",
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "consider", signature: "sig-1" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });
    expect((req as unknown as Record<string, unknown>).thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(req.messages[0]).toEqual({
      role: "assistant",
      content: "answer",
      reasoning_content: "consider",
      reasoning_signature: "sig-1",
    });
  });

  test("chat reasoning_content -> anthropic thinking block", () => {
    const out = chatToMessagesRequest({
      model: "claude-opus-5",
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "answer", reasoning_content: "consider", reasoning_signature: "sig-1" },
      ],
    });
    expect((out as Record<string, unknown>).thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    const blocks = (out.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>)[1]?.content;
    expect(blocks?.[0]).toEqual({ type: "thinking", thinking: "consider", signature: "sig-1" });
    expect(blocks?.[1]).toEqual({ type: "text", text: "answer" });
  });

  test("messages response thinking block round trips through the completion", () => {
    const parsed = parseMessagesResponse({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: "plan", signature: "sig-2" },
        { type: "text", text: "hello" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    expect(parsed.choices[0]?.message).toMatchObject({
      content: "hello",
      reasoning_content: "plan",
      reasoning_signature: "sig-2",
    });
    const rendered = renderChatCompletionAsMessages(parsed);
    expect((rendered.content as Array<Record<string, unknown>>)[0]).toEqual({
      type: "thinking",
      thinking: "plan",
      signature: "sig-2",
    });
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

  test("reasoning_content becomes a thought part", () => {
    const out = chatToGeminiRequest({
      model: "gemini-3.5-flash",
      messages: [{ role: "assistant", content: "answer", reasoning_content: "consider" }],
    });
    const contents = out.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]?.parts[0]).toEqual({ text: "consider", thought: true });
    expect(contents[0]?.parts[1]).toEqual({ text: "answer" });
  });
});

describe("gemini -> chat", () => {
  test("thought parts become reasoning_content instead of leaking into text", () => {
    const parsed = parseGeminiResponse(JSON.parse(JSON.stringify({
      candidates: [{
        content: {
          role: "model",
          parts: [
            { text: "think hard", thought: true },
            { text: "answer" },
          ],
        },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    })));
    expect(parsed.choices[0]?.message).toMatchObject({
      content: "answer",
      reasoning_content: "think hard",
    });
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
    expect(data.some((event) => event.type === "response.reasoning_summary_text.delta" && event.delta === "inspect ")).toBe(true);
    const summaryAdded = data.find((event) => event.type === "response.reasoning_summary_part.added");
    expect(summaryAdded).toBeDefined();
    const summaryDone = data.find((event) => event.type === "response.reasoning_summary_part.done");
    expect(summaryDone?.part).toEqual({ type: "summary_text", text: "inspect files" });
    const reasoningDone = data.find((event) => {
      const item = event.item as Record<string, unknown> | undefined;
      return event.type === "response.output_item.done" && item?.type === "reasoning";
    });
    expect(reasoningDone?.item).toMatchObject({
      summary: [{ type: "summary_text", text: "inspect files" }],
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

  test("decodes reasoning deltas as reasoning_content", async () => {
    const wire = [
      { type: "response.created", response: { id: "r1", model: "gpt-5.4", created_at: 5 } },
      { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [], content: [] } },
      { type: "response.reasoning_text.delta", item_id: "rs_1", output_index: 0, content_index: 0, delta: "inspect " },
      { type: "response.reasoning_text.delta", item_id: "rs_1", output_index: 0, content_index: 0, delta: "files" },
      { type: "response.output_item.added", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "done" },
      { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
    ].map((o) => ({ event: undefined, data: JSON.stringify(o) }));
    const chunks: ChatChunk[] = [];
    for await (const c of responsesToChatChunks(scanEvents(wire))) chunks.push(c);
    const reasoning = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.reasoning_content ?? "")).join("");
    const content = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.content ?? "")).join("");
    expect(reasoning).toBe("inspect files");
    expect(content).toBe("done");
  });
});

describe("messages SSE -> chat chunks", () => {
  test("decodes thinking deltas and signature", async () => {
    const wire = [
      { type: "message_start", message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "cons" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ider" } },
      { type: "content_block_stop", index: 0, content_block: { type: "thinking", thinking: "consider", signature: "sig-1" } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ].map((o) => ({ event: undefined, data: JSON.stringify(o) }));
    const chunks: ChatChunk[] = [];
    for await (const c of messagesToChatChunks(scanEvents(wire))) chunks.push(c);
    const reasoning = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.reasoning_content ?? "")).join("");
    const content = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.content ?? "")).join("");
    expect(reasoning).toBe("consider");
    expect(content).toBe("answer");
    expect(chunks.some((c) => c.choices[0]?.delta.reasoning_signature === "sig-1")).toBe(true);
  });
});

describe("gemini SSE -> chat chunks", () => {
  test("thought parts become reasoning_content", async () => {
    const wire = [
      { candidates: [{ content: { role: "model", parts: [{ text: "think", thought: true }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
    ].map((o) => ({ event: undefined, data: JSON.stringify(o) }));
    const chunks: ChatChunk[] = [];
    for await (const c of geminiToChatChunks(scanEvents(wire))) chunks.push(c);
    const reasoning = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.reasoning_content ?? "")).join("");
    const content = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.content ?? "")).join("");
    expect(reasoning).toBe("think");
    expect(content).toBe("answer");
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

  test("emits anthropic thinking events with signature stop", async () => {
    async function* chunks() {
      yield chunk({ model: "claude-opus-5", choices: [{ index: 0, delta: { reasoning_content: "cons" } }] });
      yield chunk({ model: "claude-opus-5", choices: [{ index: 0, delta: { reasoning_content: "ider" } }] });
      yield chunk({ model: "claude-opus-5", choices: [{ index: 0, delta: { reasoning_signature: "sig-1" } }] });
      yield chunk({ model: "claude-opus-5", choices: [{ index: 0, delta: { content: "answer" } }] });
      yield chunk({ model: "claude-opus-5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    const events = await collectEvents(chatChunksToMessages(chunks()));
    const data = events.map((e) => JSON.parse(e.data) as Record<string, unknown>);
    const thinkingStart = data.find((d) => d.type === "content_block_start" && (d.content_block as Record<string, unknown>)?.type === "thinking");
    expect(thinkingStart).toBeTruthy();
    const thinkingDeltas = data.filter((d) => d.type === "content_block_delta" && (d.delta as Record<string, unknown>)?.type === "thinking_delta");
    expect(thinkingDeltas.map((d) => (d.delta as Record<string, unknown>).thinking).join("")).toBe("consider");
    const thinkingStop = data.find((d) => d.type === "content_block_stop" && (d.content_block as Record<string, unknown>)?.type === "thinking");
    expect(thinkingStop?.content_block).toEqual({ type: "thinking", thinking: "consider", signature: "sig-1" });
  });

  test("emits gemini thought parts", async () => {
    async function* chunks() {
      yield chunk({ model: "gemini-3.5-flash", choices: [{ index: 0, delta: { reasoning_content: "think" } }] });
      yield chunk({ model: "gemini-3.5-flash", choices: [{ index: 0, delta: { content: "hi" } }] });
      yield chunk({ model: "gemini-3.5-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    const events = await collectEvents(chatChunksToGemini(chunks()));
    expect(JSON.parse(events[0]!.data)).toMatchObject({
      candidates: [{ content: { role: "model", parts: [{ text: "think", thought: true }] } }],
    });
  });

  test("renderMessagesEventsFromCompletion emits thinking block with signature", () => {
    const events = renderMessagesEventsFromCompletion({
      id: "c",
      object: "chat.completion",
      model: "claude-opus-5",
      created: 1,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "answer", reasoning_content: "consider", reasoning_signature: "sig-1" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    const data = events.map((e) => JSON.parse(e.data) as Record<string, unknown>);
    const thinkingStart = data.find((d) => d.type === "content_block_start" && (d.content_block as Record<string, unknown>)?.type === "thinking");
    expect(thinkingStart).toBeTruthy();
    const thinkingStop = data.find((d) => d.type === "content_block_stop" && (d.content_block as Record<string, unknown>)?.type === "thinking");
    expect(thinkingStop?.content_block).toEqual({ type: "thinking", thinking: "consider", signature: "sig-1" });
    const textStart = data.find((d) => d.type === "content_block_start" && (d.content_block as Record<string, unknown>)?.type === "text");
    expect((textStart as Record<string, unknown>)?.index).toBe(1);
  });

  test("renderGeminiEventFromCompletion emits thought part", () => {
    const ev = renderGeminiEventFromCompletion({
      id: "c",
      object: "chat.completion",
      model: "gemini-3.5-flash",
      created: 1,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "answer", reasoning_content: "consider" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(JSON.parse(ev.data)).toMatchObject({
      candidates: [{ content: { role: "model", parts: [{ text: "consider", thought: true }, { text: "answer" }] } }],
    });
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

describe("multimodal content parts", () => {
  test("chat request keeps image parts through parse and render", () => {
    const req = parseChatRequest({
      model: "mimo-v2.5-free",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
          ],
        },
      ],
    } as never);
    expect(req.messages[0]?.content).toBe("what is in this image?");
    expect(req.messages[0]?.parts).toEqual([
      { type: "text", text: "what is in this image?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
    ]);
    const out = JSON.parse(renderChatRequest(req)) as { messages: Array<Record<string, unknown>> };
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "what is in this image?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
    ]);
    expect(out.messages[0]?.parts).toBeUndefined();
  });

  test("plain text content arrays are not promoted to parts", () => {
    const req = parseChatRequest({
      model: "mimo-v2.5-free",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);
    expect(req.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  test("responses input_image survives conversion to chat parts", () => {
    const req = responsesToChatRequest(parseResponsesRequest({
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "data:image/jpeg;base64,BBBB" },
          ],
        },
      ],
    } as never));
    expect(req.messages[0]?.content).toBe("look");
    expect(req.messages[0]?.parts).toEqual([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "data:image/jpeg;base64,BBBB" },
    ]);
  });

  test("chat image parts render as Responses input_image", () => {
    const req = parseChatRequest({
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            { type: "image_url", image_url: { url: "data:image/png;base64,CCCC", detail: "low" } },
          ],
        },
      ],
    } as never);
    const out = chatToResponsesRequest(req) as Record<string, unknown>;
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]?.content).toEqual([
      { type: "input_text", text: "see" },
      { type: "input_image", image_url: "data:image/png;base64,CCCC", detail: "low" },
    ]);
  });

  test("anthropic image blocks survive conversion to chat image_url", () => {
    const req = messagesToChatRequest(parseMessagesRequest({
      model: "mimo-v2.5-free",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what color?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "DDDD" } },
          ],
        },
      ],
    } as never));
    expect(req.messages[0]?.content).toBe("what color?");
    expect(req.messages[0]?.parts).toEqual([
      { type: "text", text: "what color?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "DDDD" } },
    ]);
    const out = JSON.parse(renderChatRequest(req)) as { messages: Array<Record<string, unknown>> };
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "what color?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,DDDD" } },
    ]);
  });

  test("chat image parts render as Anthropic image blocks", () => {
    const req = parseChatRequest({
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "data:image/png;base64,EEEE" } },
          ],
        },
      ],
    } as never);
    const out = chatToMessagesRequest(req) as Record<string, unknown>;
    const messages = out.messages as Array<{ content: unknown[] }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "hi" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "EEEE" } },
    ]);
  });

  test("chat image parts render as Gemini inlineData", () => {
    const req = parseChatRequest({
      model: "gemini-3.5-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "data:image/png;base64,FFFF" } },
          ],
        },
      ],
    } as never);
    const out = chatToGeminiRequest(req) as Record<string, unknown>;
    const contents = out.contents as Array<{ parts: unknown[] }>;
    expect(contents[0]?.parts).toEqual([
      { text: "hi" },
      { inlineData: { mimeType: "image/png", data: "FFFF" } },
    ]);
  });
});
