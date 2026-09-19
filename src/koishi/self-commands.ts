import { AsyncLocalStorage } from "node:async_hooks";
import { h, Command, Universal, type Bot, type Context, type Session } from "koishi";
import type { ChannelIdentity } from "./identity.js";

const scopes = new WeakMap<Context, AsyncLocalStorage<boolean>>();
const isWorldCommand = (name: string) => name === "world" || name.startsWith("world.");

/** Execute only an explicitly sent plain-text command. Use Koishi's normal command
 * execution so account authority, channel permissions and scoped command filters apply.
 * The context guard also covers aliases, interpolations and nested session.execute(). */
export async function executeSelfCommand(
  ctx: Context,
  target: { bot: Bot; platform: string; channelId: string; isDirect?: boolean },
  content: string,
  messageId?: string,
  identity?: Pick<ChannelIdentity, "platform" | "selfId" | "channelId" | "displayName" | "source">,
): Promise<void> {
  const text = content.trim();
  const token = text.split(/\s+/, 1)[0] ?? "";
  const commander = (ctx as Context & { $commander?: { get(name: string, session?: Session): { name: string } | undefined } }).$commander;
  if (!token || !commander) return;
  const direct = target.isDirect ?? target.channelId.startsWith("private:");
  const matching = identity?.platform === target.platform && identity.selfId === target.bot.selfId && identity.channelId === target.channelId;
  const name = matching && identity.displayName.trim() ? identity.displayName : "昵称未知";
  const session = target.bot.session({
    type: "message", timestamp: Date.now(),
    channel: { id: target.channelId, type: direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
    ...(direct ? {} : { guild: { id: target.channelId }, ...(matching && identity.source === "group_card" ? { member: { nick: name } } : {}) }),
    user: { id: target.bot.selfId ?? "", name },
    message: { elements: h.parse(text), ...(messageId ? { id: messageId } : {}) },
  }) as Session;
  // No implicit prefix stripping: the documented switch accepts bare command names.
  const command = commander.get(Command.normalize(token), session);
  if (!command || isWorldCommand(command.name)) return;
  let scope = scopes.get(ctx);
  if (!scope) {
    scope = new AsyncLocalStorage<boolean>();
    scopes.set(ctx, scope);
    const execution = scope;
    ctx.on("command/before-execute", (argv) => {
      if (execution.getStore() && isWorldCommand(argv.command?.name ?? "")) return "";
    }, true);
  }
  await scope.run(true, () => session.execute(text));
}
