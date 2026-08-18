/**
 * Unit tests for the per-model anonymous <-> API-key fallback lifecycle,
 * especially the hold-then-confirm recovery flow.
 */
import { describe, expect, test } from "bun:test";
import { FallbackState } from "./fallback";
import { Logger } from "../log";

function make(overrides: { holdMs?: number; confirmations?: number } = {}) {
  const events: Array<Record<string, unknown>> = [];
  const reporter = {
    send: (ev: Record<string, unknown>) => {
      events.push(ev);
    },
  };
  const fs = new FallbackState(
    2,
    true,
    new Logger("error"),
    reporter as never,
    overrides.holdMs ?? 300_000,
    overrides.confirmations ?? 3,
    () => 0,
  );
  return { fs, events };
}

describe("recovery hold + confirmations", () => {
  test("key mode is held for the hold window before probes are allowed", () => {
    const { fs } = make({ holdMs: 300_000 });
    let t = 0;
    (fs as unknown as { now: () => number }).now = () => t;
    fs.forceSwitchToKey("m1");
    expect(fs.state("m1")).toBe("keyed");
    // Inside the hold window: probes must be skipped entirely.
    expect(fs.probesActive("m1")).toBe(false);
    t = 299_999;
    expect(fs.probesActive("m1")).toBe(false);
    expect(fs.state("m1")).toBe("keyed");
    // At the boundary, probing resumes.
    t = 300_000;
    expect(fs.probesActive("m1")).toBe(true);
    expect(fs.state("m1")).toBe("keyed");
  });

  test("switches back to anonymous only after N consecutive probe successes", () => {
    const { fs, events } = make({ holdMs: 300_000, confirmations: 3 });
    let t = 0;
    (fs as unknown as { now: () => number }).now = () => t;
    fs.forceSwitchToKey("m1");
    t = 300_000;
    // Two successes: still keyed and probes stay active.
    expect(fs.takeProbeResult("m1", true)).toBe(false);
    expect(fs.takeProbeResult("m1", true)).toBe(false);
    expect(fs.state("m1")).toBe("keyed");
    expect(fs.probesActive("m1")).toBe(true);
    // Third consecutive success: switch to anonymous and emit once.
    expect(fs.takeProbeResult("m1", true)).toBe(true);
    expect(fs.state("m1")).toBe("anonymous");
    expect(fs.probesActive("m1")).toBe(false);
    expect(events.map((e) => e.to)).toEqual(["keyed", "anonymous"]);
  });

  test("a failed probe resets the streak without leaving key mode", () => {
    const { fs, events } = make({ holdMs: 300_000, confirmations: 3 });
    let t = 0;
    (fs as unknown as { now: () => number }).now = () => t;
    fs.forceSwitchToKey("m1");
    t = 300_000;
    expect(fs.takeProbeResult("m1", true)).toBe(false);
    expect(fs.takeProbeResult("m1", true)).toBe(false);
    expect(fs.takeProbeResult("m1", false)).toBe(false);
    expect(fs.state("m1")).toBe("keyed");
    // Streak was reset: two more successes are not enough to recover.
    expect(fs.takeProbeResult("m1", true)).toBe(false);
    expect(fs.takeProbeResult("m1", true)).toBe(false);
    expect(fs.state("m1")).toBe("keyed");
    expect(fs.takeProbeResult("m1", true)).toBe(true);
    expect(fs.state("m1")).toBe("anonymous");
    expect(events.filter((e) => e.to === "anonymous").length).toBe(1);
  });

  test("no probes while the hold window is active even with success", () => {
    const { fs } = make({ holdMs: 300_000, confirmations: 3 });
    let t = 0;
    (fs as unknown as { now: () => number }).now = () => t;
    fs.forceSwitchToKey("m1");
    t = 100_000;
    expect(fs.takeProbeResult("m1", true)).toBe(false);
    expect(fs.state("m1")).toBe("keyed");
    expect(fs.probesActive("m1")).toBe(false);
  });

  test("confirmations=1 switches back on a single probe success", () => {
    const { fs } = make({ holdMs: 300_000, confirmations: 1 });
    let t = 0;
    (fs as unknown as { now: () => number }).now = () => t;
    fs.forceSwitchToKey("m1");
    t = 300_000;
    expect(fs.takeProbeResult("m1", true)).toBe(true);
    expect(fs.state("m1")).toBe("anonymous");
  });

  test("probe flow starts from anonymous after a failed non-2xx switch", () => {
    const { fs } = make({ holdMs: 300_000, confirmations: 3 });
    let t = 0;
    (fs as unknown as { now: () => number }).now = () => t;
    fs.recordNoKeyFailure("m1");
    fs.recordNoKeyFailure("m1"); // threshold=2 -> keyed
    expect(fs.state("m1")).toBe("keyed");
    expect(fs.probesActive("m1")).toBe(false); // inside hold
    t = 300_000;
    expect(fs.probesActive("m1")).toBe(true);
  });
});

describe("status visibility", () => {
  test("model stays keyed through hold and probing; recovered only at the end", () => {
    const { fs } = make({ holdMs: 300_000, confirmations: 3 });
    let t = 0;
    (fs as unknown as { now: () => number }).now = () => t;
    fs.forceSwitchToKey("m1");
    expect(fs.state("m1")).toBe("keyed");
    t = 300_000;
    expect(fs.probesActive("m1")).toBe(true);
    expect(fs.state("m1")).toBe("keyed");
    fs.takeProbeResult("m1", true);
    expect(fs.state("m1")).toBe("keyed");
    fs.takeProbeResult("m1", true);
    expect(fs.state("m1")).toBe("keyed");
    fs.takeProbeResult("m1", true);
    expect(fs.state("m1")).toBe("anonymous");
  });
});
