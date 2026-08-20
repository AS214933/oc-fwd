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
  /** Thinking-mode state relayed across protocols (DeepSeek reasoning_content,
   *  Responses reasoning_text, Anthropic thinking, Gemini thought parts). */
  reasoning_content?: string;
  /** Anthropic extended-thinking signature, preserved so a claude<->claude
   *  round trip can pass thinking blocks back to the API verbatim. Undefined
   *  when the text was synthesized from another protocol. */
  reasoning_signature?: string;
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

export interface ToolSanitization {
  discardedTypes: string[];
  discardedToolChoice: boolean;
}

/** Keep the function-tool subset shared by Chat, Responses, Messages, and Gemini. */
export function sanitizeFunctionTools(req: ChatRequest): ToolSanitization {
  const rawTools: unknown[] = Array.isArray(req.tools) ? req.tools : [];
  const tools: ChatTool[] = [];
  const discardedTypes: string[] = [];

  for (const rawTool of rawTools) {
    const tool = rawTool !== null && typeof rawTool === "object" ? rawTool as Record<string, unknown> : {};
    const type = typeof tool.type === "string" ? tool.type : "unknown";
    const fn = tool.function !== null && typeof tool.function === "object" ? tool.function as Record<string, unknown> : {};
    const name = typeof fn.name === "string" ? fn.name : "";
    if (type !== "function" || !name) {
      discardedTypes.push(type);
      continue;
    }
    tools.push({
      type: "function",
      function: {
        name,
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
      },
    });
  }

  if (tools.length > 0) req.tools = tools;
  else delete req.tools;

  const discardedToolChoice = req.tool_choice !== undefined && !isSupportedToolChoice(req.tool_choice, new Set(tools.map((tool) => tool.function.name)));
  if (discardedToolChoice) delete req.tool_choice;
  return { discardedTypes, discardedToolChoice };
}

function isSupportedToolChoice(choice: unknown, names: Set<string>): boolean {
  if (names.size === 0) return false;
  if (choice === "auto" || choice === "none" || choice === "required") return true;
  if (choice === null || typeof choice !== "object") return false;
  const value = choice as Record<string, unknown>;
  if (value.type !== "function") return false;
  const functionValue = value.function !== null && typeof value.function === "object"
    ? value.function as Record<string, unknown>
    : {};
  const name = typeof value.name === "string"
    ? value.name
    : typeof functionValue.name === "string" ? functionValue.name : "";
  return names.has(name);
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
    delta: { role?: string; content?: string; reasoning_content?: string; reasoning_signature?: string; tool_calls?: ChatChunkToolCall[] };
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
