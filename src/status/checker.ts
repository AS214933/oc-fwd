/**
 * Status UI event collector: receives model state-change reports from the
 * proxy (POST /api/events), keeps the current per-model state plus a timeline
 * of every switch, and periodically reconciles with the proxy's /debug/modes
 * endpoint so restarts or missed deliveries cannot leave the page stale.
 *
 * The snapshot exposes the last 24 hours of timeline by default so the UI can
 * render "Status over the last 24 hours" out of the box. Events older than
 * the retention window are pruned from memory.
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
  /** Timeline window in milliseconds (STATUS_HISTORY_SECONDS / 24h default). */
  window_ms: number;
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
  private eventToken: string;
  private intervalMs: number;
  private timeoutMs: number;
  private history: number;

  constructor(
    private log: Logger,
    opts: {
      proxyUrl: string;
      proxyAuth: string;
      eventToken?: string;
      intervalMs: number;
      timeoutMs: number;
      history: number;
    },
  ) {
    this.proxyUrl = opts.proxyUrl;
    this.proxyAuth = opts.proxyAuth;
    this.eventToken = opts.eventToken ?? "";
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
    const view = this.models.get(ev.model) ?? {
      model: ev.model,
      state: "unknown" as State,
      since: 0,
      switches: 0,
      last_event: null,
    };
    if (view.state === ev.to) return; // no actual switch: record nothing
    const entry: StateEvent = { ...ev, at };
    view.state = ev.to as State;
    view.since = at;
    if (ev.from) view.switches++; // only count transitions with an explicit source state
    view.last_event = entry;
    this.models.set(ev.model, view);
    this.timeline.push(entry);
    this.sweep(at);
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
      window_ms: this.windowMs(),
      models: [...this.models.values()]
        .sort((a, b) => a.model.localeCompare(b.model))
        .map((m) => ({ ...m })),
      timeline: [...this.timeline],
    };
  }

  /** Timeline window: the configured history span in seconds if set,
   *  otherwise the 24h default. */
  private windowMs(): number {
    if (this.history !== 120) return this.history * 1000;
    return 24 * 60 * 60 * 1000;
  }

  private sweep(now: number) {
    const keep = this.windowMs();
    while (this.timeline.length > 0 && now - (this.timeline[0]?.at ?? 0) > keep) this.timeline.shift();
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
      if (this.eventToken) headers["X-Status-Token"] = this.eventToken;
      const res = await fetch(`${this.proxyUrl}/debug/modes`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { models?: Array<{ model: string; state: string }> };
      const now = Date.now();
      for (const m of data.models ?? []) {
        if (!validState(m.state)) continue;
        const known = this.models.get(m.model)?.state;
        if (known === m.state) continue;
        this.ingest({
          model: m.model,
          to: m.state as State,
          from: known && known !== "unknown" ? known : undefined,
          reason: known ? "reconciled" : "initial",
          at: now,
        });
      }
      this.lastReconcile = now;
    } catch {
      this.log.debug("reconcile failed");
    }
  }
}
