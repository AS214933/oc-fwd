/**
 * Unit tests for the JSON file store (atomic write, load, round-trip).
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore, type StoreData } from "./store";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "status-store-"));
  return join(dir, "status.json");
}

function sample(): StoreData {
  return {
    v: 1,
    savedAt: 123,
    models: [
      { model: "m1", state: "keyed", since: 100, switches: 2, last_event: { model: "m1", to: "keyed", reason: "upstream_error", at: 100 } },
      { model: "m2", state: "anonymous", since: 50, switches: 0, last_event: { model: "m2", to: "anonymous", reason: "initial", at: 50 } },
    ],
    timeline: [
      { model: "m1", to: "anonymous", from: undefined, reason: "initial", at: 50 },
      { model: "m1", to: "keyed", from: "anonymous", reason: "upstream_error", at: 100 },
    ],
  };
}

test("round-trips through the JSON file", async () => {
  const file = tmpFile();
  const store = new JsonStore(file, 1);
  store.save(sample());
  await store.flush();
  const loaded = await new JsonStore(file).load();
  expect(loaded).toEqual(sample());
});

test("load returns null when the file is missing", async () => {
  const store = new JsonStore(join(tmpdir(), "no-such-dir", "nope.json"));
  expect(await store.load()).toBeNull();
});

test("load returns null for corrupt content instead of throwing", async () => {
  const file = tmpFile();
  await Bun.write(file, "{ not json !!");
  const store = new JsonStore(file);
  expect(await store.load()).toBeNull();
});

test("write creates parent directories", async () => {
  const file = join(tmpdir(), "nested-status-dir", "deep", "status.json");
  const store = new JsonStore(file, 1);
  store.save(sample());
  await store.flush();
  expect(await new JsonStore(file).load()).toEqual(sample());
});
