/**
 * Bot 的个人电脑：一个真实存在的 Docker 容器。
 *
 * 把"指令执行"具象化成 Bot 自己的一台电脑，替代之前直接把命令跑在
 * Koishi 所在主机上的 run_command 工具——容器天然隔离，Bot 只有这台
 * 电脑的权限，动不了宿主上的文件。
 *
 * - 打开终端 / 资源管理器时会按需创建并启动容器（配置里指定镜像）；
 * - 容器创建一次即可反复使用，命令在固定的 /workspace 主目录里执行；
 * - 与主机的目录映射由配置显式声明（默认不映射任何主机路径）。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { Logger } from "koishi";
import type { ComputerConfig } from "./config.js";

export interface ComputerExecResult {
  code: number | null;
  output: string;
}

interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

/** 运行中的容器是否需要在本插件停止时关闭（true=由本插件创建的） */
let selfManaged: { name: string } | null = null;

export class BotComputer {
  private ready: boolean | null = null;

  constructor(
    private cfg: ComputerConfig,
    private logger: Logger,
  ) {}

  /** 电脑是否就绪（容器已创建并启动）；失败时给出原因 */
  async ensureReady(): Promise<{ ok: boolean; error?: string }> {
    if (this.ready === true) return { ok: true };
    if (!this.cfg.docker.cli) return { ok: false, error: "这台电脑没有配置 Docker 实现（apps.computer.mode 需选 docker，且 apps.computer.docker.cli 需填写）。" };
    try {
      await this.ensureContainer();
      this.ready = true;
      this.logger.info("Bot 的个人电脑已就绪：容器 %s", this.cfg.docker.containerName);
      return { ok: true };
    } catch (err) {
      this.logger.warn("Bot 的个人电脑初始化失败: %s", err);
      this.ready = null;
      return { ok: false, error: (err as Error).message ?? String(err) };
    }
  }

