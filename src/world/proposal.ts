import type { ChatToolDef } from "../llm/chat.js";
import { worldPatchSchema } from "./document.js";

/** Request-owned rules also accompany custom narrative prose prompts. */
export const WORLD_INCREMENTAL_AUTHORITY = `worldDocument是同一份自然语言记忆的分段视图，revision和段落id只是本轮编辑地址，不是实体或角色可知事实。长期事实变化时优先worldPatch:{revision,edits}：照抄本轮revision，replace替换指定整段，delete删除失效段，append按顺序追加新段；每个原文id最多修改一次，未改文字保留。无变化省略补丁；需要整体重写时可回退完整worldState，二者不能同时输出。保留有效事实、秘密、NPC目标和未完过程，已无关细节留在历史；worldMemory.targetChars是软目标，不硬截断。补丁先还原成完整候选，与角色状态、来源、感知全部校验并同笔保存后才发生；不输出编辑地址作剧情，不为整理捏造事件。`;

export interface WorldResolutionOptions {
  kind?: string;
  allowWorldPatch?: boolean;
  allowOngoing?: boolean;
  allowPhoneState?: boolean;
  speech?: "start" | "finish" | false;
  repair?: boolean;
}

type ProposalSchema = Record<string, unknown> & { properties?: Record<string, ProposalSchema>; required?: string[] };

/** Build a task-specific contract without sharing mutable schemas across requests.
 * Omitting opts retains the historical public schema for embedders and old callers.
 */
export function worldResolutionTool(initializing = false, evolving = false, opts?: WorldResolutionOptions): ChatToolDef {
  const tool = legacyWorldResolutionTool(initializing || opts?.kind === "initialize", evolving || opts?.kind === "evolve");
  if (!opts) return tool;
  const parameters = tool.function.parameters as ProposalSchema;
  const properties = parameters.properties!;
  const init = initializing || opts.kind === "initialize";
  const evolution = !init && (evolving || opts.kind === "evolve");
  const app = opts.kind === "app_action" || opts.kind === "app_observe";
  const action = opts.kind === "action" || opts.kind === "app_action";
  const perception = properties.perceptions!.items as ProposalSchema;
  // Descriptions are part of the model input too: removing a property while keeping
  // unrelated task instructions in the remaining fields defeats specialization.
  tool.function.description = app
    ? opts.kind === "app_observe" ? "返回请求角色的私有虚构应用读取结果，不写状态或执行操作。" : "提交授权虚构应用操作的完整状态与私有回执，不操作真实平台。"
    : evolution ? "提交外部世界经过、实际来源及角色可感知的部分。" : init ? "建立初始自然语言世界、角色状态与最初感知。" : "提交本次物理世界裁定及实际感知，无变化的状态字段省略。";
  properties.perceptions!.description = app ? "仅请求actorId的一份私有应用输出，由设备流程决定实际交付。" : "按actorId分别给实际感知；不复制全知状态，无接收者感知时可为空。";
  perception.properties!.text!.description = app ? "应用实际可提供的内容，保留精确原文，不附身体剧情。" : "本角色实际感知的经过、环境细节与NPC回应；足够理解进展即可，不重抄状态或行动建议。";
  if (perception.properties!.situation) perception.properties!.situation!.description = "可省略；只补正文未清楚表达的必要可知处境，不重复整段剧情或泄露秘密。";
  if (perception.properties!.opportunities) perception.properties!.opportunities!.description = "可省略，只有新的实际选择才更新，最多4项，不为凑数制造事件。物理尝试方向须有区别，不暗示角色已选择或保证成功。省略保留有效旧建议，[]撤销，非空替换；不含软件、通知或真人聊天操作。";
  properties.worldState!.description = app ? "授权应用操作后的完整世界及文件原文，无变化返回原文；不能只声明写入成功。" : init ? "初始完整自然语言世界记忆，包含有效事实、秘密、NPC目标与未完过程。" : "更新后的完整自然语言世界记忆，保留仍有效的事实、秘密、NPC目标与未完过程；无长期变化省略，既有设备原文仅逐字保留。";
  if (properties.actorStates) properties.actorStates.description = init ? "常驻角色的初始客观身体与处境全文。" : "可省略；仅客观身体或处境变化的角色提供state全文，不写主观意图或重复感知。";
  if (properties.externalChanges) properties.externalChanges.description = "本轮实际外部原因的局部id及经过；可以只记日志，持续事实变化再更新世界记忆，不替受控角色决定或结算行动。";
  if (properties.actorEffects) properties.actorEffects.description = "可省略；实际外因改变身体或处境时，给受影响角色state全文并引用本轮changeIds，不代替角色作决定。";
  properties.phoneState!.description = "可省略；本次真实物理原因改变手机条件时提供完整状态，不生成通知、软件操作或拿放动作，缺省不表示恢复正常。";
  if (app) {
    delete perception.properties!.situation;
    delete perception.properties!.opportunities;
    delete properties.actorStates;
  }
  if (app || opts.allowPhoneState === false) {
    delete properties.phoneState;
    delete properties.phoneChangeIds;
  }
  if (opts.kind === "app_observe") delete properties.worldState;
  if (init || evolution || opts.kind && !action) delete properties.outcome;
  if (action && !init && !evolution) parameters.required = [...parameters.required!, "outcome"];
  if (opts.kind === "app_action") parameters.required = [...parameters.required!, "worldState"];
  const outcome = properties.outcome;
  if (outcome) {
    const fields = outcome.properties!;
    fields.status!.enum = ["completed", "failed", "needs_input", ...(opts.allowOngoing && !app && opts.speech !== "finish" ? ["ongoing"] : [])];
    fields.status!.description = app ? "授权应用操作已完成、受阻或需要新的输入。" : "当下已完成、实际受阻或到达新的自主决定点；仅声明ongoing时可报告持续过程开始，不能预写未来完成。";
    if (opts.speech === "start" && !app) {
      outcome.required = [...outcome.required!, "speechSpoken"];
      fields.speechSpoken!.description = "本次是否实际说出请求speech；true时行动者感知须逐字保留，并给实际听众感知。";
    } else delete fields.speechSpoken;
  }
  if (opts.allowWorldPatch && !init && !app) {
    properties.worldPatch = structuredClone(worldPatchSchema);
    properties.worldState!.description = "仅当需要整体重写或无法用本轮段落补丁表达时使用的全文回退；通常优先worldPatch，无变化两者都省略。" + properties.worldState!.description;
    parameters.not = { required: ["worldState", "worldPatch"] };
  }
  if (opts.repair) {
    const required = [...parameters.required!];
    const set: ProposalSchema = { type: "object", additionalProperties: false, minProperties: 1, maxProperties: 32,
      properties: structuredClone(properties), ...(parameters.not ? { not: structuredClone(parameters.not) } : {}) };
    properties.repair = { type: "object", additionalProperties: false, minProperties: 1,
      description: "仅修正当前未提交草稿。set按整个顶层字段替换，不作嵌套合并；remove移除草稿中的错误字段，也可移除未声明的字段名。不得与完整提案同时提交，修正后仍须完整验证。",
      properties: {
        set,
        remove: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 80,
          not: { enum: ["__proto__", "constructor", "prototype", "repair"] } } },
      },
    };
    delete parameters.required;
    parameters.oneOf = [
      { required, not: { required: ["repair"] } },
      { required: ["repair"], maxProperties: 1 },
    ];
  }
  return tool;
}

