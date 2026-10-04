import type { ChatClientConfig, ChatCompleteOptions, ChatMessage, ChatUsage, RawToolCall } from "./chat.js";
import type { LlmResponse } from "./http.js";

export type ChatApiType = "chat-completions" | "responses" | "anthropic";

/** Provider protocols share result semantics; raw request/response bytes stay in the call log. */
export interface ProtocolProgress {
  content: string;
  toolCalls: RawToolCall[];
  usage: ChatUsage | null;
  finishReason?: string | null;
  complete: boolean;
  reasoning?: string;
}

export interface ChatProtocolAdapter {
  buildRequest(config: ChatClientConfig, messages: ChatMessage[], options: ChatCompleteOptions, stream: boolean): Record<string, unknown>;
  decodeResponse(value: unknown): ProtocolProgress;
  readStream(response: LlmResponse, onProgress: (progress: ProtocolProgress) => void, onText?: (text: string) => void): Promise<ProtocolProgress>;
}
