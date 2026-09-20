/** One owner for start/init/reset/restore, shared by every command and HTTP route. */
export class WorldLifecycle {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private active?: AbortController;
  private pending = 0;
  private name = "";

  constructor(private cancelWork: () => void) {}

  run<T>(name: string, operation: (signal: AbortSignal) => Promise<T>, interrupt = false): Promise<T> {
    if (this.pending && !interrupt) return Promise.reject(new Error(`世界正在${this.name}，请等待完成；暂停或重置可取消当前操作。`));
    if (interrupt) {
      this.generation++;
      this.active?.abort(new Error(`世界操作已被「${name}」取消。`));
      this.cancelWork();
    }
    const generation = this.generation;
    this.name = name;
    this.pending++;
    const run = this.tail.catch(() => {}).then(async () => {
      if (generation !== this.generation) throw new Error("世界操作已被后续操作取消。");
      const controller = new AbortController();
      this.active = controller;
      try { return await operation(controller.signal); }
      finally { if (this.active === controller) this.active = undefined; }
    });
    this.tail = run.finally(() => { this.pending--; });
    // A rejected operation still releases the next transition/read barrier.
    void this.tail.catch(() => {});
    return run;
  }

  /** Opening a saved world can repair its journal/mirrors, so inspection also holds the IO barrier. */
  read<T>(operation: () => Promise<T>): Promise<T> {
    const read = this.tail.catch(() => {}).then(operation);
    this.tail = read;
    void read.catch(() => {});
    return read;
  }
}
