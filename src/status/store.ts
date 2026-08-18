/**
 * JSON file store for the Status UI history. Persists the full checker state
 * (per-model views + timeline) so a restart brings back the last 24h instead
 * of starting empty. Writes are atomic: data is written to a temp file and
 * renamed over the target, so a crash mid-write can never corrupt the
 * previous snapshot. The file is debounced - hard state like a restart or
 * shutdown flushes immediately, while high-frequency events are coalesced.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelView, StateEvent } from "./checker";

export interface StoreData {
  v: number;
  savedAt: number;
  models: ModelView[];
  timeline: StateEvent[];
}

export class JsonStore {
  private pending: StoreData | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  constructor(private file: string, private flushMs = 2000) {}

  path(): string {
    return this.file;
  }

  exists(): Promise<boolean> {
    try {
      return Bun.file(this.file).exists();
    } catch {
      return Promise.resolve(false);
    }
  }

  async load(): Promise<StoreData | null> {
    try {
      const f = Bun.file(this.file);
      if (!(await f.exists())) return null;
      const raw = await f.text();
      if (!raw.trim()) return null;
      const data = JSON.parse(raw) as StoreData;
      if (!data || data.v !== 1 || !Array.isArray(data.models) || !Array.isArray(data.timeline)) {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  /** Queue a write (debounced). Use flush() for shutdown / SIGTERM. */
  save(data: StoreData) {
    if (this.closed) return;
    this.pending = data;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
  }

  /** Write immediately. Safe to call multiple times. */
  async flush(): Promise<void> {
    if (this.closed) return;
    const data = this.pending;
    if (!data) return;
    this.pending = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      // Persistence is best-effort: never break the status path.
      // eslint-disable-next-line no-console
      console.error("[status] failed to persist history:", err);
    }
  }

  /** Best-effort final flush on shutdown. */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
    this.closed = true;
  }
}

export function defaultStoreFile(): string {
  const env = process.env.STATUS_DB || "";
  if (env) return env;
  return join(process.cwd(), "data", "status.json");
}