  /** 在电脑（容器）里执行一条命令，返回退出码与合并输出 */
  async exec(
    command: string,
    opts: { cwd?: string; timeoutMs?: number; maxOutputChars?: number; env?: Record<string, string> } = {},
  ): Promise<ComputerExecResult> {
    const ready = await this.ensureReady();
    if (!ready.ok) return { code: null, output: `（${ready.error}）` };
    const timeoutMs = opts.timeoutMs ?? this.cfg.docker.commandTimeoutMs;
    const maxOutputChars = opts.maxOutputChars ?? this.cfg.docker.maxOutputChars;
    const cwd = path.resolve(this.cfg.docker.workdir, opts.cwd || ".");
    const envArgs = opts.env
      ? Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`])
      : [];
    const userArgs = this.cfg.docker.user.trim() ? ["--user", this.cfg.docker.user.trim()] : [];
    try {
      const res = await execDocker(
        this.cfg.docker.cli,
        ["exec", ...userArgs, "-w", cwd, ...envArgs, this.cfg.docker.containerName, "sh", "-c", command],
        { timeoutMs },
      );
      const out = clip([res.stdout, res.stderr].filter(Boolean).join("\n").trim(), maxOutputChars);
      return {
        code: res.code,
        output: out || (res.code === 0 ? "（命令执行成功，无输出）" : "（命令没有产生输出）"),
      };
    } catch (err) {
      this.ready = null; // docker 本身出错：下次再试（容器可能被外部删了）
      return { code: null, output: `（命令执行失败：${(err as Error).message ?? err}）` };
    }
  }

  /** 主目录路径（在电脑内） */
  get homeDir(): string {
    return this.cfg.docker.workdir;
  }

  /** 电脑关机：本插件自建的容器会一并关闭，下次打开再自动启动 */
  async shutdown(): Promise<void> {
    const m = selfManaged;
    selfManaged = null;
    this.ready = null;
    if (!m || !this.cfg.docker.cli) return;
    try {
      await execDocker(this.cfg.docker.cli, ["stop", "--time=5", m.name], { timeoutMs: 15000 });
    } catch (err) {
      this.logger.warn("关闭 Bot 的个人电脑失败: %s", err);
    }
  }

  async dispose(): Promise<void> {
    selfManaged = null;
    this.ready = null;
  }

  // ---------- 容器生命周期 ----------

  private async ensureContainer(): Promise<void> {
    const docker = this.cfg.docker.cli;
    const { containerName: name, image, pullPolicy } = this.cfg.docker;

    // 1. 容器是否已存在（运行或停止）
    const inspect = await execDocker(docker, ["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 10000 });
    if (inspect.code === 0) {
      const running = inspect.stdout.trim() === "true";
      if (!running) {
        await execDocker(docker, ["start", name], { timeoutMs: 30000 }).catch(() => {});
        const after = await execDocker(docker, ["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 10000 });
        if (after.code === 0 && after.stdout.trim() === "true") return;
        // 容器存在但起不来（比如旧版本创建、主进程一启动就退出）：删掉重造
        this.logger.warn("电脑（%s）无法启动，删除重建", name);
        await execDocker(docker, ["rm", "-f", name], { timeoutMs: 30000 }).catch(() => {});
      } else {
        return;
      }
    }

    // 2. 没有容器：按策略准备镜像，然后创建并启动
    if (pullPolicy === "always") {
      const pulled = await execDocker(docker, ["pull", image], { timeoutMs: 120000 });
      if (pulled.code !== 0) {
        throw new Error(`拉取镜像 ${image} 失败：${clip(pulled.stderr, 300)}`);
      }
    } else if (pullPolicy === "missing") {
      await execDocker(docker, ["pull", image], { timeoutMs: 120000 }).catch(() => {});
    }

    const mounts = this.cfg.docker.mounts.map((m) => `${m.host}:${m.container}${m.readonly ? ":ro" : ""}`);
    const uidArg = this.cfg.docker.user.trim() && /^\d+$/.test(this.cfg.docker.user.trim()) ? this.cfg.docker.user.trim() : "";
    // 容器主进程 = 保活脚本：创建主目录并交给执行用户，然后一直待命。
    // 主进程以镜像默认用户（node:20-slim 即 root）启动，才能 chown；真正的命令经 exec 以 user 执行。
    const keepAliveScript =
      'mkdir -p "$YBT_WORKDIR" 2>/dev/null; ' +
      (uidArg ? `chown "$YBT_UID" "$YBT_WORKDIR" 2>/dev/null; ` : "") +
      'trap "exit" TERM INT; sleep infinity & wait';
    const create = await execDocker(
      docker,
      [
        "create",
        "--name", name,
        "--network", this.cfg.docker.network,
        "--hostname", this.cfg.docker.hostname,
        "-e", `TZ=${this.cfg.docker.timezone}`,
        "-e", `YBT_WORKDIR=${this.cfg.docker.workdir}`,
        ...(uidArg ? ["-e", `YBT_UID=${uidArg}`] : []),
        "--workdir", this.cfg.docker.workdir,
        ...(mounts.length ? ["-v", ...mounts] : []),
        ...this.cfg.docker.extraArgs,
        image,
        "sh", "-c", keepAliveScript,
      ],
      { timeoutMs: 30000 },
    );
    if (create.code !== 0) {
      throw new Error(`创建电脑失败：${clip(create.stderr, 500)}`);
    }
    selfManaged = { name };
    await execDocker(docker, ["start", name], { timeoutMs: 30000 });
  }
}

// ---------- docker CLI 封装 ----------

function execDocker(docker: string, args: string[], opts: { timeoutMs: number }): Promise<CmdResult> {
  return new Promise<CmdResult>((resolve, reject) => {
    const child = spawn(docker, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (res: CmdResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, killed: true });
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => finish({ code, stdout, stderr, killed: false }));
  });
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…（输出已截断，共 ${text.length} 字符）`;
}
