/** Wall-clock maintenance retries must not turn into character sleep or inference loops. */
export class MaintenanceRetry {
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  remainingMs(): number { return Math.max(0, this.retryAt - this.now()); }

  failed(): { failures: number; retryAt: number; delayMs: number } {
    this.failures++;
    const delayMs = Math.min(300_000, 30_000 * 2 ** Math.min(this.failures - 1, 4));
    this.retryAt = this.now() + delayMs;
    return { failures: this.failures, retryAt: this.retryAt, delayMs };
  }

  snapshot(): { failures: number; retryAt: number } { return { failures: this.failures, retryAt: this.retryAt }; }

  reset(): void { this.failures = 0; this.retryAt = 0; }
}
