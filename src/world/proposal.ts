import type { ChatToolDef } from "../llm/chat.js";

/** Only delivery addresses and execution status are structured; world content is prose. */
export function worldResolutionTool(initializing = false): ChatToolDef {
  const prose = { type: "string", minLength: 1, maxLength: 200_000 };
  return { type: "function", function: { name: "resolve_world",
    description: "返回自然语言世界裁定。所有字段禁止新增平台消息、通知、收发回执或软件状态；普通任务只保存物理世界事实与感知。app_observe只读返回既有虚构应用输出，app_action保存虚构设备变化及私有回执，由设备流程决定感知；两者均不能模拟真实聊天平台。不需要实体或操作数组。",
    parameters: { type: "object", additionalProperties: false, required: initializing ? ["perceptions", "worldState", "actorStates", "botName"] : ["perceptions"], properties: {
      perceptions: { type: "array", maxItems: 100, description: "普通任务只向在场角色投递其实际感知，没有动静可省略。app_observe/app_action仅放请求actorId的一份私有应用输出，不代表角色已知。不能投递全知状态。", items: {
        type: "object", additionalProperties: false, required: ["actorId", "text"], properties: {
          actorId: { type: "string" }, text: { ...prose, description: "普通任务写实际物理经过、环境细节与在场NPC回应，不代替角色作决定，不呈现平台消息/通知、软件界面或读写成功。行动建议单独填opportunities，不能当成已经发生的text。应用任务仅写授权虚构应用输出。" },
          situation: { type: "string", minLength: 1, maxLength: 1200, description: "可选简短状态栏，仅本角色当下可知的位置、身体、物品和处境；不是全知状态，不编造心理动机、设备状态或他人秘密。app_observe/app_action禁止填写。" },
          opportunities: { type: "array", maxItems: 4, description: "最多4个能承接场景或开启新剧情的物理世界行动方向；有自然机会时通常给2至4个，缺少有意义选择时可少给或省略。角色可忽略或自由行动，不代表其动机、已执行行为或保证成功。可包括尝试观察、交谈、探索；不能读取真人聊天、通知、软件或替代设备工具。偶尔可给互斥方向，同组exclusiveGroup只表示此刻方向冲突。app_observe/app_action禁止填写。", items: {
            type: "object", additionalProperties: false, required: ["label", "intent"], properties: {
              label: { type: "string", minLength: 1, maxLength: 80, description: "简短选项标题，不包含隐藏事实或既成结果。" },
              intent: { type: "string", minLength: 1, maxLength: 600, description: "可交给act的自由语言尝试意图，不决定NPC回应，不预定成功，不泄露角色未知信息。" },
              exclusiveGroup: { type: "string", minLength: 1, maxLength: 80, description: "可选，同一次感知中互斥方向使用相同组名；无互斥关系时省略。" },
            },
          } },
        } } },
      worldState: { ...prose, description: "更新后的完整自然语言物理世界状态，保留仍有效的事实、秘密、在场NPC交谈进度、目标和未完成过程。不能新建或沿用外部聊天断言。已有虚构软件/文件原文普通任务只可逐字保留。普通任务无变化省略；app_action必须填写，无变化原文返回；app_observe不能填写。不是变更摘要或JSON。" },
      actorStates: { type: "array", maxItems: 100, description: "需要更新的受控角色身体、处境、随身物品和活动状态全文；不代写主观认识与意图。NPC记在worldState。", items: {
        type: "object", additionalProperties: false, required: ["actorId", "state"], properties: { actorId: { type: "string" }, state: prose } } },
      ...(initializing ? { botName: { type: "string", minLength: 1, maxLength: 64 } } : {}),
      outcome: { type: "object", additionalProperties: false, required: ["status"], properties: {
        status: { type: "string", enum: ["completed", "failed", "needs_input", "ongoing"], description: "completed为当下确已完成的短动作；needs_input为已到新的自主决定点并结束本次裁定；failed为实际受阻。仅actionPhase=start可用ongoing，表示持续过程刚开始、尚未到expectedEnd：只写已经发生的开始及当下处境，不预写未来完成。actionPhase=finish和应用操作不可返回ongoing。duration是估计时长，不要求短动作先空等；真正持续的过程仍必须到真实时钟到期后另行结算。" },
        reason: { type: "string", description: "可选内部裁定诊断，不代替可感知结果，不向角色展示。" },
        speechSpoken: { type: "boolean", description: "请求提供speech原话时必填。实际说出为true，否则false；true时在行动者感知中逐字保留原话，按开口当时的位置确定其他听众。" },
      } },
    } },
  } };
}
