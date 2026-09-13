import { AsyncLocalStorage } from "node:async_hooks";

/** Identify the actual sending call, rather than consuming a channel-wide FIFO that can
 * mistake a concurrent plugin reply for our own message. */
export class OwnSendTracker {
  private scope = new AsyncLocalStorage<{ key: string; claimed: boolean }>();
  private pending = new Map<string, Set<Promise<unknown>>>();
  private confirmed = new Set<string>();

  run<T>(key: string, send: () => Promise<T>): Promise<T> {
    const task = this.scope.run({ key, claimed: false }, async () => {
      const result = await send();
      const ids = Array.isArray(result) ? result : [(result as any)?.message_id ?? (result as any)?.messageId];
      for (const value of ids) {
        const id = typeof value === "object" ? value?.id : value;
        if (id == null || id === "") continue;
        this.confirmed.add(`${key}\0${String(id)}`);
      }
      while (this.confirmed.size > 4096) this.confirmed.delete(this.confirmed.values().next().value!);
      return result;
    });
    const pending = this.pending.get(key) ?? new Set();
    pending.add(task); this.pending.set(key, pending);
    void task.finally(() => {
      pending.delete(task); if (!pending.size) this.pending.delete(key);
    }).catch(() => {});
    return task;
  }

  async waitForPending(key: string): Promise<void> {
    await Promise.allSettled([...(this.pending.get(key) ?? [])]);
  }

  wasSent(key: string, messageId: string): boolean { return this.confirmed.has(`${key}\0${messageId}`); }

  isOwn(key: string): boolean {
    const scope = this.scope.getStore();
    return scope?.key === key && !scope.claimed;
  }

  claim(key: string): boolean {
    const scope = this.scope.getStore();
    if (!scope || scope.key !== key || scope.claimed) return false;
    scope.claimed = true;
    return true;
  }
}
