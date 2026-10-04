import type { BotModelConfig } from "../config.js";
import type { ChatClientConfig } from "./chat.js";

/** Resolve once per request so the client and endpoint queue use the same configuration. */
export function resolveGrowthModelConfig(bot: BotModelConfig): ChatClientConfig {
  const override = bot.growth?.llm;
  const label = "Growth";
  if (!override || override.mode === "inherit" || override.mode === undefined) {
    // Preserve the former maintenance sampling policy when inheriting the Bot model.
    return { apiType: bot.apiType ?? "chat-completions", baseURL: bot.baseURL, apiKey: bot.apiKey || undefined, model: bot.model,
      temperature: Math.min(bot.temperature ?? 0.3, 0.4), maxTokens: Math.max(2048, Math.min(bot.maxTokens || 4096, 8192)),
      disableThinking: bot.disableThinking, stream: bot.stream, label };
  }
  const title = "成长整理";
  if (override.mode !== "independent") throw Error(`${title}的 LLM 配置模式无效`);
  const baseURL = override.baseURL?.trim() ?? "", model = override.model?.trim() ?? "";
  if (!baseURL) throw Error(`${title}已选择独立 LLM，但尚未填写 baseURL；请设置 API 地址或改为沿用 Bot LLM`);
  let url: URL;
  try { url = new URL(baseURL); } catch { throw Error(`${title}的独立 LLM baseURL 必须是完整的 HTTP(S) API 地址`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw Error(`${title}的独立 LLM baseURL 必须使用 HTTP 或 HTTPS`);
  if (!model) throw Error(`${title}已选择独立 LLM，但尚未填写 model；请设置模型名或改为沿用 Bot LLM`);
  // Never send the Bot's key to an independently configured service, even when
  // the independent key is empty or the two endpoints happen to be identical.
  return { apiType: override.apiType ?? "chat-completions", baseURL, apiKey: override.apiKey || undefined, model,
    temperature: override.temperature ?? 0.3, maxTokens: override.maxTokens ?? 4096,
    disableThinking: override.disableThinking ?? false, stream: override.stream ?? true, label };
}
