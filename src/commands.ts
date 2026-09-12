/** The plugin's command catalogue and handlers are shared by Koishi and the admin WebUI. */
import type { Context } from "koishi";
import type { Config } from "./config.js";

export interface WorldCommandHost {
  config: Config;
  getClock(): unknown;
  isInitialized(): Promise<boolean>;
  initWorld(force: boolean): Promise<string>;
  startWorld(): Promise<string>;
  stopWorld(): Promise<string>;
  statusText(): Promise<string>;
  reloadWorld(): Promise<string>;
  clearMsg(): Promise<string>;
  injectEvent(text: string): Promise<string>;
  crossingForce(target: string): Promise<string>;
  resetWorld(): Promise<string>;
}

export interface CommandField {
  name: string;
  label: string;
  type: "text" | "textarea" | "boolean" | "world";
  required?: boolean;
  hint?: string;
}
export interface WorldCommandDefinition {
  name: string;
  title: string;
  description: string;
  declaration: string;
  authority: number;
  mutates: boolean;
  fields: CommandField[];
  confirmation?: string;
  progress?: string;
}

export const WORLD_COMMANDS: readonly WorldCommandDefinition[] = [
  { name: "world.status", title: "查看运行状态", description: "读取世界、时钟、Bot 与应用的当前运行状态。", declaration: ".status", authority: 1, mutates: false, fields: [] },
  { name: "world.start", title: "启动世界", description: "让世界开始或恢复运转。", declaration: ".start", authority: 3, mutates: true, fields: [] },
  { name: "world.stop", title: "暂停世界", description: "暂停世界与 Bot；与现实同步的时钟继续走时，其它时钟随暂停静止。", declaration: ".stop", authority: 3, mutates: true, fields: [] },
  { name: "world.reload", title: "重载世界设定", description: "根据已保存的定义调整世界状态，并以世界内的事件告知 Bot。", declaration: ".reload", authority: 3, mutates: true, fields: [], progress: "正在重载定义：World-LLM 正在调整世界状态，请稍候……" },
  { name: "world.inject", title: "注入意识事件", description: "向运行中的 Bot 注入一条系统事件并唤醒它，用于调试。", declaration: ".inject <text:text>", authority: 3, mutates: true, fields: [{ name: "text", label: "事件内容", type: "textarea", required: true, hint: "内容会进入 Bot 的意识流。" }] },
  { name: "world.travel", title: "强制穿越", description: "把 Bot 送到已配置的世界，或送回自己的世界。", declaration: ".travel <name:text>", authority: 3, mutates: true, fields: [{ name: "name", label: "目标世界", type: "world", required: true }], confirmation: "这会强制改变 Bot 所在的世界。确认执行穿越？" },
  { name: "world.init", title: "创世", description: "由 World-LLM 根据定义生成初始世界，并清空 Bot 的聊天消息记录；可能需要几分钟。完成后需启动世界。", declaration: ".init", authority: 3, mutates: true, fields: [{ name: "force", label: "强制重新创世", type: "boolean", hint: "已有世界将先归档，再重置并重新生成；定义与固定小事记保留。" }], progress: "开始创世：World-LLM 正在依据定义生成世界，可能需要几分钟，请稍候……" },
  { name: "world.clearmsg", title: "清空聊天记录", description: "清空 Bot 的聊天消息记录，保留媒体缓存、世界状态与定义。", declaration: ".clearmsg", authority: 4, mutates: true, fields: [], confirmation: "确认清空 Bot 的全部聊天消息记录？此操作无法撤销。" },
  { name: "world.reset", title: "重置世界", description: "停止世界，归档并重置世界状态与笔记，保留定义与固定小事记。此指令不清空聊天记录或媒体；之后需要重新创世。", declaration: ".reset", authority: 4, mutates: true, fields: [], confirmation: "确认归档并重置当前世界？世界状态与笔记将重置，定义与固定小事记保留，之后需要重新创世。" },
  { name: "world.webui", title: "查看工作室地址", description: "查看配置中的 WebUI 访问地址。", declaration: ".webui", authority: 1, mutates: false, fields: [] },
];

