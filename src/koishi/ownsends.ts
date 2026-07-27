/**
 * 本插件自身发送标记：messenger 每次调用 bot.sendMessage 前登记一次，
 * Koishi `send` 事件监听器据此区分"本插件发出的消息"与"外部（其他插件/指令）
 * 以 Bot 账号发出的消息"——只有后者需要按 externalSelfMessages 呈现给 Bot-LLM。
 */
export class OwnSendTracker {
  /** 频道 key → 登记时间戳队列 */
  private pending = new Map<string, number[]>();
  private readonly ttlMs = 60_000;

  /** 即将通过 bot.sendMessage 向该频道发出一条消息 */
  expect(key: string): void {
    const arr = this.pending.get(key) ?? [];
    arr.push(Date.now());
    this.pending.set(key, arr);
  }

  /** 发送失败：撤销登记 */
  unexpect(key: string): void {
    const arr = this.pending.get(key);
    if (arr?.length) arr.pop();
    if (arr && !arr.length) this.pending.delete(key);
  }

  /** send 事件到达：若该频道有登记则消耗一条并返回 true（本插件发的） */
  consume(key: string): boolean {
    const arr = this.pending.get(key);
    if (!arr) return false;
    const now = Date.now();
    while (arr.length && now - arr[0]! > this.ttlMs) arr.shift();
    if (!arr.length) {
      this.pending.delete(key);
      return false;
    }
    arr.shift();
    if (!arr.length) this.pending.delete(key);
    return true;
  }
}