/** Exposes the same contract for repair construction and protocol inspection. */
export function worldResolutionSchema(initializing = false, evolving = false, opts?: WorldResolutionOptions): Record<string, unknown> {
  return worldResolutionTool(initializing, evolving, opts).function.parameters;
}

/** Kept outside editable prose prompts: this operation cannot become a second actor loop. */
export const WORLD_EVOLUTION_AUTHORITY = `kind=evolve只发展外部世界：从evolutionSinceTU承接已提交经过，以elapsedEvolutionWorldSeconds判断NPC、天气、环境或远处事件的进展。输入的受控角色不是本轮行动者；默认保持状态，不能替其决定、转移注意、困倦/入睡/醒来或结算pendingActions。实际外因如雨水、碰撞可以影响身体，但不能为唤醒角色制造原因。externalChanges登记本轮原因的局部id和真实经过；actorEffects仅在客观身体或处境受影响时给完整state及changeIds，不能写actorStates或outcome。每份perceptions必须有text并引用本轮changeIds，只投递接收者实际感知的部分，远处秘密不泄露。短暂经过可只存原因日志，持续事实变化才更新世界记忆。没有外部变化时perceptions:[]并省略状态，不重演近期已发生的事件，不为选项打断安静。nextIntervalTU仅建议下一次检查间隔，不推进当前时间或授权未来事件。`;

/** Only delivery addresses and execution status are structured; world content is prose. */
function legacyWorldResolutionTool(initializing = false, evolving = false): ChatToolDef {
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
