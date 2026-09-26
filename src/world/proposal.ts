import type { ChatToolDef } from "../llm/chat.js";

/** Kept outside editable prose prompts: this operation cannot become a second actor loop. */
export const WORLD_EVOLUTION_AUTHORITY = `本次kind=evolve从evolutionSinceTU承接已提交演化，elapsedEvolutionWorldSeconds是此后经过的世界秒数，不能从旧状态文本时间重演已经发生的历史。仅裁定外部世界：天气、环境、NPC以及远处事件可以按真实经过发展。输入的受控角色是观察者，不是本轮行动者；其状态默认保持，不能用心跳替其安排动作、转移注意、作决定，不能把经过一段时间续写成困倦、入睡或醒来，也不能推进或完成pendingActions。睡眠等持续行动只由对应action裁定。可以描述本轮外部物理原因实际造成的身体影响，例如雨水淋湿衣服、他人碰撞或强光到达感官；实际原因、空间和感知条件必须成立，不因为要唤醒/提醒角色而制造原因。externalChanges记录本轮外部经过及局部id并存入事件日志；只有影响后续的长期事实变化才更新worldState全文，短暂变化无需重抄世界状态；actorStates/outcome在本任务不可写。真正的身体变化只经actorEffects提交并引用changeIds，只更新原因造成的客观影响；没有影响就保留原状态。perceptions必须引用本轮变化的changeIds，且仅投递接收者实际感知到的部分；远处事件及未被注意的经过只保存于世界记录，仍影响后续的事实与秘密写入worldState，不能把全知原因告诉角色。phoneState也须用phoneChangeIds引用实际外部物理原因。每份perceptions必须有text正文，situation不能替代text。安静时perceptions:[]并省略worldState，不为给反馈或选项制造事件，不用无变化的旧场景重复催促。承接NPC正在做的事情、环境过程与已确定的日程，不把每轮都写成一次新的风吹或虫鸣。可用nextIntervalTU建议下次检查的间隔，依据下一处外部进展可能发生的时间，不跳过这段时间或提前实现它。`;

