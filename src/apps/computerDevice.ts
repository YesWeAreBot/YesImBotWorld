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
}

export class ComputerDevice {
  private active: ActiveComputer | null = null;

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
  ) {}

  /** 电脑是否已开机 */
  get isOpen(): boolean {
    return this.active !== null;
  }

  /** 开机状态名称（供状态展示） */
  get currentName(): string | null {
    return this.active ? "电脑" : null;
  }

  /** 打开电脑：按世界性质与实现方式选择可用的工具并展开 */
  async open(): Promise<ComputerOpenResult | { error: string }> {
    await this.close();
    const real = await this.isRealWorld();
    if (!real) {
      // 虚构世界：World-LLM 扮演这台电脑（终端 + 资源管理器）
      return this.openAs([this.terminal, this.filesApp].filter(Boolean) as WorldApp[]);
    }
    switch (this.cfg.mode) {
      case "off":
        return { error: "这台电脑没有配置实现方式（apps.computer.mode 为 off），开不了机。" };
      case "docker": {
        const ready = await this.computer.ensureReady();
        if (!ready.ok) return { error: ready.error ?? "电脑没有开机。" };
        return this.openAs([this.terminal, this.filesApp].filter(Boolean) as WorldApp[]);
      }
      case "remote_desktop": {
        if (!this.remote) return { error: "远程桌面模式需要 Bot-LLM 开启图片多模态（bot.modalities.image）。" };
        return this.openAs([this.remote]);
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
    return this.active ? [...this.active.toolMap.keys()] : [];
  }

  hasTool(name: string): boolean {
    return this.active?.toolMap.has(name) ?? false;
  }

  /** 调用电脑的一个工具 */
  async call(exposed: string, args: Record<string, unknown>): Promise<string | RichText> {
    if (!this.active) throw new Error("当前没有打开电脑");
    const entry = this.active.toolMap.get(exposed);
    if (!entry) throw new Error(`电脑没有 ${exposed} 这个操作`);
    return entry.app.call(entry.tool, args);
  }

  // ---------- 内部 ----------

  private async isRealWorld(): Promise<boolean> {
    const meta = await this.files.readMeta();
    return meta.realWorld ?? this.clock.syncRealTime;
  }

  /** 打开一组电脑组件（终端/资源管理器，或远程桌面），收集并展开它们的工具 */
  private async openAs(apps: WorldApp[]): Promise<ComputerOpenResult> {
    const toolMap = new Map<string, { app: WorldApp; tool: string }>();
    const defs: AppToolDef[] = [];
    const openings: string[] = [];
    for (const app of apps) {
      const { tools, opening } = await app.open();
      if (opening) openings.push(opening);
      for (const t of tools) {
        let exposed = t.name;
        if (this.reserved.has(exposed) || toolMap.has(exposed)) exposed = `${app.id}.${t.name}`;
        if (toolMap.has(exposed)) continue;
        toolMap.set(exposed, { app, tool: t.name });
        defs.push({
          name: exposed,
          signature: renderSignature(exposed, t.inputSchema),
          description: t.description || "（无说明）",
        });
      }
    }
    this.active = { apps, toolMap, defs };
    const head =
      apps.length > 1
        ? `你走到桌前，打开了自己的电脑——${apps.map((a) => a.name).join("和")}都亮了起来，等着你操作。`
        : (openings[0] ?? `你打开了自己的电脑（${apps[0]?.name ?? "无"}）。`);
    this.logger.info("打开电脑：%d 个工具（%s）", defs.length, defs.map((d) => d.name).join(", "));
    return { opening: head, defs };
  }
}
