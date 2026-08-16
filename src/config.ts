/**
 * Runtime configuration. Every knob is optional and driven by environment
 * variables so the same code runs identically in Docker and locally.
 */

export type OutboundProtocol = "chat" | "responses" | "messages" | "gemini";

export interface ModelEndpointOverride {
  [model: string]: OutboundProtocol;
}

export interface Config {
  listen: string;
  upstreamBase: string;
  upstreamAPIKey: string;
  socks5: string;
  ipv6Prefer: boolean;
  forceIPv6: boolean;
  rotateIP: boolean;
  dialTimeoutMs: number;
  dnsCacheTTLMs: number;
  apiKeysFile: string;
  apiKeys: string[];
  noKeyFailThreshold: number;
  noKeyProbeIntervalMs: number;
  statusURL: string;
  statusToken: string;
  forceChatCompletions: boolean;
  forceChatInbound: boolean;
  models: string[];
  modelMap: Record<string, string>;
  modelEndpoints: ModelEndpointOverride;
  authKey: string;
  retryMax: number;
  retryBaseBackoffMs: number;
  retryMaxBackoffMs: number;
  circuitFailures: number;
  circuitCooldownMs: number;
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
  upstreamTimeoutSet: boolean;
  maxConcurrency: number;
  logLevel: string;
}

function envStr(key: string, def = "", env: NodeJS.ProcessEnv = process.env): string {
  const v = env[key];
  return v === undefined || v === "" ? def : v;
}

function envInt(key: string, def: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function envFloat(key: string, def: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function envBool(key: string, def: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[key];
  if (v === undefined || v === "") return def;
  switch (v.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
  }
  return def;
}

function parseModelMap(s: string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const raw of s.split(",")) {
    const pair = raw.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      throw new Error(`invalid ZEN_MODEL_MAP entry "${pair}" (want alias=upstreamModel)`);
    }
    const alias = pair.slice(0, eq).trim();
    const model = pair.slice(eq + 1).trim();
    if (!alias || !model) throw new Error(`invalid ZEN_MODEL_MAP entry "${pair}" (want alias=upstreamModel)`);
    m[alias] = model;
  }
  return m;
}

function parseModelEndpoints(s: string): ModelEndpointOverride {
  const m: ModelEndpointOverride = {};
  const valid: OutboundProtocol[] = ["chat", "responses", "messages", "gemini"];
  for (const raw of s.split(",")) {
    const pair = raw.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      throw new Error(`invalid ZEN_MODEL_ENDPOINTS entry "${pair}" (want model=chat|responses|messages|gemini)`);
    }
    const model = pair.slice(0, eq).trim();
    const ep = pair.slice(eq + 1).trim();
    if (!model || !valid.includes(ep as OutboundProtocol)) {
      throw new Error(`invalid ZEN_MODEL_ENDPOINTS entry "${pair}" (want model=chat|responses|messages|gemini)`);
    }
    m[model] = ep as OutboundProtocol;
  }
  return m;
}

