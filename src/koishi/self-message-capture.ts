import { AsyncLocalStorage } from "node:async_hooks";
import { h, type Bot, type Context, type Session } from "koishi";
import { channelKey } from "./channels.js";
import type { OwnSendTracker } from "./ownsends.js";

export interface ConfirmedSelfMessage {
  bot: Bot;
  channelId: string;
  messageId: string;
  elements: h[];
  session?: Session;
  own: boolean;
  timestamp: number;
  timestampSource?: "platform" | "local-confirmed" | "local-observed";
  platformSequence?: string | null;
}

type Receipt = { id?: string; content?: string; elements?: h[] };
type SendScope = { bot: Bot; channelId: string; method: string; insideCreate?: boolean; own: boolean; sessions: Session[]; receipts?: Receipt[] };

/** Satori's before-send runs before cancellation and transport, and current encoders do
 * not dispatch a send event. Observe fulfilled transport methods instead. before-send
 * supplies only transformed content; it is never evidence that anything was sent. */
export class SelfMessageCapture {
  private scope = new AsyncLocalStorage<SendScope>();
  private pending = new Map<string, Set<Promise<void>>>();
  private attached = new WeakSet<Bot>();
  private restores: (() => void)[] = [];
  private active = true;
  private logger: ReturnType<Context["logger"]>;

  constructor(
    private ctx: Context,
    private ownSends: OwnSendTracker,
    private confirmed: (message: ConfirmedSelfMessage) => void,
  ) {
    this.logger = ctx.logger("yesimbot-world");
    for (const bot of ctx.bots ?? []) this.attach(bot);
    ctx.on("bot-added", (bot) => this.attach(bot));
    ctx.on("before-send", (session) => {
      const scope = this.scope.getStore();
      if (scope && scope.bot.sid === session.bot.sid && scope.channelId === session.channelId) scope.sessions.push(session);
    });
    ctx.on("dispose", () => this.dispose());
  }

  /** An echo can arrive inside adapter.flush(), before its send promise settles. */
  async waitForPending(key: string): Promise<void> {
    await Promise.allSettled([...(this.pending.get(key) ?? [])]);
  }

  private attach(bot: Bot): void {
    if (this.attached.has(bot)) return;
    this.attached.add(bot);
    for (const method of ["sendMessage", "createMessage"] as const) {
      const original = bot[method];
      if (typeof original !== "function") continue;
      const descriptor = Object.getOwnPropertyDescriptor(bot, method);
      const capture = this;
      const wrapped = async function(this: Bot, channelId: string, content: h.Fragment, ...args: unknown[]) {
        const parent = capture.scope.getStore();
        if (!capture.active) return (original as Function).call(this, channelId, content, ...args);
        if (method === "createMessage" && parent?.method === "sendMessage" && !parent.insideCreate && parent.bot.sid === this.sid && parent.channelId === channelId) {
          parent.insideCreate = true;
          try {
            const result = await (original as Function).call(this, channelId, content, ...args);
            if (Array.isArray(result)) parent.receipts = result;
            return result;
          } finally { parent.insideCreate = false; }
        }
        const key = channelKey(this.platform ?? "unknown", channelId, this.selfId);
        const scope: SendScope = { bot: this, channelId, method, own: capture.ownSends.claim(key), sessions: [] };
        let settle!: () => void;
        const pending = new Promise<void>(resolve => { settle = resolve; });
        const queue = capture.pending.get(key) ?? new Set();
        queue.add(pending); capture.pending.set(key, queue);
        try {
          const result = await capture.scope.run(scope, () => (original as Function).call(this, channelId, content, ...args));
          if (!capture.active) return result;
          // Empty results include cancellation by before-send. They are never delivered.
          const receipts: Receipt[] = scope.receipts ?? (Array.isArray(result)
            ? result.map(item => typeof item === "string" ? { id: item } : item)
            : []);
          const fallback = scope.sessions.at(-1)?.elements ?? h.normalize(content);
          for (const [index, receipt] of receipts.entries()) {
            if (!receipt?.id) continue;
            try { capture.confirmed({ bot: this, channelId, messageId: String(receipt.id), own: scope.own, timestamp: Date.now(),
              elements: receipt.elements ?? (typeof receipt.content === "string" ? h.parse(receipt.content)
                : index === 0 ? fallback : [h.text("[同一次发送的其他片段，平台未返回正文]")]),
              session: scope.sessions.at(-1),
            }); } catch (error) {
              capture.logger.warn("已发送消息的本地捕获失败: %s", error);
            }
          }
          return result;
        } finally {
          settle(); queue.delete(pending);
          if (!queue.size) capture.pending.delete(key);
        }
      };
      (bot as any)[method] = wrapped;
      this.restores.push(() => {
        if (Object.getOwnPropertyDescriptor(bot, method)?.value !== wrapped) return;
        if (descriptor) Object.defineProperty(bot, method, descriptor);
        else delete (bot as any)[method];
      });
    }
  }

  dispose(): void {
    this.active = false;
    for (const restore of this.restores.splice(0).reverse()) restore();
  }
}
