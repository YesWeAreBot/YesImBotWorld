import type { Logger } from "koishi";
import type { RichText } from "../types.js";
import { renderSignature, type AppToolDef, type WorldApp } from "./app.js";

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
  private current: { app: WorldApp; toolMap: Map<string, string>; defs: AppToolDef[]; opening?: string; lastTool?: string; result?: string | RichText } | null = null;

  constructor(
    private chatName: string,
    private apps: WorldApp[],
    /** 常驻工具名（冲突时 App 工具加前缀） */
    private reserved: Set<string>,
    private logger: Logger,
    private otherToolNames: () => string[] = () => [],
  ) {}

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
  async open(app: WorldApp): Promise<{ closed: string | null; opening?: string; defs: AppToolDef[] }> {
    const closed = await this.closeCurrent();
    const { tools, opening } = await app.open();
    const toolMap = new Map<string, string>();
    const defs: AppToolDef[] = [];
    for (const t of tools) {
      let exposed = t.name;
      const occupied = new Set([...this.reserved, ...this.otherToolNames(), ...toolMap.keys()]);
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
    this.logger.info("打开应用「%s」：%d 个工具（%s）", app.name, defs.length, defs.map((d) => d.name).join(", "));
    return { closed, opening, defs };
  }

  /** 关闭当前打开的 App，返回其名字（没有打开的返回 null） */
  async closeCurrent(): Promise<string | null> {
    if (!this.current) return null;
    const { app } = this.current;
    this.current = null;
    await app.close().catch((err) => this.logger.warn("关闭应用「%s」失败: %s", app.name, err));
    return app.name;
  }

  /** 关闭一切（世界停止时）：当前 App 与所有可能残留的连接 */
  async closeAll(): Promise<void> {
    await this.closeCurrent();
    for (const app of this.apps) {
      await app.close().catch(() => {});
    }
  }

  /** 当前打开的 App 名 */
  get currentName(): string | null {
    return this.current?.app.name ?? null;
  }

  view(): { id: string; name: string; opening?: string; lastTool?: string; result?: string | RichText } | null {
    const current = this.current;
    return current ? structuredClone({ id: current.app.id, name: current.app.name, opening: current.opening, lastTool: current.lastTool, result: current.result }) : null;
  }

  /** 当前展开的工具名（供动态加入允许列表/GBNF 语法） */
  activeToolNames(): string[] {
    return this.current ? [...this.current.toolMap.keys()] : [];
  }

  /** 当前展开的工具定义（用于打开时的用法说明） */
  activeToolDefs(): AppToolDef[] {
    return this.current?.defs ?? [];
  }

  hasTool(name: string): boolean {
    return this.current?.toolMap.has(name) ?? false;
  }

  /** 调用当前 App 的一个工具 */
  async call(exposedName: string, args: Record<string, unknown>): Promise<string | RichText> {
    if (!this.current) throw new Error("当前没有打开的应用");
    const real = this.current.toolMap.get(exposedName);
    if (!real) throw new Error(`当前应用没有 ${exposedName} 这个操作`);
    const current = this.current;
    const result = await current.app.call(real, args);
    if (this.current === current) { current.lastTool = exposedName; current.result = result; }
    return result;
  }
}
