/** A generation budget may pause while an already committed action takes world time. */
export class WorldDeadline {
  private readonly controller = new AbortController();
  private remaining: number;
  private started = 0;
  private timer?: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  constructor(milliseconds: number | undefined, parent: AbortSignal, readonly code: string) {
    this.remaining = Number.isFinite(milliseconds) && milliseconds! > 0 ? milliseconds! : 180_000;
    this.signal = AbortSignal.any([parent, this.controller.signal]);
    this.resume();
  }
  get expired(): boolean { return this.controller.signal.aborted; }
  pause(): void {
    if (!this.timer) return;
    clearTimeout(this.timer); this.timer = undefined;
    this.remaining = Math.max(0, this.remaining - (performance.now() - this.started));
  }
  resume(): void {
    if (this.timer || this.signal.aborted) return;
    this.started = performance.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.controller.abort(new DOMException(`${this.code}: 世界生成超过总时限；尚未确认的结果没有生效。`, "TimeoutError"));
    }, this.remaining);
  }
  dispose(): void { this.pause(); }
}
