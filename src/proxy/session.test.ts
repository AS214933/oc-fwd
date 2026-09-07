import { describe, expect, test } from "bun:test";
import { generateSessionID, isValidSessionID, SessionIDPool } from "./session";

describe("generateSessionID", () => {
  test("matches opencode's ses_<12hex+14base62> format", () => {
    const id = generateSessionID();
    expect(id.startsWith("ses_")).toBe(true);
    expect(id.length).toBe(26 + 4);
    expect(isValidSessionID(id)).toBe(true);
  });

  test("encodes the timestamp in the leading 12 hex chars", () => {
    const ts = 1757200000123;
    const id = generateSessionID(ts);
    // Low 48 bits of ~(ts * 0x1000 + counter=1), opencode's descending scheme.
    const expected = ~(BigInt(ts) * 0x1000n + 0x1n) & 0xffffffffffffn;
    expect(id.slice(4, 16)).toBe(expected.toString(16).padStart(12, "0"));
  });

  test("is unique across calls in the same millisecond", () => {
    const ts = 1757200000123;
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionID(ts)));
    expect(ids.size).toBe(100);
  });
});

describe("SessionIDPool", () => {
  test("sticky per identity within the TTL", () => {
    const pool = new SessionIDPool(60_000);
    const a = pool.sessionFor("caller-1", 1000);
    expect(pool.sessionFor("caller-1", 30_000)).toBe(a);
    // Another caller gets its own id.
    expect(pool.sessionFor("caller-2", 30_000)).not.toBe(a);
  });

  test("mints a fresh id after the TTL lapses", () => {
    const pool = new SessionIDPool(60_000);
    const a = pool.sessionFor("caller-1", 1000);
    const b = pool.sessionFor("caller-1", 61_001);
    expect(b).not.toBe(a);
    // And the new one is sticky again.
    expect(pool.sessionFor("caller-1", 70_000)).toBe(b);
  });

  test("evicts the coldest caller beyond maxEntries", () => {
    const pool = new SessionIDPool(60_000, 2);
    pool.sessionFor("a", 1000);
    pool.sessionFor("b", 1000);
    pool.sessionFor("c", 1000); // evicts "a" (LRU)
    expect(pool.size()).toBe(2);
    const b = pool.sessionFor("b", 1001);
    expect(b).toBeTruthy();
  });

  test("re-hit refreshes the TTL and LRU position", () => {
    const pool = new SessionIDPool(60_000, 2);
    const a = pool.sessionFor("a", 1000);
    pool.sessionFor("b", 1000);
    pool.sessionFor("a", 2000); // "a" becomes most recently used
    pool.sessionFor("c", 3000); // evicts "b", not "a"
    expect(pool.sessionFor("a", 3100)).toBe(a);
  });
});