async function loadKeysFile(path: string): Promise<string[]> {
  const data = Bun.file(path);
  if (!data.exists()) throw new Error(`read ZEN_API_KEYS_FILE "${path}": no such file`);
  const keys: string[] = [];
  for (const line of (await data.text()).split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    keys.push(l);
  }
  if (keys.length === 0) throw new Error(`ZEN_API_KEYS_FILE "${path}" contains no keys`);
  return keys;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const listen = envStr("LISTEN_ADDR", ":8080", env) as string;
  const upstreamBase = envStr("ZEN_UPSTREAM", "https://opencode.ai/zen/v1", env).replace(/\/+$/, "");
  const apiKeysFile = envStr("ZEN_API_KEYS_FILE", "", env);
  const dialTimeout = envFloat("ZEN_DIAL_TIMEOUT_SECONDS", 15, env);
  const dnsCacheTTL = envFloat("ZEN_DNS_CACHE_TTL_SECONDS", 60, env);
  const retryBackoff = envFloat("ZEN_RETRY_BACKOFF_SECONDS", 2, env);
  const retryMaxBackoff = envFloat("ZEN_RETRY_MAX_BACKOFF_SECONDS", 30, env);
  const circuitCooldown = envFloat("ZEN_CIRCUIT_COOLDOWN_SECONDS", 30, env);
  const noKeyProbe = envFloat("ZEN_NO_KEY_PROBE_SECONDS", 3, env);
  const upstreamTimeout = envFloat("ZEN_UPSTREAM_TIMEOUT_SECONDS", 600, env);

  if (!listen) throw new Error("LISTEN_ADDR cannot be empty");
  if (dialTimeout <= 0) throw new Error(`invalid ZEN_DIAL_TIMEOUT_SECONDS ${dialTimeout}: must be > 0`);
  if (dnsCacheTTL < 0) throw new Error(`invalid ZEN_DNS_CACHE_TTL_SECONDS ${dnsCacheTTL}: must be >= 0`);
  if (retryMaxBackoff < 0) {
    throw new Error(`invalid ZEN_RETRY_MAX_BACKOFF_SECONDS ${retryMaxBackoff}: must be >= 0`);
  }

  const cfg: Config = {
    listen,
    upstreamBase,
    upstreamAPIKey: envStr("ZEN_UPSTREAM_API_KEY", "", env),
    socks5: envStr("ZEN_SOCKS5", "", env),
    ipv6Prefer: envBool("ZEN_IPV6_PREFER", true, env),
    forceIPv6: envBool("ZEN_FORCE_IPV6", false, env),
    rotateIP: envBool("ZEN_ROTATE_IP", true, env),
    dialTimeoutMs: dialTimeout * 1000,
    dnsCacheTTLMs: dnsCacheTTL > 0 ? dnsCacheTTL * 1000 : 0,
    apiKeysFile,
    apiKeys: [],
    noKeyFailThreshold: envInt("ZEN_NO_KEY_FAIL_THRESHOLD", 3, env),
    noKeyProbeIntervalMs: noKeyProbe * 1000,
    statusURL: envStr("ZEN_STATUS_URL", "", env).replace(/\/+$/, ""),
    statusToken: envStr("ZEN_STATUS_TOKEN", "", env),
    forceChatCompletions: envBool("ZEN_FORCE_CHAT_COMPLETIONS", false, env),
    forceChatInbound: envBool("ZEN_FORCE_CHAT_INBOUND", false, env),
    models: [],
    modelMap: parseModelMap(envStr("ZEN_MODEL_MAP", "", env)) as Record<string, string>,
    modelEndpoints: parseModelEndpoints(envStr("ZEN_MODEL_ENDPOINTS", "", env)) as ModelEndpointOverride,
    authKey: envStr("ZEN_AUTH_KEY", "", env),
    retryMax: envInt("ZEN_RETRY_MAX", 3, env) as number,
    retryBaseBackoffMs: retryBackoff * 1000,
    retryMaxBackoffMs: retryMaxBackoff * 1000,
    circuitFailures: envInt("ZEN_CIRCUIT_FAILURES", 5, env),
    circuitCooldownMs: circuitCooldown * 1000,
    maxBodyBytes: envInt("ZEN_MAX_BODY_MB", 128, env) * 1024 * 1024,
    upstreamTimeoutMs: upstreamTimeout * 1000,
    upstreamTimeoutSet: upstreamTimeout > 0,
    maxConcurrency: envInt("ZEN_MAX_CONCURRENCY", 0, env) as number,
    logLevel: envStr("LOG_LEVEL", "info", env),
  };

  for (const m of envStr("ZEN_MODELS", "", env).split(",")) {
    const model = m.trim();
    if (model) cfg.models.push(model);
  }
  if (cfg.apiKeysFile) cfg.apiKeys = await loadKeysFile(cfg.apiKeysFile);
  if (cfg.apiKeys.length > 0) {
    if (cfg.noKeyFailThreshold < 1) {
      throw new Error(`invalid ZEN_NO_KEY_FAIL_THRESHOLD ${cfg.noKeyFailThreshold}: must be >= 1`);
    }
    if (cfg.noKeyProbeIntervalMs <= 0) {
      throw new Error(`invalid ZEN_NO_KEY_PROBE_SECONDS: must be > 0`);
    }
  }
  if (cfg.retryMax < 0 || cfg.retryBaseBackoffMs <= 0) {
    throw new Error("invalid retry settings: ZEN_RETRY_MAX and ZEN_RETRY_BACKOFF_SECONDS must be >= 0 / > 0");
  }
  return cfg;
}
