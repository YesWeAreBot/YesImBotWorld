import { exec } from "node:child_process";
import path from "node:path";

export interface ShellRunOptions {
  /** 命令默认工作目录；相对 baseDir 解析 */
  cwd: string;
  /** Koishi baseDir，用于把相对 cwd 解析成绝对路径 */
  baseDir: string;
  timeoutMs: number;
  maxOutputChars: number;
}

/** 执行一条本地命令，并把 stdout/stderr 汇总为给 Bot 的文本结果。 */
export async function runShellCommand(command: string, opts: ShellRunOptions): Promise<string> {
  const cwd = path.resolve(opts.baseDir, opts.cwd || ".");
  return new Promise<string>((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: opts.timeoutMs,
        maxBuffer: Math.max(1024 * 1024, opts.maxOutputChars * 4),
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const output = clip(
          [String(stdout).trim(), String(stderr).trim()].filter(Boolean).join("\n"),
          opts.maxOutputChars,
        );
        if (error) {
          const code = error.code == null ? "" : `，code ${error.code}`;
          resolve(`（命令执行失败${code}）\n${output || String(error.message).trim()}`.trim());
        } else {
          resolve(output || "（命令执行成功，无输出）");
        }
      },
    );
  });
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…（输出已截断，共 ${text.length} 字符）`;
}
