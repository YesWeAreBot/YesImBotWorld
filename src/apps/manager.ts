import type { Logger } from "koishi";
import type { RichText } from "../types.js";
import { renderSignature, type AppRawTool, type AppToolDef, type WorldApp } from "./app.js";
import { LearnedToolCatalog } from "./tool-catalog.js";

/** open_app 的解析结果：聊天平台（常驻能力，打开 = 看消息）或一个可展开的 App */
export type ResolvedApp = { kind: "chat" } | { kind: "app"; app: WorldApp } | null;

const CHAT_ALIASES = ["聊天", "chat", "koishi", "qq", "消息", "messages"];

/**
 * App 管理器：手机里的应用一次只能打开一个。
 *
 * - open() 打开一个 App：关闭上一个、连接并列出工具，工具名与常驻工具冲突时加 "appId." 前缀；
 * - 打开期间其工具进入 Bot 的允许列表（由 agent 同步到后端语法）；
 * - 切换 App / close / rest / 世界停止时关闭并失效。
 */
export class AppManager {
  private current: { app: WorldApp; toolMap: Map<string, string>; defs: AppToolDef[]; opening?: string | RichText; lastTool?: string; result?: string | RichText } | null = null;
  private generation = 0;
  private disposed = false;
  private foregroundTail: Promise<void> = Promise.resolve();
  private openingApp: WorldApp | null = null;
  private calls = new Set<Promise<unknown>>();
  private closingAll: Promise<void> | null = null;
  private cleanupFailures: unknown[] = [];
  private readonly learnedTools: LearnedToolCatalog;

  constructor(
    private chatName: string,
    private apps: WorldApp[],
    /** 常驻工具名（冲突时 App 工具加前缀） */
    private reserved: Set<string>,
    private logger: Logger,
    private otherToolNames: () => string[] = () => [],
    catalogFile?: string,
  ) {
    this.learnedTools = new LearnedToolCatalog(catalogFile, error => this.logger.warn("手机已学工具目录保存/读取失败：%s", error));
  }

  /** Read saved navigation knowledge without opening/probing installed applications. */
  loadToolCatalog(): Promise<void> { return this.learnedTools.load(); }

  /** Call after the character actually sees an already-open app; hidden operators learn nothing for them. */
  async learnCurrentTools(): Promise<void> {
    const current = this.current;
    if (this.disposed || !current || current.app.connected === false) return;
    await this.learnedTools.remember(current.app.id, current.defs);
  }

  knownToolDefs(): AppToolDef[] {
    if (this.disposed) return [];
    return this.learnedTools.known(this.apps.map(app => app.id), [...this.reserved, "observe", ...this.otherToolNames()]).map(entry => entry.def);
  }

  toolOwner(name: string): { id: string; name: string } | null {
    if (this.disposed) return null;
    const entry = this.learnedTools.known(this.apps.map(app => app.id), [...this.reserved, "observe", ...this.otherToolNames()]).find(entry => entry.def.name === name);
    const app = entry && this.apps.find(app => app.id === entry.owner);
    return app ? { id: app.id, name: app.name } : null;
  }

