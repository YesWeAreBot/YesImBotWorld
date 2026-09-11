/**
 * 内置终端：Bot 的个人电脑（与手机平级的设备）上的命令行窗口。
 *
 * 双模式（创世时判定的世界性质，meta.json）：
 * - 现实世界：命令真正执行在 Docker 容器里（Bot 的个人电脑，mode=docker），与主机隔离；
 * - 虚构世界：World-LLM 扮演"这台电脑"，直接生成符合世界观的终端画面与输出。
 *
 * 打开电脑（open_computer）才会坐到电脑前，之后才能敲命令；关闭电脑后屏幕熄掉，下次打开重新坐下。
 */

import type { Logger } from "koishi";
import type { BotComputer } from "../computer.js";
import type { WorldClock } from "../clock.js";
import type { AppsConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import type { WorldAgent } from "../world/agent.js";
import type { AppRawTool, WorldApp } from "./app.js";

const PROMPT_HINT =
  "\n----\n（这是终端里显示的内容。继续操作时请调用 run_command 工具，不要把命令当作正文输出。）";

export class TerminalApp implements WorldApp {
  readonly id = "terminal";
  readonly name = "终端";
  readonly description = "电脑上的命令行窗口，打开后可以执行命令";

  constructor(
    private computer: BotComputer,
    private world: WorldAgent,
    private files: WorldFiles,
    private clock: WorldClock,
    private cfg: AppsConfig,
    private logger: Logger,
  ) {}

  async open(): Promise<{ tools: AppRawTool[]; opening?: string }> {
    const real = await this.isRealWorld();
    if (real) {
      const ready = await this.computer.ensureReady();
      if (ready.ok) {
        return {
          tools: TOOLS,
          opening: `终端会话已打开，默认工作目录为 ${this.computer.homeDir}。`,
        };
      }
      return {
        tools: TOOLS,
        opening: `终端不可用（${ready.error}）。`,
      };
    }
    return {
      tools: TOOLS,
      opening: "虚构终端界面已打开。命令只能通过已建模状态裁定，不会在真实操作系统中运行。",
    };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (tool !== "run_command") throw new Error(`终端没有 ${tool} 这个操作`);
    const command = String(args.command ?? args.cmd ?? "").trim();
    if (!command) return "（终端里还没敲入任何命令。）";
    const cwd = args.cwd != null ? String(args.cwd).trim() : undefined;
    const real = await this.isRealWorld();
    if (real) {
      const res = await this.computer.exec(command, {
        cwd,
        timeoutMs: this.cfg.computer.docker.commandTimeoutMs,
        maxOutputChars: this.cfg.computer.docker.maxOutputChars,
      });
      return `你在终端里敲下了 ${command}，屏幕上显示：\n${res.output}${PROMPT_HINT}`;
    }
    return this.virtualRun(command, cwd);
  }

  async close(): Promise<void> {
    /* 屏幕熄掉，状态保留（下次打开同一台电脑还在） */
  }

  private async isRealWorld(): Promise<boolean> {
    const meta = await this.files.readMeta();
    return meta.realWorld ?? this.clock.syncRealTime;
  }

  /** 虚构世界：World-LLM 扮演这台电脑 */
  private async virtualRun(command: string, cwd?: string): Promise<string> {
    try {
      return (await this.world.executeAppAction("执行虚构电脑命令。只在能根据已建模设备和文件精确结算时执行，否则返回不支持。命令=" + JSON.stringify({ command, cwd: cwd || "." }))) + PROMPT_HINT;
    } catch (err) {
      this.logger.warn("虚构终端输出生成失败: %s", err);
      return "（终端请求失败，未取得结果，不能据此判断是否执行成功。）" + PROMPT_HINT;
    }
  }
}

const TOOLS: AppRawTool[] = [
  {
    name: "run_command",
    description:
      "在当前终端里执行一条命令，返回它在电脑上产生的输出。cwd 可指定相对电脑主目录的工作目录（缺省为电脑主目录；cd 与环境变量不跨调用保留）。" +
      "真实模式执行容器命令；虚构模式仅裁定已建模设备，返回结构化结果或不支持，不保证得到真实终端输出。",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令，如 ls -la" },
        cwd: { type: "string", description: "工作目录，相对电脑主目录；省略为电脑主目录，每次调用独立" },
      },
      required: ["command"],
    },
  },
];
