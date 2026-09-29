import type { EndpointLockTiming } from "../llm/lock.js";
import { debug } from "../webui/debug.js";

/** Wall-clock costs of one adjudication phase, never world-calendar durations.
 * modelMs is the first request; repairMs contains later requests and their validation.
 * Endpoint waiting is always counted in queueMs, not in modelMs/repairMs. */
export class WorldPhaseTiming {
  private readonly started = performance.now();
  private entry: number;
  private closed = false;
  private stage = "prepare";
  private attempts = 0;
  private preparationMs = 0;
  private endpointQueueMs = 0;
  private modelMs = 0;
  private repairMs = 0;
  private validationMs = 0;
  private saveMs = 0;
  private inputChars = 0;
  private outputChars = 0;
  private discardedSuggestions = 0;
  private executionRefreshes = 0;

  constructor(private identity: { id: string; source: string; actorId?: string; actionPhase?: string }, private worldQueueMs = 0, private acceptanceSaveMs = 0) {
    this.saveMs = acceptanceSaveMs;
    this.entry = debug.emit("world.tool", "世界裁定 · 准备", this.snapshot());
  }
  private snapshot() {
    const ms = (n: number) => Math.round(Math.max(0, n) * 100) / 100;
    return { ...this.identity, stage: this.stage, timing: {
      queueMs: ms(this.worldQueueMs + this.endpointQueueMs), worldQueueMs: ms(this.worldQueueMs), endpointQueueMs: ms(this.endpointQueueMs),
      preparationMs: ms(this.preparationMs), modelMs: ms(this.modelMs), repairMs: ms(this.repairMs), validationMs: ms(this.validationMs), saveMs: ms(this.saveMs),
      totalMs: ms(performance.now() - this.started + this.worldQueueMs + this.acceptanceSaveMs), attempts: this.attempts, repairs: Math.max(0, this.attempts - 1),
      inputChars: this.inputChars, outputChars: this.outputChars, discardedSuggestions: this.discardedSuggestions, executionRefreshes: this.executionRefreshes,
    } };
  }
  private update(label: string) {
    if (this.closed) return;
    if (debug.has(this.entry)) debug.update(this.entry, { label, detail: this.snapshot() });
    else this.entry = debug.emit("world.tool", label, this.snapshot());
  }
  prepared(inputChars: number) {
    this.preparationMs = performance.now() - this.started; this.inputChars = inputChars;
  }
  request(attempt: number) {
    const started = performance.now();
    let queueMs = 0, runMs: number | undefined, runStarted: number | undefined, ended = false;
    this.attempts++; this.stage = attempt ? "repair" : "inference";
    this.update(attempt ? "世界裁定 · 纠错" : "世界裁定 · 请求模型");
    const onEndpointTiming = (sample: EndpointLockTiming) => {
      if (ended || this.closed) return;
      queueMs = Math.max(0, sample.queueMs);
      if (sample.phase === "started") runStarted = performance.now();
      if (sample.runMs !== undefined) runMs = Math.max(0, sample.runMs);
      this.update(attempt ? "世界裁定 · 纠错生成" : "世界裁定 · 生成");
    };
    const finish = (outputChars = 0) => {
      if (ended) return; ended = true;
      // Injected inference implementations need no lock instrumentation. Cancellation
      // can settle before the endpoint worker exits; do not mutate a finished trace later.
      const elapsed = performance.now() - started;
      const model = runMs ?? (runStarted === undefined ? Math.max(0, elapsed - queueMs) : performance.now() - runStarted);
      this.endpointQueueMs += queueMs;
      if (attempt) this.repairMs += model; else this.modelMs += model;
      this.outputChars += outputChars;
    };
    return { onEndpointTiming, finish };
  }
  validate(attempt: number) {
    const started = performance.now(); let ended = false;
    this.stage = "validation";
    return () => {
      if (ended) return; ended = true;
      const elapsed = performance.now() - started;
      if (attempt) this.repairMs += elapsed; else this.validationMs += elapsed;
    };
  }
  droppedSuggestions(count: number) { this.discardedSuggestions += count; }
  refreshedExecution() { this.executionRefreshes++; }
  async save<T>(fn: () => Promise<T>): Promise<T> {
    const started = performance.now(); this.stage = "save"; this.update("世界裁定 · 保存");
    try { return await fn(); } finally { this.saveMs += performance.now() - started; }
  }
  finish(status: "completed" | "failed" | "cancelled") {
    if (this.closed) return;
    this.stage = status;
    this.update(status === "completed" ? "世界裁定 · 耗时" : status === "cancelled" ? "世界裁定 · 已取消" : "世界裁定 · 失败耗时");
    this.closed = true;
  }
}