  /** 按名字（或 id）找 App；聊天平台的常用别名也能匹配 */
  resolve(name: string): ResolvedApp {
    const q = name.trim().toLowerCase();
    if (!q) return null;
    if (q === this.chatName.toLowerCase() || CHAT_ALIASES.includes(q)) return { kind: "chat" };
    const app = this.apps.find((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q);
    return app ? { kind: "app", app } : null;
  }

  /** 已安装应用的展示列表（聊天平台在前） */
  installedText(): string {
    const names = [this.chatName, ...this.apps.map((a) => a.name)];
    return names.join("、");
  }

  /** 只读取注册信息，不打开 App、不建立 MCP 连接。 */
  installedApps(): { id: string; name: string; description: string; kind: "chat" | "app"; active: boolean }[] {
    return [{ id: "chat", name: this.chatName, description: "聊天与消息", kind: "chat", active: false },
      ...this.apps.map(app => ({ id: app.id, name: app.name, description: app.description, kind: "app" as const, active: this.current?.app === app }))];
  }

  /** 打开一个 App：关闭上一个，连接并展开工具。返回关闭的 App 名、拟人化开场与暴露的工具定义 */
  open(app: WorldApp, opts: { learn?: boolean } = {}): Promise<{ closed: string | null; opening?: string | RichText; defs: AppToolDef[] }> {
    if (this.disposed) return Promise.reject(new Error("应用管理器已停止，不能打开旧世界的应用。"));
    const generation = ++this.generation;
    return this.foreground(async () => {
      this.assertOpening(generation);
      const previous = this.current;
      this.current = null;
      if (previous) await previous.app.close();
      this.assertOpening(generation);
      this.openingApp = app;
      try {
        const { tools, opening } = await app.open();
        this.assertOpening(generation);
        const accepted = await this.acceptOpen(app, tools, opening, previous?.app.name ?? null, opts.learn !== false);
        this.assertOpening(generation);
        return accepted;
      } catch (error) {
        // Even an app whose first dispose returned before open finished may have
        // created a late connection. Close it again before the next foreground
        // operation runs; a world teardown additionally releases its background.
        try {
          await app.close();
          if (this.disposed) await app.dispose?.();
        } catch (cleanupError) {
          if (this.disposed) this.cleanupFailures.push(cleanupError);
          throw new AggregateError([error, cleanupError], `打开应用「${app.name}」未完成，且释放迟到资源失败`);
        }
        throw error;
      } finally { if (this.openingApp === app) this.openingApp = null; }
    });
  }

  private async acceptOpen(app: WorldApp, tools: AppRawTool[], opening: string | RichText | undefined, closed: string | null, learn: boolean): Promise<{ closed: string | null; opening?: string | RichText; defs: AppToolDef[] }> {
    const toolMap = new Map<string, string>();
    const defs: AppToolDef[] = [];
    for (const t of tools) {
      let exposed = t.name;
      // Retired world `observe` can remain in a frozen historical tool declaration.
      // Namespace an application's homonym so its current capability is unambiguous.
      const occupied = new Set([...this.reserved, "observe", ...this.otherToolNames(), ...toolMap.keys()]);
      if (occupied.has(exposed)) exposed = `${app.id}.${t.name}`;
      if (occupied.has(exposed)) continue; // 仍冲突（重复工具名），丢弃
      toolMap.set(exposed, t.name);
      defs.push({
        name: exposed,
        signature: renderSignature(exposed, t.inputSchema),
        description: t.description || "（无说明）",
        ...(t.inputSchema ? { inputSchema: structuredClone(t.inputSchema) } : {}),
      });
    }
    this.current = { app, toolMap, defs, opening };
    if (learn) await this.learnCurrentTools();
    this.logger.info("打开应用「%s」：%d 个工具（%s）", app.name, defs.length, defs.map((d) => d.name).join(", "));
    return { closed, opening, defs };
  }

  /** 关闭当前打开的 App，返回其名字（没有打开的返回 null） */
  closeCurrent(): Promise<string | null> {
    if (this.disposed) return (this.closingAll ?? Promise.resolve()).then(() => null);
    ++this.generation;
    const previous = this.current;
    this.current = null;
    const apps = new Set([previous?.app, this.openingApp].filter((app): app is WorldApp => !!app));
    // Start closing now so a pending network open can be interrupted. The queue
    // then joins its late cleanup before another app is allowed to open.
    const closing = Promise.allSettled([...apps].map(app => Promise.resolve().then(() => app.close())));
    return this.foreground(async () => {
      const failures = (await closing).filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
      if (failures.length) {
        if (this.disposed) this.cleanupFailures.push(...failures);
        throw new AggregateError(failures, "关闭应用失败，资源可能尚未完全释放");
      }
      return previous?.app.name ?? null;
    });
  }

  /** 关闭一切（世界停止时）：当前 App 与所有可能残留的连接 */
  closeAll(): Promise<void> {
    if (this.closingAll) return this.closingAll;
    this.disposed = true;
    ++this.generation;
    const apps = new Set([...this.apps, ...[this.current?.app, this.openingApp].filter((app): app is WorldApp => !!app)]);
    this.current = null;
    this.closingAll = (async () => {
      // Interrupt every device before waiting. A slow open must not prevent a
      // second application's pending read from receiving its disposal signal.
      const releasing = Promise.allSettled([...apps].map(app => Promise.resolve().then(() => app.dispose ? app.dispose() : app.close())));
      const [released] = await Promise.all([releasing, this.foregroundTail, Promise.allSettled([...this.calls])]);
      const failures = [...this.cleanupFailures, ...released.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason)];
      if (failures.length) throw new AggregateError(failures, "部分应用未能完全释放");
    })();
    return this.closingAll;
  }

