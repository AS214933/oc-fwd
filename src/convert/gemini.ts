/**
 * Google Gemini generateContent <-> canonical Chat Completions conversion.
 * Zen serves Gemini models at https://opencode.ai/zen/v1/models/<id>.
 */

import type { ChatCompletion, ChatMessage, ChatRequest } from "./types";

interface GeminiPart {
  text?: string;
  /** Gemini marks model-side thinking parts with thought:true. */
  thought?: boolean;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
}

interface GeminiResponseShape {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/** Convert a canonical Chat Completions request to a Gemini generateContent body. */
export function chatToGeminiRequest(req: ChatRequest): Record<string, unknown> {
  const systemTexts: string[] = [];
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  const callNames = new Map<string, string>();

  const push = (role: string, parts: GeminiPart[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role && parts.length === 1 && !parts[0]?.functionCall && !parts[0]?.functionResponse) {
      last.parts.push(parts[0] as GeminiPart);
      return;
    }
    contents.push({ role, parts });
  };

  for (const msg of req.messages) {
    if (msg.role === "system") {
      if (msg.content) systemTexts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      const name = msg.tool_call_id ? callNames.get(msg.tool_call_id) ?? "" : "";
      let response: unknown = msg.content;
      try {
        response = JSON.parse(msg.content);
      } catch {
        // keep raw text
      }
      push("user", [{ functionResponse: { name, response } }]);
      continue;
    }
    const parts: GeminiPart[] = [];
    if (msg.reasoning_content) parts.push({ text: msg.reasoning_content, thought: true });
    if (Array.isArray(msg.parts) && msg.parts.length > 0) {
      parts.push(...geminiPartsFromParts(msg.parts));
    } else if (msg.content) {
      parts.push({ text: msg.content });
    }
    for (const tc of msg.tool_calls ?? []) {
      callNames.set(tc.id, tc.function.name);
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      parts.push({ functionCall: { name: tc.function.name, args } });
    }
    if (parts.length > 0) {
      push(msg.role === "assistant" ? "model" : "user", parts);
    }
  }

  const out: Record<string, unknown> = {
    contents,
    ...(req.model ? { model: req.model } : {}),
  };
  if (systemTexts.length > 0) {
    out.systemInstruction = { parts: systemTexts.map((t) => ({ text: t })) };
  }
  const generationConfig: Record<string, unknown> = {};
  if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens;
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.top_p !== undefined) generationConfig.topP = req.top_p;
  if (Object.keys(generationConfig).length > 0) out.generationConfig = generationConfig;
  if (req.tools?.length) {
    out.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.function.name,
          ...(t.function.description ? { description: t.function.description } : {}),
          ...(t.function.parameters !== undefined ? { parameters: t.function.parameters } : {}),
        })),
      },
    ];
  }
  return out;
}

/** Render canonical content parts as Gemini parts (inlineData/fileData). */
function geminiPartsFromParts(parts: unknown[]): GeminiPart[] {
  const out: GeminiPart[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : "";
    switch (type) {
      case "text":
        if (typeof p.text === "string") out.push({ text: p.text });
        break;
      case "image_url":
      case "input_image": {
        const url = type === "image_url"
          ? (p.image_url as Record<string, unknown>)?.url
          : p.image_url;
        if (typeof url === "string" && url.startsWith("data:")) {
          const comma = url.indexOf(",");
          const meta = comma > 0 ? url.slice(5, comma) : "";
          const mimeType = meta.split(";")[0] || "image/png";
          const data = comma > 0 ? url.slice(comma + 1) : "";
          if (data) out.push({ inlineData: { mimeType, data } });
        } else if (typeof url === "string" && url !== "") {
          out.push({ fileData: { mimeType: "image/png", fileUri: url } });
        }
        break;
      }
      case "image": {
        const src = (p.source ?? {}) as Record<string, unknown>;
        if (typeof src.data === "string") {
          out.push({ inlineData: { mimeType: typeof src.media_type === "string" ? src.media_type : "image/png", data: src.data } });
        } else if (typeof src.url === "string") {
          out.push({ fileData: { mimeType: "image/png", fileUri: src.url } });
        }
        break;
      }
      default:
        if (typeof p.text === "string") out.push({ text: p.text });
        break;
    }
  }
  return out;
}

/** Parse a non-streaming Gemini generateContent response into canonical chat completion. */
export function parseGeminiResponse(data: GeminiResponseShape): ChatCompletion {
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const message: ChatMessage = { role: "assistant", content: "" };
  const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
  let reasoning = "";
  for (const part of parts) {
    if (typeof part.text === "string") {
      if (part.thought === true) reasoning += part.text;
      else message.content += part.text;
    }
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${toolCalls.length + 1}`,
        type: "function",
        function: {
          name: part.functionCall.name ?? "",
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoning !== "") message.reasoning_content = reasoning;
  const usage = data.usageMetadata;
  return {
    id: "chatcmpl_gemini",
    object: "chat.completion",
    model: "",
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message,
        finish_reason: geminiFinish(candidate?.finishReason ?? "", toolCalls.length > 0),
      },
    ],
    usage: {
      prompt_tokens: usage?.promptTokenCount ?? 0,
      completion_tokens: usage?.candidatesTokenCount ?? 0,
      total_tokens: usage?.totalTokenCount ?? 0,
    },
  };
}

export function geminiFinish(reason: string, hasToolCalls: boolean): string {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    case "TOOL_CALLS":
      return "tool_calls";
    default:
      return hasToolCalls ? "tool_calls" : "stop";
  }
}

/** Convert one Gemini streaming chunk (JSON data line) to text/functionCall parts. */
export function parseGeminiChunk(data: unknown): {
  parts: GeminiPart[];
  finishReason?: string;
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
} {
  const raw = (data ?? {}) as GeminiResponseShape;
  const candidate = raw.candidates?.[0];
  return {
    parts: candidate?.content?.parts ?? [],
    finishReason: candidate?.finishReason,
    usage: raw.usageMetadata,
  };
}
