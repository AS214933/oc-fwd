/**
 * 429 circuit breaker: after threshold consecutive upstream 429s the breaker
 * opens and rejects requests without contacting the upstream until the
 * cooldown elapses.
 */
export class Circuit {
  private failures = 0;
  private openedAt = 0;
  constructor(
    private threshold: number,
    private cooldownMs: number,
    private now: () => number = () => Date.now(),
  ) {}

  allow(): boolean {
    if (this.threshold <= 0) return true;
    if (this.failures >= this.threshold) {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.failures = 0; // half-open: let one request through
        return true;
      }
      return false;
    }
    return true;
  }

  recordFailure() {
    if (this.threshold <= 0) return;
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }

  recordSuccess() {
    this.failures = 0;
  }

  reset() {
    this.failures = 0;
    this.openedAt = 0;
  }
}
