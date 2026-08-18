/**
 * Per-model no-key -> API-key fallback. A 429 storm on one model only
 * switches that model to keyed mode; other models keep going anonymously.
 */
import type { Logger } from "../log";
import type { Reporter } from "./reporter";

export type ModelState = "anonymous" | "keyed" | "keyed_failed";

interface ModelFallback {
  keyMode: boolean;
  noKeyFails: number;
  keyedFail: boolean;
}

export class FallbackState {
  private models = new Map<string, ModelFallback>();
  constructor(
    private threshold: number,
    private keysEnabled: boolean,
    private log: Logger,
    private reporter?: Reporter,
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

  recordNoKeyFailure(model: string): boolean {
    if (!this.keysEnabled) return false;
    let st = this.models.get(model);
    if (!st) {
      st = { keyMode: false, noKeyFails: 0, keyedFail: false };
      this.models.set(model, st);
    } else if (st.keyMode) {
      return false;
    }
    st.noKeyFails++;
    if (st.noKeyFails >= this.threshold) {
      this.log.info("no-key upstream failing repeatedly, switching model to API-key mode", { model, failures: st.noKeyFails });
      st.keyMode = true;
      st.noKeyFails = 0;
      this.emit(model, "anonymous", "keyed", "anonymous_failures", "anonymous requests failed repeatedly");
      return true;
    }
    return false;
  }

  forceSwitchToKey(model: string): boolean {
    if (!this.keysEnabled) return false;
    let st = this.models.get(model);
    if (!st) {
      st = { keyMode: false, noKeyFails: 0, keyedFail: false };
      this.models.set(model, st);
    }
    if (st.keyMode) return false;
    this.log.info("upstream non-2xx, switching model to API-key mode", { model });
    st.keyMode = true;
    st.noKeyFails = 0;
    this.emit(model, "anonymous", "keyed", "upstream_error", "first non-2xx response");
    return true;
  }

  recordNoKeySuccess(model: string) {
    if (!this.keysEnabled) return;
    const st = this.models.get(model);
    if (!st || st.keyMode) return;
    st.noKeyFails = 0;
  }

  trySwitchToNoKey(model: string): boolean {
    if (!this.keysEnabled) return false;
    const st = this.models.get(model);
    if (!st || !st.keyMode) return false;
    this.log.info("no-key upstream recovered, switching model back to anonymous mode", { model });
    const from = st.keyedFail ? "keyed_failed" : "keyed";
    st.keyMode = false;
    st.noKeyFails = 0;
    st.keyedFail = false;
    this.emit(model, from, "anonymous", "probe_recovered", "anonymous probe succeeded");
    return true;
  }

  reportKeyedResult(model: string, ok: boolean, detail: string) {
    if (!this.keysEnabled) return;
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
