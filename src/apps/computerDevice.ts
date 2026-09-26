/**
 * Bot 的个人电脑：与手机平级的另一台设备（不是手机里的一个 App）。
 *
 * 实现方式由用户在下拉框选择（apps.computer.mode），docker 与 remote_desktop 是平级的两种实现：
 * - docker：电脑是一个 Docker 容器，打开后展开终端（run_command）与资源管理器的文件操作；
 * - remote_desktop：电脑连上一台 VNC 远程桌面，打开后展开 screen / mouse / keyboard；
 * - off：真实世界里没有这台电脑。
 *
 * 仅在世界类型为「现实世界」时以选定的实现生效；虚构世界里由 World-LLM 扮演这台电脑。
 * 与手机平级：用 open_computer / close_computer 开关，开电脑不影响手机里开着的应用，反之亦然。
 */

import type { Logger } from "koishi";
import type { BotComputer } from "../computer.js";
import type { WorldClock } from "../clock.js";
import type { ComputerConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import type { RichText } from "../types.js";
import { renderSignature, type AppToolDef, type WorldApp } from "./app.js";
import type { FileManagerApp } from "./files.js";
import type { RemoteDesktopApp } from "./remoteDesktop.js";
import type { TerminalApp } from "./terminal.js";
import { LearnedToolCatalog } from "./tool-catalog.js";

export interface ComputerOpenResult {
  /** 打开电脑的拟人化开场 */
  opening: string;
  /** 展开的工具定义（打开期间可用） */
  defs: AppToolDef[];
}

interface ActiveComputer {
  apps: WorldApp[];
  toolMap: Map<string, { app: WorldApp; tool: string }>;
  defs: AppToolDef[];
  lastTool?: string;
  result?: string | RichText;
}

export class ComputerDevice {
  private active: ActiveComputer | null = null;
  private readonly learnedTools: LearnedToolCatalog;

  constructor(
    private terminal: TerminalApp,
    private filesApp: FileManagerApp | null,
    private remote: RemoteDesktopApp | null,
    private computer: BotComputer,
    private files: WorldFiles,
    private clock: WorldClock,
    private cfg: ComputerConfig,
    /** 常驻工具名（电脑工具与之同名时加前缀消歧） */
    private reserved: Set<string>,
    private logger: Logger,
    private otherToolNames: () => string[] = () => [],
    private realWorld: boolean = clock.syncRealTime,
    catalogFile?: string,
  ) {
    this.learnedTools = new LearnedToolCatalog(catalogFile, error => this.logger.warn("电脑已学工具目录保存/读取失败：%s", error));
  }

  loadToolCatalog(): Promise<void> { return this.learnedTools.load(); }

  /** Learning follows actual attention, independently of who opened the physical device. */
  async learnCurrentTools(): Promise<void> {
    const active = this.active;
    if (!active) return;
    for (const app of active.apps) {
      if (app.connected === false) continue;
      await this.learnedTools.remember(this.catalogOwner(app), active.defs.filter(def => active.toolMap.get(def.name)?.app === app));
    }
  }

  /** A past tool is a navigation candidate only; callers must reopen and verify hasTool. */
  knownToolDefs(): AppToolDef[] {
    if (!this.available) return [];
    const apps = this.realWorld && this.cfg.mode === "remote_desktop" ? [this.remote!]
      : [this.terminal, this.filesApp].filter((app): app is TerminalApp | FileManagerApp => !!app);
    return this.learnedTools.known(apps.map(app => this.catalogOwner(app)), [...this.reserved, "observe", ...this.otherToolNames()]).map(entry => entry.def);
  }

  private catalogOwner(app: WorldApp): string { return `${this.realWorld ? this.cfg.mode : "virtual"}:${app.id}`; }

  /** Configured capability, without starting a container or connecting to the desktop. */
  get available(): boolean {
    return !this.realWorld || (this.cfg.mode !== "off" && (this.cfg.mode !== "remote_desktop" || !!this.remote));
  }

  /** 电脑是否已开机 */
  get isOpen(): boolean {
    return this.active !== null;
  }

  /** 开机状态名称（供状态展示） */
  get currentName(): string | null {
    return this.active ? "电脑" : null;
  }

  /** 打开电脑：按世界性质与实现方式选择可用的工具并展开 */
  async open(opts: { learn?: boolean } = {}): Promise<ComputerOpenResult | { error: string }> {
    await this.close();
    const real = await this.isRealWorld();
    if (!real) {
      // 虚构世界：World-LLM 扮演这台电脑（终端 + 资源管理器）
      return this.openAs([this.terminal, this.filesApp].filter(Boolean) as WorldApp[], opts.learn !== false);
    }
    switch (this.cfg.mode) {
      case "off":
        return { error: "这台电脑没有配置实现方式（apps.computer.mode 为 off），开不了机。" };
      case "docker": {
        const ready = await this.computer.ensureReady();
        if (!ready.ok) return { error: ready.error ?? "电脑没有开机。" };
        return this.openAs([this.terminal, this.filesApp].filter(Boolean) as WorldApp[], opts.learn !== false);
      }
      case "remote_desktop": {
        if (!this.remote) return { error: "当前无法查看远程桌面的画面，暂时不能使用这台电脑。" };
        return this.openAs([this.remote], opts.learn !== false);
      }
    }
  }

  /** 关闭电脑（断开连接 / 释放资源），其工具随之失效 */
  async close(): Promise<void> {
    if (!this.active) return;
    const { apps } = this.active;
    this.active = null;
    for (const app of apps) {
      await app.close().catch((err) => this.logger.warn("关闭电脑组件「%s」失败: %s", app.name, err));
    }
  }

  /** 当前展开的电脑工具名（供动态加入允许列表 / GBNF 语法） */
  activeToolNames(): string[] {
    return this.active ? [...this.active.toolMap].filter(([, entry]) => entry.app.connected !== false).map(([name]) => name) : [];
  }

  /** 当前展开的电脑工具完整定义（供原生 tools 声明） */
  activeToolDefs(): AppToolDef[] {
    return this.active?.defs.filter(def => this.active?.toolMap.get(def.name)?.app.connected !== false) ?? [];
  }

  view(): { lastTool?: string; result?: string | RichText } | null {
    return this.active ? structuredClone({ lastTool: this.active.lastTool, result: this.active.result }) : null;
  }

  hasTool(name: string): boolean {
    const entry = this.active?.toolMap.get(name);
    return !!entry && entry.app.connected !== false;
  }

  /** 调用电脑的一个工具 */
  async call(exposed: string, args: Record<string, unknown>): Promise<string | RichText> {
    if (!this.active) throw new Error("当前没有打开电脑");
    const entry = this.active.toolMap.get(exposed);
    if (!entry) throw new Error(`电脑没有 ${exposed} 这个操作`);
    if (entry.app.connected === false) throw new Error("电脑组件连接已断开，请重新打开电脑会话后查看可用操作");
    const active = this.active;
    const result = await entry.app.call(entry.tool, args);
    if (this.active === active) { active.lastTool = exposed; active.result = result; }
    return result;
  }

  // ---------- 内部 ----------

  private async isRealWorld(): Promise<boolean> {
    const meta = await this.files.readMeta();
    return this.realWorld = meta.realWorld ?? this.clock.syncRealTime;
  }

  /** 打开一组电脑组件（终端/资源管理器，或远程桌面），收集并展开它们的工具 */
  private async openAs(apps: WorldApp[], learn: boolean): Promise<ComputerOpenResult> {
    const toolMap = new Map<string, { app: WorldApp; tool: string }>();
    const defs: AppToolDef[] = [];
    const openings: string[] = [];
    for (const app of apps) {
      const { tools, opening } = await app.open();
      if (opening) openings.push(typeof opening === "string" ? opening : opening.text);
      for (const t of tools) {
        let exposed = t.name;
        // Keep app homonyms distinct from the retired tool in frozen historical declarations.
        const occupied = new Set([...this.reserved, "observe", ...this.otherToolNames(), ...toolMap.keys()]);
        if (occupied.has(exposed)) exposed = `${app.id}.${t.name}`;
        if (occupied.has(exposed)) continue;
        toolMap.set(exposed, { app, tool: t.name });
        defs.push({
          name: exposed,
          signature: renderSignature(exposed, t.inputSchema),
          description: t.description || "（无说明）",
          ...(t.inputSchema ? { inputSchema: structuredClone(t.inputSchema) } : {}),
        });
      }
    }
    this.active = { apps, toolMap, defs };
    if (learn) await this.learnCurrentTools();
    const head =
      apps.length > 1
        ? `电脑会话已打开：${apps.map((a) => a.name).join("、")}。\n${openings.join("\n")}`
        : (openings[0] ?? `你打开了自己的电脑（${apps[0]?.name ?? "无"}）。`);
    this.logger.info("打开电脑：%d 个工具（%s）", defs.length, defs.map((d) => d.name).join(", "));
    return { opening: head, defs };
  }
}
