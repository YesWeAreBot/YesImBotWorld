/** One active request per endpoint origin; maintenance yields between requests. */
export interface EndpointLockTiming {
  phase: "started" | "finished";
  queuedAt: number;
  startedAt: number;
  finishedAt?: number;
  queueMs: number;
  runMs?: number;
}

export interface EndpointLockOptions {
  /** Existing callers are interactive; maintenance opts into the background lane. */
  priority?: "interactive" | "background";
  onTiming?: (sample: EndpointLockTiming) => void;
}

interface Job {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  options: EndpointLockOptions;
  queuedAt: number;
  queuedMono: number;
  started: boolean;
  cancelled: boolean;
  detach: () => void;
}
interface Lane {
  key: string;
  active: boolean;
  scheduled: boolean;
  interactive: Job[];
  background: Job[];
  interactiveStreak: number;
}

const lanes = new Map<string, Lane>();
const INTERACTIVE_BURST = 3;
let lockEnabled = true;

/** Disabling serialization affects new calls; already queued calls retain their order. */
export function setEndpointLockEnabled(on: boolean): void { lockEnabled = on; }

function originKey(baseURL: string): string {
  try { return new URL(baseURL).origin; } catch { return baseURL; }
}
function abortError(): DOMException { return new DOMException("This operation was aborted", "AbortError"); }
function timing(job: Job, sample: EndpointLockTiming): void {
  try { job.options.onTiming?.(sample); } catch { /* Diagnostics cannot fail or retain the endpoint. */ }
}
function removeIdleLane(lane: Lane): void {
  if (!lane.active && !lane.interactive.length && !lane.background.length && lanes.get(lane.key) === lane) lanes.delete(lane.key);
}
function schedule(lane: Lane): void {
  if (lane.active || lane.scheduled) return;
  lane.scheduled = true;
  queueMicrotask(() => {
    lane.scheduled = false;
    if (lane.active) return;
    // Same-priority FIFO. While both lanes have work, at most three real-time
    // requests may overtake the oldest background request before it gets a turn.
    const background = lane.background.length && (!lane.interactive.length || lane.interactiveStreak >= INTERACTIVE_BURST);
    const job = (background ? lane.background : lane.interactive).shift();
    if (!job) { removeIdleLane(lane); return; }
    lane.interactiveStreak = background || !lane.background.length ? 0 : lane.interactiveStreak + 1;
    lane.active = true;
    void execute(job).finally(() => { lane.active = false; removeIdleLane(lane); schedule(lane); });
  });
}
async function execute(job: Job): Promise<void> {
  if (job.cancelled || job.signal?.aborted) { job.detach(); job.reject(abortError()); return; }
  job.started = true;
  const startedAt = Date.now(), startedMono = performance.now();
  const sample: EndpointLockTiming = { phase: "started", queuedAt: job.queuedAt, startedAt, queueMs: Math.max(0, startedMono - job.queuedMono) };
  timing(job, sample);
  try {
    // An observer may synchronously stop the owning task when generation starts.
    if (job.signal?.aborted) throw abortError();
    job.resolve(await job.run());
  } catch (error) { job.reject(error); }
  finally {
    job.detach();
    timing(job, { ...sample, phase: "finished", finishedAt: Date.now(), runMs: Math.max(0, performance.now() - startedMono) });
  }
}

/**
 * Serialize one request. Abort rejects the caller promptly and removes queued work;
 * an already-running fn keeps the lane until it settles, even if it ignores abort.
 * Different origins stay independent. Never wrap a multi-request maintenance loop
 * around this function: acquire separately at each model request instead.
 */
export function withEndpointLock<T>(baseURL: string, fn: () => Promise<T>, signal?: AbortSignal, options: EndpointLockOptions = {}): Promise<T> {
  if (signal?.aborted) {
    const at = Date.now();
    try { options.onTiming?.({ phase: "finished", queuedAt: at, startedAt: at, finishedAt: at, queueMs: 0, runMs: 0 }); }
    catch { /* Diagnostics cannot replace cancellation. */ }
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let lane: Lane | undefined;
    const job: Job = { run: fn, resolve: value => resolve(value as T), reject, signal, options,
      queuedAt: Date.now(), queuedMono: performance.now(), started: false, cancelled: false, detach: () => {} };
    const abort = () => {
      job.cancelled = true; reject(abortError());
      if (!job.started) {
        const finishedAt = Date.now();
        timing(job, { phase: "finished", queuedAt: job.queuedAt, startedAt: finishedAt, finishedAt,
          queueMs: Math.max(0, performance.now() - job.queuedMono), runMs: 0 });
        job.detach();
        if (lane) {
          for (const queue of [lane.interactive, lane.background]) {
            const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
          }
          removeIdleLane(lane);
        }
      }
    };
    job.detach = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    if (!lockEnabled) { void execute(job); return; }
    const key = originKey(baseURL);
    lane = lanes.get(key);
    if (!lane) { lane = { key, active: false, scheduled: false, interactive: [], background: [], interactiveStreak: 0 }; lanes.set(key, lane); }
    (options.priority === "background" ? lane.background : lane.interactive).push(job);
    schedule(lane);
  });
}
