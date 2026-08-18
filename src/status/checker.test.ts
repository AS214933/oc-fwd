/**
 * Unit tests for the Status UI event collector.
 *
 * Covers the two regression cases from the Status UI redesign:
 * 1. reconcile must not record a timeline entry when a model's state did not
 *    change (previously every reconcile poll flooded the timeline and
 *    inflated the switch counter);
 * 2. the snapshot overall state maps every model state (anonymous / keyed /
 *    keyed_failed) to the banner state the frontend understands.
 */
import { test, expect } from "bun:test";
import { Checker } from "./checker";
import { Logger } from "../log";

function quietLogger() {
  return new Logger("error");
}

test("ingest ignores same-state duplicates", () => {
  const c = new Checker(quietLogger(), { proxyUrl: "http://x", proxyAuth: "", intervalMs: 1000, timeoutMs: 1000, history: 10 });
  c.ingest({ model: "m1", to: "anonymous" });
  c.ingest({ model: "m1", to: "anonymous" });
  c.ingest({ model: "m1", to: "anonymous" });
  const snap = c.snapshot();
  expect(snap.timeline.length).toBe(1);
  expect(snap.models.find((m) => m.model === "m1")?.switches).toBe(0); // initial appearance has no source state
});

test("ingest records each real switch exactly once", () => {
  const c = new Checker(quietLogger(), { proxyUrl: "http://x", proxyAuth: "", intervalMs: 1000, timeoutMs: 1000, history: 10 });
  c.ingest({ model: "m1", to: "anonymous" });
  c.ingest({ model: "m1", to: "keyed", from: "anonymous" });
  c.ingest({ model: "m1", to: "keyed_failed", from: "keyed" });
  const snap = c.snapshot();
  expect(snap.timeline.length).toBe(3);
  const m1 = snap.models.find((m) => m.model === "m1");
  expect(m1?.switches).toBe(2);
  expect(m1?.state).toBe("keyed_failed");
});

test("timeline is bounded by history", () => {
  const c = new Checker(quietLogger(), { proxyUrl: "http://x", proxyAuth: "", intervalMs: 1000, timeoutMs: 1000, history: 3 });
  for (let i = 0; i < 10; i++) {
    c.ingest({ model: "m1", to: i % 2 ? "keyed" : "anonymous", from: i % 2 ? "anonymous" : "keyed" });
  }
  expect(c.snapshot().timeline.length).toBe(3);
});

test("reconcile does not flood timeline when states are unchanged", async () => {
  const c = new Checker(quietLogger(), { proxyUrl: "http://x", proxyAuth: "", intervalMs: 1000, timeoutMs: 1000, history: 120 });
  // First reconcile introduces the models (reason "initial", no from).
  c.ingest({ model: "a", to: "anonymous", reason: "initial" });
  c.ingest({ model: "b", to: "keyed_failed", reason: "initial" });
  const before = c.snapshot().timeline.length;
  expect(before).toBe(2);

  // Second reconcile sees the same states: nothing may be appended.
  c.ingest({ model: "a", to: "anonymous", reason: "reconciled", from: "anonymous" });
  c.ingest({ model: "b", to: "keyed_failed", reason: "reconciled", from: "keyed_failed" });
  const after = c.snapshot();
  expect(after.timeline.length).toBe(2);
  expect(after.models.find((m) => m.model === "a")?.switches).toBe(0);
});

test("overall state drives banner mapping", () => {
  const c = new Checker(quietLogger(), { proxyUrl: "http://x", proxyAuth: "", intervalMs: 1000, timeoutMs: 1000, history: 10 });
  c.ingest({ model: "a", to: "anonymous" });
  c.ingest({ model: "b", to: "keyed_failed" });
  expect(c.snapshot().overall).toBe("keyed_failed");
});

