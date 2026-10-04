/** Transport success does not make an incomplete model output executable. */
import type { ChatUsage } from "./chat.js";

export class ChatCompletionError extends Error {
  /** Known billable usage may arrive with a rejected terminal response. */
  usage?: ChatUsage;
  constructor(readonly code: "LLM_OUTPUT_TRUNCATED" | "LLM_CONTENT_FILTERED" | "LLM_STREAM_INCOMPLETE" | "LLM_RESPONSE_INVALID" | "LLM_REMOTE_ERROR", message: string, readonly finishReason?: string | null) {
    super(`${code}: ${message}`);
    this.name = "ChatCompletionError";
  }
}

export function withUsage<T>(error: T, usage: ChatUsage | null | undefined): T {
  if (error instanceof ChatCompletionError && usage) error.usage = usage;
  return error;
}

/** A known protocol limitation can downgrade only that input modality, never unrelated media. */
export class UnsupportedProtocolModalityError extends Error {
  readonly status = 400;
  constructor(api: string, part: "input_audio" | "video_url" | "image_url") {
    super(`${api}: unsupported content part type ${part}；此 API 不支持这种媒体输入，请使用对应解释器或支持该模态的接口。`);
    this.name = "UnsupportedProtocolModalityError";
  }
}
