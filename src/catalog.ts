/**
 * Zen model catalog.
 *
 * Every model OpenCode Zen serves maps to a specific protocol endpoint
 * (https://opencode.ai/docs/zh-cn/zen/#模型, fetched 2026-08-16):
 *
 *   - OpenAI Responses API  -> https://opencode.ai/zen/v1/responses
 *   - Anthropic Messages   -> https://opencode.ai/zen/v1/messages
 *   - OpenAI Chat Completions -> https://opencode.ai/zen/v1/chat/completions
 *   - Google Gemini (generateContent) -> https://opencode.ai/zen/v1/models/<id>
 *
 * The proxy uses this table to pick the outbound protocol automatically from
 * the model the user requests, converting the inbound request if needed.
 */

import type { OutboundProtocol } from "./config";

export const ZEN_CATALOG: Record<string, OutboundProtocol> = {
  // OpenAI Responses API (@ai-sdk/openai)
  "gpt-5.6-sol": "responses",
  "gpt-5.6-terra": "responses",
  "gpt-5.6-luna": "responses",
  "gpt-5.5": "responses",
  "gpt-5.5-pro": "responses",
  "gpt-5.4": "responses",
  "gpt-5.4-pro": "responses",
  "gpt-5.4-mini": "responses",
  "gpt-5.4-nano": "responses",
  "gpt-5.3-codex": "responses",
  "gpt-5.3-codex-spark": "responses",
  "gpt-5.2": "responses",
  "gpt-5.2-codex": "responses",
  "gpt-5.1": "responses",
  "gpt-5.1-codex": "responses",
  "gpt-5.1-codex-max": "responses",
  "gpt-5.1-codex-mini": "responses",
  "gpt-5": "responses",
  "gpt-5-codex": "responses",
  "gpt-5-nano": "responses",
  "grok-4.6": "responses",
  "grok-4.5": "responses",
  "grok-build-0.1": "responses",
  "muse-spark-1.2": "responses",
  "muse-spark-1.2-contributor-free": "responses",

  // Anthropic Messages API (@ai-sdk/anthropic)
  "claude-fable-5": "messages",
  "claude-opus-5": "messages",
  "claude-opus-4-8": "messages",
  "claude-opus-4-7": "messages",
  "claude-opus-4-6": "messages",
  "claude-opus-4-5": "messages",
  "claude-sonnet-5": "messages",
  "claude-sonnet-4-6": "messages",
  "claude-sonnet-4-5": "messages",
  "claude-sonnet-4": "messages",
  "claude-haiku-4-5": "messages",
  "qwen3.7-max": "messages",
  "qwen3.7-plus": "messages",
  "qwen3.6-plus": "messages",
  "qwen3.5-plus": "messages",

  // OpenAI-compatible Chat Completions (@ai-sdk/openai-compatible)
  "deepseek-v4-pro": "chat",
  "deepseek-v4-flash": "chat",
  "deepseek-v4-flash-free": "chat",
  "minimax-m3": "chat",
  "minimax-m2.7": "chat",
  "minimax-m2.5": "chat",
  "glm-5.2": "chat",
  "glm-5.1": "chat",
  "glm-5": "chat",
  "kimi-k2.5": "chat",
  "kimi-k2.6": "chat",
  "kimi-k2.7-code": "chat",
  "kimi-k3": "chat",
  "big-pickle": "chat",
  "mimo-v2.5-free": "chat",
  "hy3-free": "chat",
  "laguna-s-2.1-free": "chat",
  "x-preview-f-free": "chat",
  "nemotron-3-ultra-free": "chat",
  "nemotron-3.5-lightning-free": "chat",

  // Google Gemini generateContent (@ai-sdk/google)
  "gemini-3.7-flash": "gemini",
  "gemini-3.6-flash": "gemini",
  "gemini-3.5-flash": "gemini",
  "gemini-3.5-flash-lite": "gemini",
  "gemini-3.1-pro": "gemini",
  "gemini-3-flash": "gemini",
};

const PREFIX_PROTOCOL: Array<[string, OutboundProtocol]> = [
  ["gpt-", "responses"],
  ["grok-", "responses"],
  ["muse-", "responses"],
  ["claude-", "messages"],
  ["qwen3", "messages"],
  ["gemini-", "gemini"],
  ["deepseek-", "chat"],
  ["minimax-", "chat"],
  ["glm-", "chat"],
  ["kimi-", "chat"],
];

const FREE_OR_COMPAT: OutboundProtocol = "chat";

/**
 * Resolve the outbound protocol for an upstream model id. Exact catalog match
 * wins, then ZEN_MODEL_ENDPOINTS-style overrides (passed in), then prefix
 * heuristics, and finally a chat-completions default (the OpenAI-compatible
 * surface most openai-compatible clients speak natively).
 */
export function resolveOutboundProtocol(
  model: string,
  overrides: Record<string, OutboundProtocol> = {},
): OutboundProtocol {
  if (!model) return "chat";
  if (overrides[model]) return overrides[model];
  const exact = ZEN_CATALOG[model];
  if (exact) return exact;
  for (const [prefix, proto] of PREFIX_PROTOCOL) {
    if (model.startsWith(prefix)) return proto;
  }
  return FREE_OR_COMPAT;
}

/** Every model id in the catalog, sorted for stable listing. */
export function catalogModelIds(): string[] {
  return Object.keys(ZEN_CATALOG).sort();
}

/** Human-readable endpoint path used for logging / debugging. */
export function outboundPath(model: string, overrides: Record<string, OutboundProtocol> = {}): string {
  const proto = resolveOutboundProtocol(model, overrides);
  switch (proto) {
    case "responses":
      return "/responses";
    case "messages":
      return "/messages";
    case "gemini":
      return `/models/${encodeURIComponent(model)}`;
    case "chat":
      return "/chat/completions";
  }
}
