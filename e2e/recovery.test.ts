/**
 * E2E coverage for the recovery hold + confirmation flow:
 * 1. after a failed anonymous request switches a model to keyed mode, no
 *    anonymous probes run during the hold window (5m default);
 * 2. once the hold expires, probes resume every ZEN_NO_KEY_PROBE_SECONDS and
 *    only ZEN_NO_KEY_RECOVERY_CONFIRMATIONS consecutive successes switch the
 *    model back to anonymous.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig, type Config } from "../src/config";
import { Proxy } from "../src/proxy/handler";
import { Logger } from "../src/log";
import { MockZen, chatCompletionJson, jsonResponse } from "./mock-upstream";

let mock: MockZen;

async function cfgFrom(env: Partial<Config>): Promise<Config> {
  const cfg = await loadConfig({
    LISTEN_ADDR: ":0",
    ZEN_UPSTREAM: mock.url,
    ZEN_UPSTREAM_API_KEY: "",
    ZEN_SOCKS5: "",
    ZEN_IPV6_PREFER: "false",
    ZEN_ROTATE_IP: "false",
    ZEN_DIAL_TIMEOUT_SECONDS: "5",
    ZEN_RETRY_MAX: "1",
    ZEN_RETRY_BACKOFF_SECONDS: "0.01",
    ZEN_RETRY_MAX_BACKOFF_SECONDS: "0.05",
    ZEN_UPSTREAM_TIMEOUT_SECONDS: "10",
    ZEN_FORCE_CHAT_COMPLETIONS: "false",
    ZEN_FORCE_CHAT_INBOUND: "false",
    ZEN_API_KEYS_FILE: "",
    ZEN_AUTH_KEY: "",
    ZEN_STATUS_URL: "",
    ZEN_MODELS: "",
    ZEN_MODEL_MAP: "",
    ZEN_MODEL_ENDPOINTS: "",
    ZEN_NO_KEY_FAIL_THRESHOLD: "1",
    ZEN_NO_KEY_PROBE_SECONDS: "60",
    LOG_LEVEL: "error",
  });
  return { ...cfg, ...env };
}

async function startProxy(cfg: Config) {
  const proxy = new Proxy(cfg, new Logger("error"));
  const server = Bun.serve({ port: 0, development: false, idleTimeout: 0, fetch: proxy.handler() });
  return { proxy, server, url: `http://127.0.0.1:${server.port}` };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mode(url: string): Promise<string> {
  const res = await fetch(`${url}/debug/modes`);
  const body = (await res.json()) as { models: Array<{ model: string; state: string }> };
  return body.models.find((m) => m.model === "deepseek-v4-flash-free")?.state ?? "unknown";
}

describe("fallback hold + confirmation", () => {
  test("stays keyed through the hold window and recovers only after three consecutive probe successes", async () => {
    let anonymousCalls = 0;
    mock = new MockZen(async (ctx) => {
      if (ctx.path === "/chat/completions") {
        if (ctx.auth) return jsonResponse(chatCompletionJson(ctx.model, "keyed-ok"));
        // Only the very first anonymous request fails (the one that triggers
        // the switch). Everything after the hold window is a probe and
        // succeeds, so exactly three consecutive successes are needed.
        anonymousCalls++;
        return anonymousCalls === 1
          ? jsonResponse({ error: { message: "no anonymous yet" } }, 503)
          : jsonResponse(chatCompletionJson(ctx.model, "probe-ok"));
      }
      return jsonResponse({});
    });
    const cfg = await cfgFrom({
      apiKeys: ["key-r"],
      retryMax: 0,
      noKeyRecoveryHoldMs: 250,
      noKeyProbeIntervalMs: 70,
      noKeyProbeConfirmations: 3,
    });
    const { proxy, server, url: u } = await startProxy(cfg);
    try {
      // Anonymous attempt fails once and switches the model to keyed mode.
      const res = await fetch(`${u}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      expect(await mode(u)).toBe("keyed");
      expect(anonymousCalls).toBe(1); // nothing probed yet at switch time

      await sleep(200); // still inside the 250ms hold window: no probes yet
      expect(anonymousCalls).toBe(1);

      await sleep(120); // hold elapsed; probes now run every 70ms
      const probes1 = anonymousCalls - 1;
      expect(probes1).toBeGreaterThan(0);
      // The model must still be keyed right after the first probe(s): three
      // consecutive successes are required before flipping back.
      expect(await mode(u)).toBe("keyed");

      // Keep sampling until the model recovers; then verify the exact number
      // of probes it took (at least 3, matching the confirmation count).
      let probesAtRecovery = anonymousCalls - 1;
      for (let i = 0; i < 30 && (await mode(u)) !== "anonymous"; i++) {
        await sleep(70);
        probesAtRecovery = anonymousCalls - 1;
      }
      expect(await mode(u)).toBe("anonymous");
      expect(probesAtRecovery).toBeGreaterThanOrEqual(3);
    } finally {
      proxy.stop();
      server.stop(true);
    }
  });
});
