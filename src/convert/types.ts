/**
 * Canonical wire types. Everything is normalized through OpenAI Chat
 * Completions as the middle representation, then rendered in whatever
 * protocol the upstream model / the inbound client speaks.
 */

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: string;
  content: string;
  /** DeepSeek thinking-mode state that must accompany assistant tool calls. */
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatTool {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: ChatTool[];
  tool_choice?: unknown;
  stream_options?: unknown;
  [key: string]: unknown;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  model: string;
  created: number;
  choices: Array<{ index: number; message: ChatMessage; finish_reason: string }>;
  usage: ChatUsage;
}

export interface ChatChunkToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatChunk {
  id: string;
  model: string;
  created: number;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string; reasoning_content?: string; tool_calls?: ChatChunkToolCall[] };
    finish_reason?: string;
  }>;
  usage?: ChatUsage;
}

/** Flatten OpenAI/Anthropic content (string or array of text parts) to a string. */
export function contentToString(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") parts.push(p.text);
    else if (typeof p.content === "string") parts.push(p.content); // anthropic tool_result shorthand
  }
  return parts.join("");
}

/** Map any client role into one the Chat Completions API accepts. */
export function chatRole(role: string): string {
  switch (role) {
    case "":
    case "developer":
      return "system";
    default:
      return role;
  }
}
