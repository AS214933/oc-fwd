import { describe, expect, test } from "bun:test";
import { cachedTlsSession, rememberTlsSession } from "./dial";

describe("TLS session cache", () => {
  test("returns undefined before any session is stored", () => {
    expect(cachedTlsSession("opencode.ai")).toBeUndefined();
  });

  test("stores and returns the latest session per host", () => {
    rememberTlsSession("opencode.ai", Buffer.from("ticket-1"));
    expect(cachedTlsSession("opencode.ai")).toEqual(Buffer.from("ticket-1"));
    // newer session replaces the old one
    rememberTlsSession("opencode.ai", Buffer.from("ticket-2"));
    expect(cachedTlsSession("opencode.ai")).toEqual(Buffer.from("ticket-2"));
  });

  test("hosts are independent", () => {
    rememberTlsSession("a.example", Buffer.from("aaa"));
    rememberTlsSession("b.example", Buffer.from("bbb"));
    expect(cachedTlsSession("a.example")).toEqual(Buffer.from("aaa"));
    expect(cachedTlsSession("b.example")).toEqual(Buffer.from("bbb"));
    expect(cachedTlsSession("c.example")).toBeUndefined();
  });

  test("empty or missing session evicts the entry", () => {
    rememberTlsSession("opencode.ai", Buffer.from("ticket"));
    expect(cachedTlsSession("opencode.ai")).toBeDefined();
    rememberTlsSession("opencode.ai", Buffer.from(""));
    expect(cachedTlsSession("opencode.ai")).toBeUndefined();
    rememberTlsSession("opencode.ai", Buffer.from("ticket2"));
    rememberTlsSession("opencode.ai", null);
    expect(cachedTlsSession("opencode.ai")).toBeUndefined();
  });
});
