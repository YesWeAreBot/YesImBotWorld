import type { ChatToolDef } from "../llm/chat.js";

/** Only delivery addresses and execution status are structured; world content is prose. */
export function worldResolutionTool(initializing = false): ChatToolDef {
  const prose = { type: "string", minLength: 1, maxLength: 200_000 };
  return { type: "function", function: { name: "resolve_world",
    description: "返回自然语言世界裁定。普通任务将角色感知与状态全文一起保存后交付；app_observe只读返回私有应用输出，app_action保存设备变化及私有回执，由设备流程决定感知。不需要实体或操作数组。",
    parameters: { type: "object", additionalProperties: false, required: initializing ? ["perceptions", "worldState", "actorStates", "botName"] : ["perceptions"], properties: {
      perceptions: { type: "array", maxItems: 100, description: "普通任务只向在场角色投递其实际感知，没有动静可省略。app_observe/app_action仅放请求actorId的一份私有应用输出，不代表角色已知。不能投递全知状态。", items: {
        type: "object", additionalProperties: false, required: ["actorId", "text"], properties: { actorId: { type: "string" }, text: { ...prose, description: "普通任务写实际经过、环境细节与NPC回应，不代替角色作决定；应用任务仅写应用输出。" } } } },
      worldState: { ...prose, description: "更新后的完整自然语言世界状态，保留仍有效的事实、秘密、对话进度、NPC目标和未完成过程。普通任务无变化省略；app_action必须填写，无变化原文返回；app_observe不能填写。不是变更摘要或JSON。" },
      actorStates: { type: "array", maxItems: 100, description: "需要更新的受控角色身体、处境、随身物品和活动状态全文；不代写主观认识与意图。NPC记在worldState。", items: {
        type: "object", additionalProperties: false, required: ["actorId", "state"], properties: { actorId: { type: "string" }, state: prose } } },
      ...(initializing ? { botName: { type: "string", minLength: 1, maxLength: 64 } } : {}),
      outcome: { type: "object", additionalProperties: false, required: ["status"], properties: {
        status: { type: "string", enum: ["completed", "failed", "needs_input"] },
        reason: { type: "string", description: "可选内部裁定诊断，不代替可感知结果，不向角色展示。" },
        speechSpoken: { type: "boolean", description: "请求提供speech原话时必填。实际说出为true，否则false；true时在行动者感知中逐字保留原话，按开口当时的位置确定其他听众。" },
      } },
    } },
  } };
}
