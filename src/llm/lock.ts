/**
 * 同一推理端点（origin）上的互斥锁。
 *
 * 背景：当 Bot-LLM 与 World-LLM 配置成同一个 baseURL，而该端点是"同一时间只能
 * 驻留一个模型"的路由/换载层（llama-swap、按 model 字段切换的代理等）时，
 * 跨模型的并发请求会导致换载失败：World 的请求被无限排队（饿死），
 * 或换载把共享的推理进程杀死（表现为 other side closed → ECONNREFUSED）。
 *
 * 解法：按 baseURL 的 origin 维护 FIFO 队列——同端点的任务依次独占执行。
 * World-LLM 以"整个任务"（完整工具循环）为粒度持锁，一次任务只引发两次换载；
 * Bot-LLM 以单次生成请求为粒度持锁，在 World 任务之间照常插队推进。
 * 两个 LLM 的 baseURL 不同源时，各用各的队列，行为与从前完全一致。
 */

const tails = new Map<string, Promise<unknown>>();

/** 全局开关（由插件配置 serializeSameEndpoint 控制）：关闭后 withEndpointLock 直接执行、不排队 */
let lockEnabled = true;

export function setEndpointLockEnabled(on: boolean): void {
  lockEnabled = on;
}

function originKey(baseURL: string): string {
  try {
    return new URL(baseURL).origin;
  } catch {
    return baseURL;
  }
}

/**
 * 在 baseURL 对应端点的 FIFO 锁内执行 fn。
 * signal：排队等待期间被 abort 时，轮到自己后不再执行 fn、直接抛 AbortError
 * （锁的让渡仍然有序，不会让后来者与前面的持有者重叠）。
 */
export function withEndpointLock<T>(
  baseURL: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!lockEnabled) return fn();
  const key = originKey(baseURL);
  const tail = tails.get(key) ?? Promise.resolve();
  const run = async (): Promise<T> => {
    if (signal?.aborted) {
      throw new DOMException("This operation was aborted", "AbortError");
    }
    return fn();
  };
  // 前一个持有者无论成败，锁都随之释放
  const next = tail.then(run, run);
  tails.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
