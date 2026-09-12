import { randomUUID } from "node:crypto";
import { commandArguments, commandConfirmation, commandDefinition, executeWorldCommand, WORLD_COMMANDS, type WorldCommandHost } from "../commands.js";

export interface CommandRun {
  id: string;
  command: string;
  args: Record<string, string | boolean>;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  messages: string[];
  result?: string;
  error?: string;
}

export class CommandRequestError extends Error {
  constructor(message: string, readonly status: number = 400) { super(message); }
}

/** Kept for the lifetime of this server. A new instance ID forbids replay after a restart. */
export class WebCommandRunner {
  readonly instanceId = randomUUID();
  private runs = new Map<string, CommandRun>();
  private mutating: string | null = null;
  constructor(private host: WorldCommandHost) {}

  catalog() {
    return {
      instanceId: this.instanceId,
      commands: WORLD_COMMANDS,
      worlds: [{ name: "home", label: "自己的世界" }, ...this.host.config.crossing.worlds.filter(world => world.name.trim() && world.url.trim()).map(world => ({ name: world.name.trim(), label: world.name.trim() }))],
      runs: [...this.runs.values()].slice(-50).reverse(),
      busy: this.mutating,
    };
  }

  get(id: string): CommandRun | undefined { return this.runs.get(id); }

  start(body: unknown): CommandRun {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new CommandRequestError("请求体必须是对象。");
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => !["id", "instanceId", "command", "args", "confirmed"].includes(key))) throw new CommandRequestError("请求包含未知字段。");
    if (input.instanceId !== this.instanceId) throw new CommandRequestError("服务已经重启，请刷新指令目录并确认当前世界状态。旧请求不会重新执行。", 409);
    if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.id)) throw new CommandRequestError("需要有效的执行请求 ID。");
    if (typeof input.command !== "string" || (input.confirmed !== undefined && typeof input.confirmed !== "boolean")) throw new CommandRequestError("指令或确认参数无效。");
    let args: Record<string, string | boolean>;
    try { args = commandArguments(input.command, input.args); }
    catch (error) { throw new CommandRequestError((error as Error).message); }
    const previous = this.runs.get(input.id);
    if (previous) {
      if (previous.command !== input.command || JSON.stringify(previous.args) !== JSON.stringify(args)) throw new CommandRequestError("该请求 ID 已用于其它指令或参数。", 409);
      return previous;
    }
    if (commandConfirmation(input.command, args) && input.confirmed !== true) throw new CommandRequestError("此操作需要在网页确认后执行。", 409);
    const definition = commandDefinition(input.command);
    if (definition.mutates && this.mutating) throw new CommandRequestError("另一个管理指令正在执行，请等待完成后再操作。", 409);
    // Retain every accepted ID, including failed runs; never evict and then replay a mutation.
    if (this.runs.size >= 1000) throw new CommandRequestError("本次服务已保留 1000 条执行记录，请重载插件后继续。", 429);
    const run: CommandRun = { id: input.id, command: input.command, args, status: "running", startedAt: Date.now(), messages: [] };
    this.runs.set(run.id, run);
    if (definition.mutates) this.mutating = run.id;
    void executeWorldCommand(this.host, run.command, run.args, message => { run.messages.push(message); }).then(
      result => { run.result = result; run.status = "completed"; },
      error => { run.error = String((error as Error).message ?? error); run.status = "failed"; },
    ).finally(() => { run.finishedAt = Date.now(); if (this.mutating === run.id) this.mutating = null; });
    return run;
  }
}
