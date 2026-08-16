/**
 * Status UI event collector: receives model state-change reports from the
 * proxy (POST /api/events), keeps the current per-model state plus a timeline
 * of every switch, and periodically reconciles with the proxy's /debug/modes
 * endpoint so restarts or missed deliveries cannot leave the page stale.
 */
import { Logger } from "../log";

export type State = "anonymous" | "keyed" | "keyed_failed" | "unknown";

export interface StateEvent {
  type?: string;
  model: string;
  from?: string;
  to: string;
  reason?: string;
  detail?: string;
  at?: number;
}

export interface ModelView {
  model: string;
  state: State;
  since: number;
  switches: number;
  last_event: StateEvent | null;
}

export interface Snapshot {
  overall: State;
  last_event_at: number;
  last_reconcile: number;
  interval: number;
  models: ModelView[];
  timeline: StateEvent[];
}

function validState(s: string): boolean {
  return s === "anonymous" || s === "keyed" || s === "keyed_failed";
}

export class Checker {
  private models = new Map<string, ModelView>();
  private timeline: StateEvent[] = [];
  private lastReconcile = 0;
  private proxyUrl: string;
  private proxyAuth: string;
  private intervalMs: number;
  private timeoutMs: number;
  private history: number;

  constructor(
    private log: Logger,
    opts: {
      proxyUrl: string;
      proxyAuth: string;
      intervalMs: number;
      timeoutMs: number;
      history: number;
    },
  ) {
    this.proxyUrl = opts.proxyUrl;
    this.proxyAuth = opts.proxyAuth;
    this.intervalMs = opts.intervalMs;
    this.timeoutMs = opts.timeoutMs;
    this.history = opts.history;
  }

  start() {
    void this.reconcile();
    setInterval(() => void this.reconcile(), this.intervalMs);
  }

  ingest(ev: StateEvent) {
    if (ev.type !== undefined && ev.type !== "" && ev.type !== "state_change") return;
    if (!validState(ev.to)) return;
    const at = ev.at ?? Date.now();
    const entry: StateEvent = { ...ev, at };
    const view = this.models.get(ev.model) ?? {
      model: ev.model,
      state: "unknown" as State,
      since: 0,
      switches: 0,
      last_event: null,
    };
    view.state = ev.to as State;
    if (view.state !== "unknown") view.switches++;
    view.last_event = entry;
    this.models.set(ev.model, view);
    this.timeline.push(entry);
    if (this.timeline.length > this.history) this.timeline.shift();
  }

  snapshot(): Snapshot {
    const overall = this.overallState();
    const last = this.timeline[this.timeline.length - 1];
    return {
      overall,
      last_event_at: last?.at ?? 0,
      last_reconcile: this.lastReconcile,
      interval: Math.round(this.intervalMs / 1000),
      models: [...this.models.values()]
        .sort((a, b) => a.model.localeCompare(b.model))
        .map((m) => ({ ...m })),
      timeline: [...this.timeline],
    };
  }

  private overallState(): State {
    if (this.models.size === 0) return "unknown";
    let keyedOrFailed = 0;
    for (const m of this.models.values()) {
      if (m.state === "keyed_failed") return "keyed_failed";
      if (m.state === "keyed") keyedOrFailed++;
    }
    return keyedOrFailed > 0 ? "keyed" : "anonymous";
  }

  private async reconcile() {
    try {
      const headers: Record<string, string> = {};
      if (this.proxyAuth) headers.Authorization = `Bearer ${this.proxyAuth}`;
      const res = await fetch(`${this.proxyUrl}/debug/modes`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { models?: Array<{ model: string; state: string }> };
      for (const m of data.models ?? []) {
        if (validState(m.state)) {
          this.ingest({ model: m.model, to: m.state as State, reason: "reconcile", at: Date.now() });
        }
      }
      this.lastReconcile = Date.now();
    } catch {
      this.log.debug("reconcile failed");
    }
  }
}
