/**
 * Per-model no-key -> API-key fallback. A 429 storm on one model only
 * switches that model to keyed mode; other models keep going anonymously.
 *
 * Recovery follows a hold-then-confirm flow: after a confirmed failure the
 * model stays in keyed mode for a hold window (default 5 minutes) with no
 * anonymous probes at all; once the hold expires the probe loop runs every
 * ZEN_NO_KEY_PROBE_SECONDS and only switches back to anonymous after
 * ZEN_NO_KEY_RECOVERY_CONFIRMATIONS consecutive successful probes, so a
 * flaky upstream cannot flap the model back and forth.
 */
import type { Logger } from "../log";
import type { Reporter } from "./reporter";

export type ModelState = "anonymous" | "keyed" | "keyed_failed";

interface ModelFallback {
  keyMode: boolean;
  noKeyFails: number;
  keyedFail: boolean;
  keyedAt: number;
  probeStreak: number;
}

export class FallbackState {
  private models = new Map<string, ModelFallback>();
  /** Model -> timestamp of its most recent route through this proxy, so the
   *  status UI can surface exactly the models that were actually called
   *  within the 24h window. */
  private seen = new Map<string, number>();
  constructor(
    private threshold: number,
    private keysEnabled: boolean,
    private log: Logger,
    private reporter?: Reporter,
    private holdMs: number = 5 * 60 * 1000,
    private confirmations: number = 3,
    private nowFn: () => number = () => Date.now(),
  ) {}

  state(model: string): ModelState {
    const st = this.models.get(model);
    if (!st || !st.keyMode) return "anonymous";
    return st.keyedFail ? "keyed_failed" : "keyed";
  }

  inKeyMode(model: string): boolean {
    if (!this.keysEnabled) return false;
    return this.models.get(model)?.keyMode === true;
  }

  keyedModels(): string[] {
    if (!this.keysEnabled) return [];
    const out: string[] = [];
    for (const [model, st] of this.models) {
      if (st.keyMode) out.push(model);
    }
    return out;
  }

  knownModels(): string[] {
    return [...this.seen.keys()];
  }

  /** Unix ms of the most recent time this model was routed (0 if never). */
  lastSeenAt(model: string): number {
    return this.seen.get(model) ?? 0;
  }

  /** Record that this model was routed right now. */
  private touch(model: string) {
    this.seen.set(model, this.nowFn());
  }

  /** Current clock value used for routing timestamps (injectable in tests). */
  clock(): number {
    return this.nowFn();
  }

  /** Public entry point used by the upstream client / handler to mark that
   *  a request for this model reached the routing path (before any retry or
   *  fallback decision), so "called" means "attempted", not only "succeeded". */
  noteCall(model: string) {
    this.touch(model);
  }

  recordNoKeyFailure(model: string): boolean {
    if (!this.keysEnabled) return false;
    this.touch(model);
    let st = this.models.get(model);
    if (!st) {
      st = { keyMode: false, noKeyFails: 0, keyedFail: false, keyedAt: 0, probeStreak: 0 };
      this.models.set(model, st);
    } else if (st.keyMode) {
      return false;
    }
    st.noKeyFails++;
    if (st.noKeyFails >= this.threshold) {
      this.log.info("no-key upstream failing repeatedly, switching model to API-key mode", { model, failures: st.noKeyFails });
      st.keyMode = true;
      st.noKeyFails = 0;
      st.keyedAt = this.nowFn();
      st.probeStreak = 0;
      this.emit(model, "anonymous", "keyed", "anonymous_failures", "anonymous requests failed repeatedly");
      return true;
    }
    return false;
  }

  forceSwitchToKey(model: string): boolean {
    if (!this.keysEnabled) return false;
    this.touch(model);
    let st = this.models.get(model);
    if (!st) {
      st = { keyMode: false, noKeyFails: 0, keyedFail: false, keyedAt: 0, probeStreak: 0 };
      this.models.set(model, st);
    }
    if (st.keyMode) return false;
    this.log.info("upstream non-2xx, switching model to API-key mode", { model });
    st.keyMode = true;
    st.noKeyFails = 0;
    st.keyedAt = this.nowFn();
    st.probeStreak = 0;
    this.emit(model, "anonymous", "keyed", "upstream_error", "first non-2xx response");
    return true;
  }

  recordNoKeySuccess(model: string) {
    this.touch(model);
    if (!this.keysEnabled) return;
    let st = this.models.get(model);
    if (!st) {
      this.models.set(model, { keyMode: false, noKeyFails: 0, keyedFail: false, keyedAt: 0, probeStreak: 0 });
      return;
    }
    if (st.keyMode) return;
    st.noKeyFails = 0;
  }

  takeProbeResult(model: string, ok: boolean): boolean {
    this.touch(model);
    if (!this.keysEnabled) return false;
    if (!this.probesActive(model)) return false;
    const st = this.models.get(model);
    if (!st || !st.keyMode) return false;
    if (ok) {
      // A keyed success does not reset the streak: intermediate trafficless
      // gaps and held key-mode periods must not undo accumulated probe
      // successes. Only a failed probe (or leaving key mode) resets it.
      const next = st.probeStreak + 1;
      const done = next >= this.confirmations;
      this.log.debug("no-key probe succeeded", { model, streak: next, confirmations: this.confirmations });
      if (done) {
        this.log.info("no-key upstream recovered, switching model back to anonymous mode", { model, confirmations: next });
        st.keyMode = false;
        st.noKeyFails = 0;
        st.keyedFail = false;
        st.keyedAt = 0;
        st.probeStreak = 0;
        this.emit(model, "keyed", "anonymous", "probe_recovered", "anonymous probe succeeded");
        return true;
      }
      st.probeStreak = next;
      return false;
    }
    if (st.probeStreak > 0) {
      this.log.info("no-key probe failed, restarting recovery streak", { model, streak: st.probeStreak });
    }
    st.probeStreak = 0;
    return false;
  }

  /** Whether the probe loop should ping this model right now: it must be in
   *  key mode, the hold window must have elapsed, and it must still be short
   *  of the confirmation streak. While the hold window is active no anonymous
   *  probes run at all; once it expires probing resumes every
   *  ZEN_NO_KEY_PROBE_SECONDS until N consecutive probes succeed. */
  probesActive(model: string): boolean {
    if (!this.keysEnabled) return false;
    const st = this.models.get(model);
    if (!st || !st.keyMode) return false;
    if (this.nowFn() - st.keyedAt < this.holdMs) return false; // inside the hold window
    return st.probeStreak < this.confirmations;
  }

  reportKeyedResult(model: string, ok: boolean, detail: string) {
    if (!this.keysEnabled) return;
    this.touch(model);
    const st = this.models.get(model);
    if (!st || !st.keyMode) return;
    let from = "";
    let to = "";
    if (ok && st.keyedFail) {
      from = "keyed_failed";
      to = "keyed";
      st.keyedFail = false;
    } else if (!ok && !st.keyedFail) {
      from = "keyed";
      to = "keyed_failed";
      st.keyedFail = true;
    }
    if (to) this.emit(model, from, to, "keyed_error", detail);
  }

  private emit(model: string, from: string, to: string, reason: string, detail: string) {
    this.reporter?.send({ model, from, to, reason, detail });
  }
}
