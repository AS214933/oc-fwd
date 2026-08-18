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