  private assertOpening(generation: number): void {
    if (this.disposed || generation !== this.generation) throw new Error("应用的打开操作已取消，设备界面已经改变。");
  }

  private foreground<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.foregroundTail.then(operation);
    this.foregroundTail = task.then(() => {}, () => {});
    return task;
  }

  /** 当前打开的 App 名 */
  get currentName(): string | null {
    return this.current?.app.name ?? null;
  }

  view(): { id: string; name: string; opening?: string | RichText; lastTool?: string; result?: string | RichText; state?: unknown } | null {
    const current = this.current;
    return current ? structuredClone({ id: current.app.id, name: current.app.name, opening: current.opening, lastTool: current.lastTool, result: current.result, state: current.app.viewState?.() }) : null;
  }

  /** A read of the visible app, including asynchronous content already on its screen. */
  screen(): RichText | null {
    if (this.current?.app.peekScreen) return this.current.app.peekScreen();
    const view = this.view();
    if (!view) return null;
    const state = view.state as { jobs?: { id: string; question?: string; reply?: string; subject?: string; status: string; error?: string; galleryRef?: string }[]; timeLine?: string; reminders?: { label: string; status: string; timeLine?: string }[]; stopwatch?: { elapsedSeconds: number; running: boolean; laps: number[] } } | undefined;
    if (view.id === "assistant" && state?.jobs) {
      const job = state.jobs.at(-1);
      return { text: job ? `问答应用「${view.name}」当前对话（外部建议，不是世界事实）：\n问题：${job.question}\n状态：${job.status}\n回答：${job.reply || "尚未返回正文"}${job.error ? `\n错误：${job.error}` : ""}` : `「${view.name}」当前没有对话。`, originEventIds: [] };
    }
    if (view.id === "clock" && state?.timeLine) return { text: state.timeLine + "\n" + (state.reminders ?? []).slice(-20).map(reminder => `${reminder.label}：${reminder.status} ${reminder.timeLine ?? ""}`).join("\n") +
      (state.stopwatch ? `\n秒表：${state.stopwatch.running ? "计时中" : "已暂停"}，累计 ${state.stopwatch.elapsedSeconds.toFixed(2)} 世界秒；圈时 ${state.stopwatch.laps.join("、") || "无"}` : ""), originEventIds: [] };
    if (view.id === "camera" && state?.jobs) {
      if (view.lastTool?.split(".").at(-1) === "read_photo" && view.result && typeof view.result !== "string") return view.result;
      const job = state.jobs.at(-1);
      return { text: job ? `相机：${job.subject}；状态 ${job.status}。${job.error ?? ""}${job.galleryRef ? `\n照片已保存：${job.galleryRef}；可用 read_photo 查看。` : ""}` : "相机已打开，尚未拍摄。", originEventIds: [] };
    }
    const content = view.result ?? view.opening;
    return typeof content === "string" ? { text: content } : content ?? null;
  }

  /** 当前展开的工具名（供动态加入允许列表/GBNF 语法） */
  activeToolNames(): string[] {
    return this.current && this.current.app.connected !== false ? [...this.current.toolMap.keys()] : [];
  }

  /** 当前展开的工具定义（用于打开时的用法说明） */
  activeToolDefs(): AppToolDef[] {
    return this.current && this.current.app.connected !== false ? this.current.defs : [];
  }

  hasTool(name: string): boolean {
    return this.current?.app.connected !== false && (this.current?.toolMap.has(name) ?? false);
  }

  /** 调用当前 App 的一个工具 */
  async call(exposedName: string, args: Record<string, unknown>, context?: { operator?: boolean }): Promise<string | RichText> {
    if (this.disposed) throw new Error("应用管理器已停止，不能调用旧世界的应用。");
    if (!this.current) throw new Error("当前没有打开的应用");
    if (this.current.app.connected === false) throw new Error("当前应用的连接已断开，请重新打开应用后查看可用操作");
    const real = this.current.toolMap.get(exposedName);
    if (!real) throw new Error(`当前应用没有 ${exposedName} 这个操作`);
    const current = this.current;
    const task = Promise.resolve().then(() => {
      if (this.disposed || this.current !== current) throw new Error("应用界面已关闭或改变，此操作没有执行。");
      return current.app.call(real, args, context);
    });
    this.calls.add(task);
    try {
      const result = await task;
      if (!this.disposed && this.current === current) { current.lastTool = exposedName; current.result = result; }
      return result;
    } finally { this.calls.delete(task); }
  }
}