/** Only delivery addresses and execution status are structured; world content is prose. */
export function worldResolutionTool(initializing = false, evolving = false): ChatToolDef {
  const prose = { type: "string", minLength: 1, maxLength: 200_000 };
  const changeIds = { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 80 }, description: "引用本次externalChanges中的id；不能引用旧事件、角色自己的等待/睡眠或尚未完成的行动作为外部原因。" };
  return { type: "function", function: { name: "resolve_world",
    description: "返回自然语言世界裁定。所有字段禁止新增平台消息、通知、收发回执或软件状态；普通任务只保存物理世界事实与感知。app_observe只读返回既有虚构应用输出，app_action保存虚构设备变化及私有回执，由设备流程决定感知；两者均不能模拟真实聊天平台。不需要实体或操作数组。",
    parameters: { type: "object", additionalProperties: false, required: initializing ? ["perceptions", "worldState", "actorStates", "botName"] : ["perceptions"], properties: {
      perceptions: { type: "array", maxItems: 100, description: "普通任务只向在场角色投递其实际感知；无可感知变化时返回空数组[]。app_observe/app_action仅放请求actorId的一份私有应用输出，不代表角色已知。不能投递全知状态。", items: {
        type: "object", additionalProperties: false, required: evolving ? ["actorId", "text", "changeIds"] : ["actorId", "text"], properties: {
          actorId: { type: "string" }, text: { ...prose, description: "普通任务写实际物理经过、环境细节与在场NPC回应，不代替角色作决定，不呈现平台消息/通知、软件界面或读写成功。行动建议单独填opportunities，不能当成已经发生的text。应用任务仅写授权虚构应用输出。" },
          ...(evolving ? { changeIds } : {}),
          situation: { type: "string", minLength: 1, maxLength: 1200, description: "可选简短状态栏，仅本角色当下可知的位置、身体、物品和处境；不是全知状态，不编造心理动机、设备状态或他人秘密。app_observe/app_action禁止填写。" },
          opportunities: { type: "array", maxItems: 4, description: "清醒角色有选择可做时，给有区别、立足已知处境的物理行动方向，通常2至4项。承接手头事情、喝水、休息、收拾、接触NPC或探索线索都可以，依照真实处境，不强迫冒险或制造新事件。不要用同义选项凑数；真实睡眠、安静等待或没有新选择时可少给，不为给选项而唤醒角色。省略表示本次不更新仍有效的既有建议；空数组[]明确撤销旧建议，非空数组替换为本次建议。角色可忽略或自由行动，不代表其动机、已执行行为或保证成功。不能读取真人聊天、通知、软件或替代设备工具；摸手机确认闹钟已设好也是软件核对，不是物理方向。独立实体闹钟仍属于物理环境。同组exclusiveGroup仅表示时机冲突，不自动执行。app_observe/app_action禁止填写。", items: {
            type: "object", additionalProperties: false, required: ["label", "intent"], properties: {
              label: { type: "string", minLength: 1, maxLength: 80, description: "简短选项标题，不包含隐藏事实或既成结果。" },
              intent: { type: "string", minLength: 1, maxLength: 600, description: "可交给act的自由语言尝试意图，不决定NPC回应，不预定成功，不泄露角色未知信息。" },
              exclusiveGroup: { type: "string", minLength: 1, maxLength: 80, description: "可选，同一次感知中互斥方向使用相同组名；无互斥关系时省略。" },
            },
          } },
        } } },
      worldState: { ...prose, description: "更新后的完整自然语言物理世界状态，保留仍有效的事实、秘密、在场NPC交谈进度、目标和未完成过程。不能新建或沿用外部聊天断言。已有虚构软件/文件原文普通任务只可逐字保留。已经结束且不再影响后续的细节留在事件日志，不逐轮追加流水账；实际更新时合并重复内容，完整性优先于worldMemory.targetChars软目标，不硬截断。普通任务无长期变化省略；app_action必须填写，无变化原文返回；app_observe不能填写。不是变更摘要或JSON。" },
      ...(evolving ? {
        externalChanges: { type: "array", maxItems: 100, description: "本轮真正发生的外部变化：NPC行动、天气、环境或世界其他地区的进展。每项id仅在本次裁定内引用；description写原因与实际经过，不能写受控角色的新决定、主动动作、困倦/入睡/睡醒或其待结算行动的进展。平静时可空数组或省略；远方变化存入本轮日志，影响后续的事实还须更新worldState，无可感知内容就不投递。", items: { type: "object", additionalProperties: false, required: ["id", "description"], properties: { id: { type: "string", minLength: 1, maxLength: 80 }, description: prose } } },
        actorEffects: { type: "array", maxItems: 100, description: "仅在本轮外部变化实际影响受控角色身体/处境时填写，例如雨水打湿衣服、别人撞到身体。引用外部原因，state为承接旧状态的全文，只改该原因造成的客观影响；不能代替角色决定、转移注意、发言、入睡或续写睡醒，不以时间流逝推演疲倦，不结算pendingActions。没有身体影响就省略。", items: { type: "object", additionalProperties: false, required: ["actorId", "changeIds", "state"], properties: { actorId: { type: "string" }, changeIds, state: prose } } },
        phoneChangeIds: changeIds,
        nextIntervalTU: { type: "number", exclusiveMinimum: 0, description: "可选，仅建议下次心跳间隔（TU）。依据NPC、环境过程或既定日程的下一变化时机；安静时可建议更长间隔。程序按时钟设置约束，不推进当前时间，不表示事件已经发生。" },
      } : {}),
      phoneState: { type: "object", additionalProperties: false, required: ["reachable", "location", "usable", "perceptible"],
        description: "可选，本次物理裁定明确确立或改变常驻角色手机的物理条件时才填写完整状态；无变化省略，不能凭缺省恢复正常。只在输入phoneAuthority.canUpdate=true时可写；访客、虚构应用和跨世界任务无权修改。只说明本次剧情支持的可达性、物理位置、硬件可用性及动静可感知范围；不执行拿放、解锁或软件操作，不生成通知/消息，不能把提议或未来意图当成已发生变化。丢失且去向未知用location=null。", properties: {
          reachable: { type: "boolean", description: "角色无需新的物理世界行动就能触及并拿取手机；遗失、远离或受阻为false。" },
          location: { type: ["string", "null"], minLength: 1, maxLength: 300, description: "已确立的物理位置；未知为null。不得包含聊天、软件、通知内容，不声称用户已知道隐藏位置。" },
          usable: { type: "boolean", description: "物理硬件与供电允许正常使用；损坏或无法供电为false。不是联网、登录、应用或免打扰状态。" },
          perceptible: { type: "boolean", description: "若真实设备发出通知动静，它是否能到达角色感官；远离、隔音等可能为false。仅感知范围，不制造一次响铃/震动，不更改免打扰。" },
        } },
      ...(!evolving ? { actorStates: { type: "array", maxItems: 100, description: "需要更新的受控角色身体、处境、随身物品和活动状态全文；不代写主观认识与意图。NPC记在worldState。", items: {
        type: "object", additionalProperties: false, required: ["actorId", "state"], properties: { actorId: { type: "string" }, state: prose } } },
      ...(initializing ? { botName: { type: "string", minLength: 1, maxLength: 64 } } : {}),
      outcome: { type: "object", additionalProperties: false, required: ["status"], properties: {
        status: { type: "string", enum: ["completed", "failed", "needs_input", "ongoing"], description: "completed为当下确已完成的短动作；needs_input为已到新的自主决定点并结束本次裁定；failed为实际受阻。仅actionPhase=start可用ongoing，表示持续过程刚开始、尚未到expectedEnd：只写已经发生的开始及当下处境，不预写未来完成。actionPhase=finish和应用操作不可返回ongoing。duration是估计时长，不要求短动作先空等；真正持续的过程仍必须到真实时钟到期后另行结算。" },
        reason: { type: "string", description: "可选内部裁定诊断，不代替可感知结果，不向角色展示。" },
        speechSpoken: { type: "boolean", description: "请求提供speech原话时必填。实际说出为true，否则false；true时在行动者感知中逐字保留原话，按开口当时的位置确定其他听众。" },
      } } } : {}),
    } },
  } };
}
