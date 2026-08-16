/**
 * Model state-change reporter: pushes anonymous <-> keyed <-> keyed_failed
 * transitions to the optional Status UI. Fire-and-forget: events are queued
 * on a bounded channel and dropped when the UI is unreachable, so reporting
 * never slows down or breaks the proxy request path.
 */
import type { Logger } from "../log";

export interface StateEvent {
  type?: string;
  model: string;
  from?: string;
  to: string;
  reason?: string;
  detail?: string;
  at?: number;
}

export class Reporter {
  private queue: StateEvent[] = [];
  private running = false;
  constructor(
    private url: string,
    private token: string,
    private log: Logger,
    private maxQueue = 1024,
  ) {}

  start() {
    this.running = true;
    void this.loop();
  }

  send(ev: StateEvent) {
    if (!this.url) return;
    if (this.queue.length >= this.maxQueue) return; // drop on overflow
    this.queue.push(ev);
  }

  private async loop() {
    while (this.running) {
      const ev = this.queue.shift();
      if (!ev) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      try {
        const res = await fetch(`${this.url}/api/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify({ type: "state_change", at: Date.now(), ...ev }),
          signal: AbortSignal.timeout(3000),
        });
        await res.body?.cancel().catch(() => {});
      } catch {
        // The UI is optional; never retry and never surface errors.
        this.log.debug("status report failed", { model: ev.model });
      }
    }
  }
}