test("reconcile sends X-Status-Token and loads models", async () => {
  const seen: Array<Record<string, string>> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push({
        authorization: req.headers.get("Authorization") ?? "",
        statusToken: req.headers.get("X-Status-Token") ?? "",
      });
      return new Response(JSON.stringify({ models: [{ model: "m1", state: "anonymous" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const port = (server.port as unknown) as number;
  const c = new Checker(quietLogger(), {
    proxyUrl: `http://127.0.0.1:${port}`,
    proxyAuth: "",
    eventToken: "status-secret",
    intervalMs: 1000,
    timeoutMs: 1000,
    history: 10,
  });
  await c["reconcile"]();
  expect(seen.length).toBe(1);
  expect(seen[0]?.statusToken).toBe("status-secret");
  expect(seen[0]?.authorization).toBe("");
  expect(c.snapshot().models.map((m) => m.model)).toEqual(["m1"]);
  server.stop(true);
});

test("reconcile sends Bearer auth when proxyAuth is set", async () => {
  const seen: Array<Record<string, string>> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push({
        authorization: req.headers.get("Authorization") ?? "",
        statusToken: req.headers.get("X-Status-Token") ?? "",
      });
      return new Response(JSON.stringify({ models: [{ model: "m1", state: "anonymous" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const port = (server.port as unknown) as number;
  const c = new Checker(quietLogger(), {
    proxyUrl: `http://127.0.0.1:${port}`,
    proxyAuth: "caller-secret",
    eventToken: "status-secret",
    intervalMs: 1000,
    timeoutMs: 1000,
    history: 10,
  });
  await c["reconcile"]();
  expect(seen[0]?.authorization).toBe("Bearer caller-secret");
  expect(seen[0]?.statusToken).toBe("status-secret");
  server.stop(true);
});

test("default window is 24h and snapshot reports it", () => {
  const c = new Checker(quietLogger(), { proxyUrl: "http://x", proxyAuth: "", intervalMs: 1000, timeoutMs: 1000, history: 120 });
  const snap = c.snapshot();
  expect(snap.window_ms).toBe(24 * 60 * 60 * 1000);
});

test("custom history window uses the configured span", () => {
  const c = new Checker(quietLogger(), { proxyUrl: "http://x", proxyAuth: "", intervalMs: 1000, timeoutMs: 1000, history: 60 });
  const snap = c.snapshot();
  expect(snap.window_ms).toBe(60 * 1000);
});

test("timeline events older than the window are pruned", () => {
  const c = new Checker(quietLogger(), { proxyUrl: "http://x", proxyAuth: "", intervalMs: 1000, timeoutMs: 1000, history: 120 });
  const now = Date.now();
  const old = now - 30 * 60 * 60 * 1000; // 30h ago: outside the 24h window
  c.ingest({ model: "m1", to: "keyed", from: "anonymous", at: old });
  const freshNow = now + 1000;
  c.ingest({ model: "m1", to: "anonymous", from: "keyed", at: freshNow });
  const snap = c.snapshot();
  expect(snap.timeline.length).toBe(1);
  expect(snap.timeline[0]?.at).toBe(freshNow);
  expect(snap.models.find((m) => m.model === "m1")?.state).toBe("anonymous");
  // The old model still exists with the newest state; only old timeline was pruned.
  expect(snap.models.find((m) => m.model === "m1")?.last_event?.at).toBe(freshNow);
});

test("reconcile keeps timeline clean when state unchanged (no keepalive flood)", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response(JSON.stringify({ models: [{ model: "m1", state: "keyed" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const port = (server.port as unknown) as number;
  const c = new Checker(quietLogger(), { proxyUrl: `http://127.0.0.1:${port}`, proxyAuth: "", intervalMs: 500, timeoutMs: 1000, history: 120 });
  c.ingest({ model: "m1", to: "keyed", reason: "initial", at: Date.now() });
  await c["reconcile"]();
  await c["reconcile"]();
  const snap = c.snapshot();
  expect(snap.timeline.length).toBe(1); // initial only; reconciles add nothing
  expect(snap.models.find((m) => m.model === "m1")?.state).toBe("keyed");
  server.stop(true);
});

test("24h default window prunes events older than 24h even without newer events", () => {
  const c = new Checker(quietLogger(), { proxyUrl: "http://x", proxyAuth: "", intervalMs: 1000, timeoutMs: 1000, history: 120 });
  const old = Date.now() - 26 * 3600 * 1000;
  c.ingest({ model: "m1", to: "keyed", at: old });
  // snapshot() itself doesn't sweep, but ingest() with any newer event does.
  c.ingest({ model: "m2", to: "anonymous", at: Date.now() });
  expect(c.snapshot().timeline.length).toBe(1);
  expect(c.snapshot().timeline[0]?.model).toBe("m2");
});
