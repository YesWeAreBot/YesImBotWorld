/**
 * 穿越（联机）协议：共享类型定义。
 *
 * 主世界（Host）开放 HTTP + SSE 服务，访客（Visitor）凭邀请码到达。
 * 网络上只传输任务文本与事件文本——World-LLM 的 API 地址与密钥永远留在各自本地。
 *
 * 端点（全部 JSON）：
 * - POST /crossing/arrive  {code, name, persona}      → {ok, token, worldName, timeLine}
 * - GET  /crossing/events?token=                       → SSE（事件 / 任务结果 / 告别）
 * - POST /crossing/task    {token, taskId, kind, payload} → {ok}（结果经 SSE 回传）
 * - POST /crossing/leave   {token}                     → {ok}
 */

/** 真人玩家进入世界的语义（进入前选定，进入后不可更改） */
export type PlayerMode = "cross" | "avatar" | "puppet";

/** 访客提交给主世界的任务类型 */
export type CrossingTaskKind = "act" | "wait" | "checkTime" | "query";

export interface CrossingTaskPayload {
  /** act：动作描述 */
  desc?: string;
  /** act：动作时长（TU） */
  duration?: number;
  /** wait：等待时长（TU） */
  n?: number;
  /** query：世界查询任务文本 */
  task?: string;
}

/** SSE 推送给访客的消息 */
export type CrossingSseMsg =
  | { type: "hello"; worldName: string; timeLine: string }
  | { type: "event"; content: string; timeLine?: string }
  | { type: "task_result"; taskId: string; ok: boolean; content: string }
  /** 主世界的 World-LLM 更新了访客的状态文件（写回访客世界的 Bot_Status.md） */
  | { type: "status_update"; content: string }
  | { type: "farewell"; reason: string };

/** 访客档案（到达时提交；persona 建议为 Bot_Status 摘录，供主世界裁定其行动） */
export interface VisitorProfile {
  name: string;
  persona: string;
  /** 真人玩家的进入语义（默认 cross=穿越；Bot 访客恒为 cross） */
  mode?: PlayerMode;
}

/** 主世界视角的一位访客 */
export interface VisitorInfo extends VisitorProfile {
  id: string;
}

export const CROSSING_LIMITS = {
  /** persona 最大长度（超出截断） */
  maxPersonaChars: 6000,
  /** 名字最大长度 */
  maxNameChars: 32,
  /** 任务 payload 文本字段最大长度 */
  maxTaskChars: 8000,
  /** 单个访客待处理任务上限 */
  maxPendingTasks: 4,
} as const;
