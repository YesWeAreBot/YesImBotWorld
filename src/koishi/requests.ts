/**
 * 待处理的平台请求（好友申请 / 入群邀请 / 入群申请）。
 *
 * Gateway 收到请求事件时登记并生成 req_N 编号通知 Bot；
 * Bot 用 handle_request(req_N, approve) 处理。仅保存在内存中（重启后失效）。
 */
export interface PendingRequest {
  id: string;
  kind: "friend" | "guild" | "member";
  platform: string;
  selfId: string;
  /** 平台侧的请求标识（Koishi handleXxxRequest 所需的 messageId / flag） */
  messageId: string;
  userId: string;
  username: string;
  guildId?: string;
  comment?: string;
}

const MAX_PENDING = 100;

export class RequestStore {
  private map = new Map<string, PendingRequest>();
  private counter = 0;

  add(req: Omit<PendingRequest, "id">): PendingRequest {
    const id = `req_${++this.counter}`;
    const entry: PendingRequest = { ...req, id };
    this.map.set(id, entry);
    // 防止无限堆积：超出上限时丢弃最旧的
    while (this.map.size > MAX_PENDING) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return entry;
  }

  get(id: string): PendingRequest | null {
    return this.map.get(id) ?? null;
  }

  remove(id: string): void {
    this.map.delete(id);
  }
}