export function commandDefinition(name: string): WorldCommandDefinition {
  const definition = WORLD_COMMANDS.find(command => command.name === name);
  if (!definition) throw new Error("只支持本插件目录中的 world 指令。");
  return definition;
}

export function commandArguments(name: string, input: unknown): Record<string, string | boolean> {
  const definition = commandDefinition(name);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("指令参数必须是对象。");
  const args = input as Record<string, unknown>, result: Record<string, string | boolean> = {};
  if (Object.keys(args).some(key => !definition.fields.some(field => field.name === key))) throw new Error("包含此指令不支持的参数。");
  for (const field of definition.fields) {
    const value = args[field.name];
    if (field.type === "boolean") {
      if (value !== undefined && typeof value !== "boolean") throw new Error(`${field.label}必须为布尔值。`);
      result[field.name] = value === true;
    } else {
      if (value !== undefined && typeof value !== "string") throw new Error(`${field.label}必须为文本。`);
      const text = typeof value === "string" ? value.trim() : "";
      if (field.required && !text) throw new Error(`${field.label}不能为空。`);
      if (text.length > (field.type === "textarea" ? 16000 : 256)) throw new Error(`${field.label}过长。`);
      result[field.name] = text;
    }
  }
  return result;
}

export function commandConfirmation(name: string, args: Record<string, unknown>): string | null {
  return name === "world.init" && args.force === true
    ? "确认归档并清空当前世界，强制重新创世？"
    : commandDefinition(name).confirmation ?? null;
}

/** No command text parsing, sessions, message sending or dynamic property dispatch. */
export async function executeWorldCommand(host: WorldCommandHost, name: string, input: unknown, progress?: (text: string) => void | Promise<void>): Promise<string> {
  const definition = commandDefinition(name), args = commandArguments(name, input);
  if (!host.getClock()) return "插件尚未就绪，请稍候。";
  if (name === "world.init" && (!(await host.isInitialized()) || args.force)) await progress?.(definition.progress!);
  if (name === "world.reload" && await host.isInitialized()) await progress?.(definition.progress!);
  switch (name) {
    case "world.status": return host.statusText();
    case "world.start": return host.startWorld();
    case "world.stop": return host.stopWorld();
    case "world.reload": return host.reloadWorld();
    case "world.inject": return host.injectEvent(String(args.text));
    case "world.travel": return host.crossingForce(String(args.name));
    case "world.init": return host.initWorld(args.force === true);
    case "world.clearmsg": return host.clearMsg();
    case "world.reset": return host.resetWorld();
    case "world.webui": {
      const webui = host.config.webui;
      if (!webui.enabled) return "WebUI 未启用。在配置中开启 webui.enabled 并重启插件后可用。";
      // A status command need not disclose the admin token into chat logs or command history.
      const hostname = webui.host.includes(":") ? `[${webui.host}]` : webui.host;
      return `工作室地址：http://${hostname}:${webui.port}/` + (webui.token ? "（需要管理员访问令牌）" : "");
    }
    default: throw new Error("不支持的指令。");
  }
}

export function registerWorldCommands(ctx: Context, host: WorldCommandHost): void {
  // Keep the parent accessible: Koishi checks authority across the entire command chain.
  const root = ctx.command("world", "YesImBot World 虚拟世界");
  for (const definition of WORLD_COMMANDS) {
    const command = root.subcommand(definition.declaration, definition.description, { authority: definition.authority });
    if (definition.name === "world.init") command.option("force", "-f 强制重新创世（归档并清空当前世界）");
    command.action(async ({ session, options }, value?: string) => {
      const args = definition.name === "world.init" ? { force: !!(options as { force?: boolean } | undefined)?.force }
        : definition.name === "world.inject" ? { text: value ?? "" }
          : definition.name === "world.travel" ? { name: value ?? "" } : {};
      try { return await executeWorldCommand(host, definition.name, args, async message => { await session?.send(message); }); }
      catch (error) { return `${definition.title}失败：${(error as Error).message ?? error}`; }
    });
  }
}
