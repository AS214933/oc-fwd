/**
 * Unit tests for the Status UI model visibility filter (debugVisibleModels):
 * only models actually called within the 24h window show up, and a model
 * still in keyed state stays visible even without fresh traffic.
 */
import { test, expect } from "bun:test";
import { debugVisibleModels, type DebugModeSource } from "./handler";

const WINDOW = 24 * 60 * 60 * 1000;

function makeSource(entries: Array<{ model: string; seenAt?: number; state?: string; keyed?: boolean }>): DebugModeSource {
  const seen = new Map<string, number>();
  const keyed = new Set<string>();
  const states = new Map<string, string>();
  for (const e of entries) {
    if (e.seenAt !== undefined) seen.set(e.model, e.seenAt);
    if (e.state) states.set(e.model, e.state);
    if (e.keyed) keyed.add(e.model);
  }
  return {
    knownModels: () => [...seen.keys()],
    lastSeenAt: (m) => seen.get(m) ?? 0,
    modelState: (m) => (keyed.has(m) ? states.get(m) ?? "keyed" : "anonymous"),
    keyedModels: () => [...keyed],
  };
}

test("no models until one is called", () => {
  const out = debugVisibleModels(1_000_000, WINDOW, makeSource([]), false, {});
  expect(out).toEqual([]);
});

test("a model called within the window shows up; an expired one does not", () => {
  const now = 1_000_000;
  const src = makeSource([
    { model: "fresh", seenAt: now - 1000 },
    { model: "stale", seenAt: now - 25 * 3600 * 1000 },
  ]);
  const out = debugVisibleModels(now, WINDOW, src, false, {});
  expect(out.map((m) => m.model)).toEqual(["fresh"]);
});

test("a keyed model stays visible even after the 24h window", () => {
  const now = 1_000_000;
  const src = makeSource([
    { model: "stuck", seenAt: now - 30 * 3600 * 1000, state: "keyed", keyed: true },
    { model: "gone", seenAt: now - 30 * 3600 * 1000 },
  ]);
  const out = debugVisibleModels(now, WINDOW, src, false, {});
  expect(out).toEqual([{ model: "stuck", state: "keyed" }]);
});

test("aliases appear only once actually called", () => {
  const now = 1_000_000;
  const src = makeSource([
    { model: "used-alias", seenAt: now - 1000 },
    { model: "never-alias", seenAt: now - 30 * 3600 * 1000 },
  ]);
  const out = debugVisibleModels(now, WINDOW, src, false, { "used-alias": "x", "never-alias": "y" });
  expect(out.map((m) => m.model)).toEqual(["used-alias"]);
});
