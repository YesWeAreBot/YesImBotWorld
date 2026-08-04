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
          opening: `你走到桌前，打开了自己的电脑，点开终端窗口——屏幕亮起，光标停在 ${this.computer.homeDir} 的提示符前等着你。`,
        };
      }
      return {
        tools: TOOLS,
        opening: `你走到桌前想打开电脑，但电脑没有开机（${ready.error}）。`,
      };
    }
    return {
      tools: TOOLS,
      opening: "你走到桌前，打开了自己的电脑，点开终端窗口——屏幕亮起，光标停在提示符前等着你。",
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
    const task =
      `Bot 打开了自己电脑上的终端，在${cwd ? `目录 ${cwd}` : "主目录"}敲下了命令：${command}\n` +
      `请扮演这台电脑的终端，直接输出它屏幕上显示的结果：\n` +
      `1. check world_status（必要时也看 bot_status）：这台电脑符合世界观（可能是魔法世界的炼金台、星际联邦的终端，` +
      `也可能这个世界根本没有电脑——那就输出对应的画面）；\n` +
      `2. 命令合理且世界观允许时，给出逼真的输出（目录/文件列表、进度、回显等）；不存在的命令、无权限或世界观不允许时，` +
      `如实输出报错或失败；不要凭空编造这个世界不该有的文件或程序；\n` +
      `3. 只输出终端屏幕上的内容（像普通命令行那样简洁），不要输出任何解释、旁白或代码围栏。`;
    try {
      return (await this.world.query(task)) + PROMPT_HINT;
    } catch (err) {
      this.logger.warn("虚构终端输出生成失败: %s", err);
      return "（终端好像卡住了，屏幕上什么都没有。）" + PROMPT_HINT;
    }
  }
}

const TOOLS: AppRawTool[] = [
  {
    name: "run_command",
    description:
      "在当前终端里执行一条命令，返回它在电脑上产生的输出。cwd 可指定相对电脑主目录的工作目录（缺省为打开终端时所在目录）。" +
      "执行失败/无权限时终端会如实报错。",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令，如 ls -la" },
        cwd: { type: "string", description: "工作目录，相对电脑主目录；省略为当前目录" },
      },
      required: ["command"],
    },
  },
];
