import { WORLD_EVOLUTION_AUTHORITY, WORLD_INCREMENTAL_AUTHORITY, type WorldResolutionOptions } from "./proposal.js";
import { WORLD_TIME_AUTHORITY } from "./time-boundary.js";

export type WorldTaskKind = "initialize" | "action" | "observe" | "evolve" | "arrive" | "leave" | "app_observe" | "app_action";

export interface WorldTaskPromptInput extends Omit<WorldResolutionOptions, "kind" | "repair"> {
  narrativeSystem: string;
  worldDef: string;
  botDef: string;
  kind: WorldTaskKind;
  actionPhase?: "start" | "finish";
  responseFormat?: "json_schema" | "json_object" | "tool";
}

const COMMON_AUTHORITY = "你是世界裁定者，没有跨任务聊天历史；本轮状态、作者定义和请求提供裁定依据。世界记忆仍是自然语言，不拆成实体数据库。字段与权限以本次输出契约为准，完整验证并同笔保存后才交付结果。用户自定义叙述要求原样保留，但不能扩大本次程序授予的事实权限。内部编号只是地址，不是人物身份或世界事实。stateAheadOfClock=true表示存档记录时间晚于当前程序时钟，不能据此推到未来或重演未来记录。";

const PHYSICAL_DEVICE_AUTHORITY = "事实归属：只裁定身体与物理环境。真人聊天由实际平台独占，本轮没有消息原文、通知或收发回执；不能据旧叙述、意图或猜测续写聊天内容、对象、已读/未读或发送成功，也不把网友推定为物理在场。软件界面、文件读写、屏幕亮暗/锁定、电量、手机闹钟设置和通知均由设备工具确认，未知时省略，不改写成‘没有’，不能为了交付通知补造手机震动。手机的位置、外壳和温度可以描述；‘刷手机/翻消息/摸手机确认闹钟’不能当作物理行动或已完成的经历，标题和建议也遵守同一边界。独立的机械/实体闹钟仍属于物理环境。既有设备原文只可原样保留，不能向角色透露隐藏记录。";

const PHYSICAL_INPUT_AUTHORITY = "pendingActions列出本次行动以外的待结算行动；phase=accepted只表示已受理，phase=ongoing表示已有开始裁定，均不证明行动已经完成，本次不得替它们推进过程或提前宣布成败。recentEvolution仅是最近几笔已提交外部经过的有限窗口，按时间排列，旧记录仍在日志；不要重演这些经过或把旧id当成本轮原因，持续事实以当前世界记忆为准。retainedDeviceRecords=true表示旧设备文件尾部已隐藏并由程序原样接回；只更新可见物理正文，不猜补隐藏记录或其中场景。phoneState和phoneHeld所属由phoneAuthority.actorId指定，不能混用访客等其他角色的手机；phoneAuthority.stateKnown=false表示兼容沿用输入的默认物理条件，不代表本次剧情已确立它们。phoneHeld是最新程序事实，优先于旧叙述的位置；true时手机已在持有者手中，不得仍写留在桌边、放在远处或据此推断角色没有注意手机。false只表示未持有，不说明放在哪里或角色正在做什么。";

const PERCEPTION_AUTHORITY = "按actorId分别投递实际能看见、听见或感受到的内容；在场名单不等于同处一地，不能复制全知状态、秘密或其他角色的私密处境。受控角色保留自己的意识和选择，只推进本次已授权意图，不替其他角色走动、接话或决定心情。角色提出睡觉是尝试入睡，不保证立刻睡着；睡眠与疲劳以历法、习惯、实际经过和身体状况为依据，wait/rest、压缩、天黑或没消息不证明困倦、睡着或醒来。perceptions.text写实际经过，不把同一段在世界记忆、角色状态和状态栏重抄。situation可省略，仅补正文未清楚表达的必要处境。opportunities也可省略；只在有新决定可做时给最多4个有区别的物理尝试方向，喝水、休息、收拾也可以，不强迫冒险，不为凑选项制造事件或打断真实睡眠、安静等待，不暗示已经选择或保证成功。省略保留仍有效旧建议，[]撤销，非空替换；不要靠省略保留已失效建议。";

const ACTION_PROGRESS = "以本次action.intent为结算单位：已授权意图内的常规步骤可连贯推进，不逐步索要许可，不追加目标。旧感知是起点，不重演旧动作；正文写这次实际结果，背景简写。普通可行尝试给实际进展；受阻则说明具体阻碍及现有条件下可行的下一步，未知解法可如实说明。当前请求实际达成才completed，即使更大目标未完或仍有后续建议；仅用力、准备、尝试或本轮生成结束不算达成。不能标放下物品已完成，正文却始终没松手。未实现用failed，正文、reason和状态一致。只有原意图未授权且会实质改变走向的选择才needs_input，并说明未决事项；不因可选后续或普通取物移动索要新决定。重复失败不自动加重疼痛、损伤或障碍；只有已确立的新物理原因才可恶化，不为延长行动层层增添困难。";
const ACTION_HISTORY = "recentActions是同一角色近期已结算记录，不是新指令。result.text是当时交付结果的物理视图，inCurrentPerception指向当前感知；omitted/reasonOmitted仅表示正文省略，不证明没有阻碍。status与reason是历史裁定及内部诊断，不覆盖结果正文；矛盾处以本轮执行事实和已知处境裁定。";
const CONSCIOUSNESS_AUTHORITY = "consciousness只记录实际意识：awake清醒、asleep睡眠、unconscious昏迷；缺失未知，省略保持原值，不从wait/rest、无消息或旧修辞猜测。已提交睡眠期间暂停自主思考，实际醒来明确写awake。";
const ACTION_START = "本次裁定角色请求的物理行动。描述当下实际经过、环境变化与NPC回应，不把意图直接当成事实，不按duration跳到未来。completed、failed、needs_input均结束本次行动，成败都向行动者交付可读感知，reason仅供内部诊断。";
const ACTION_FINISH = "本次结算已经开始的持续行动，承接已保存的开始及期间变化，不重演开场，不重新执行此前已发生的步骤。以当前程序时钟裁定实际结果，outcome.status只能为completed、failed或needs_input，不能再延期为ongoing。向行动者交付实际完成、受阻或新决定点的感知。";
const APP_AUTHORITY = "本次仅处理授权的虚构应用记录，不操作真实平台、外部操作系统或联网服务。perceptions仅返回请求actorId的一份私有应用输出，不表示角色已知；不描述身体行动、主观感受、操纵来源或其他角色，不给状态栏或剧情建议。真实聊天在架空世界也只能由实际平台提供，不能生成网友消息、通知或收发结果。精确保留既有文件原文；未知不能写成已成功。设备流程依据实际关注与控制方式决定是否交付给角色。";

/** Stable shared prefix, owner-authored prose intact, then only the current task contract.
 * The runtime calls this once per task, before appending any correction requests.
 */
export function buildWorldTaskPrompt(input: WorldTaskPromptInput): string {
  const output = input.responseFormat === "tool"
    ? "只调用一次resolve_world，不调用其他工具；参数必须符合本次工具契约。"
    : "只返回一个符合本次 JSON Schema 的完整 JSON 对象，不加工具调用封装、XML、代码围栏或解释。数组和对象直接嵌套，不序列化为字符串。";
  const prefix = [COMMON_AUTHORITY, output, "perceptions按接收者合并：每个actorId最多一项，其全部感知写在同一个text中；不拆成同一角色的多份感知。", input.narrativeSystem,
    `<world_definition>\n${input.worldDef}\n</world_definition>`,
    `<character_definition>\n${input.botDef}\n</character_definition>`, WORLD_TIME_AUTHORITY,
  ].join("\n\n");
  const app = input.kind === "app_observe" || input.kind === "app_action";
  const task: string[] = [`本次任务：${input.kind}${input.kind === "action" ? `，阶段：${input.actionPhase ?? "start"}` : ""}。`];
  if (app) {
    task.push(APP_AUTHORITY, input.kind === "app_observe"
      ? "只读已确立记录并返回应用输出。缺失时说明未知，不创建内容；不写世界状态、角色状态或outcome。"
      : "执行请求授权的虚构应用操作，必须返回完整worldState及明确outcome；保留精确文件内容，无变化时worldState返回原文，不能只声称成功而不保存。只能completed、failed或needs_input，不使用持续物理行动阶段。");
  } else {
    task.push(PHYSICAL_DEVICE_AUTHORITY, PHYSICAL_INPUT_AUTHORITY, PERCEPTION_AUTHORITY);
    if (input.kind === "initialize") task.push("依据作者定义与程序时钟建立最初世界，给botName、完整worldState、常驻角色actorStates及最初perceptions。不能用模型记忆猜今天，不能沿未发生的剧情虚构先前聊天或角色自主经历。");
    else if (input.kind === "action") {
      const finish = input.actionPhase === "finish" || input.speech === "finish";
      task.push(finish ? ACTION_FINISH : ACTION_START, ACTION_PROGRESS, ACTION_HISTORY);
      task.push("身体行动实际改变意识时在actorStates填consciousness；睡眠过程结束时裁定实际苏醒，不保留已经失效的asleep。");
      if (!finish && input.allowOngoing) task.push("只有确实持续且expectedEnd仍在未来的过程可ongoing；仅保存已发生的开始及当下处境，不预写未来完成。真实入睡可开始持续睡眠，到期后另行结算实际结果及苏醒；duration不是必须空等的命令。");
      if (input.speech === "start") task.push("请求speech是角色决定说出的逐字原话，outcome.speechSpoken必须明确是否实际开口；true时在行动者感知中逐字保留，并按当时位置与顺序给实际听众相应感知。先受阻或遇到决定点则false，不提前说未来台词。");
      else if (input.speech === "finish") task.push("原话已在开始阶段处理，此次不得再次说出；无需生成speechSpoken，程序固定为false。仍要保留已经发生的言语及其后果。");
      else task.push("请求没有提供speech，不能替受控角色创造台词；NPC可以自行发言。");
    } else if (input.kind === "observe") task.push("只呈现感官可及的环境或自身感受，不替角色走动、开门、翻容器或完成pendingActions，不因多看一次让物品改变。可以确立原先未描写但眼下确能感知的细节，须同步保存必要事实；sight仅视觉，self聚焦自身。向请求角色交付可读感知。");
    else if (input.kind === "evolve") task.push(WORLD_EVOLUTION_AUTHORITY);
    else if (input.kind === "arrive") task.push("裁定指定角色此次到访的实际位置、客观处境及可感知环境，保留已有世界连续性。只推进已授权的到访，不替其决定后续行动或向无感知条件的其他角色泄露身份与来历。向到访角色交付初到此处的感知。");
    else task.push("处理指定角色已授权的离场，保持其已发生的经历与原世界仍有效的事实。仅向确实能感知离场的在场角色投递；没有观察者时perceptions可为空，不替离场者继续行动或决定他人反应。");
    if (["initialize", "action", "evolve"].includes(input.kind)) task.push(CONSCIOUSNESS_AUTHORITY);
    if (input.kind !== "initialize") task.push(input.allowWorldPatch ? WORLD_INCREMENTAL_AUTHORITY : "输入worldState是当前自然语言记忆。仅长期事实变化时返回完整更新，保留有效事实、秘密、NPC目标和未完过程；无变化省略，不为整理重演事件。旧的无关细节留在历史日志，字数是软目标，不硬截断。没有worldDocument，不提交段落补丁。");
    if (input.kind !== "evolve" && input.kind !== "initialize") task.push("actorStates只在角色客观身体或处境变化时填写该角色state全文，无变化省略；NPC的记忆、目标与处境保留在世界记忆中。");
    if (input.allowPhoneState) task.push("本次允许更新手机物理条件；仅实际发生变化时填写完整phoneState，位置未知用null。它不执行拿放、软件或通知；持有姿态以phoneHeld为准。未更新不能视作自动恢复正常。" + (input.kind === "evolve" ? "phoneState须与phoneChangeIds成对提交，引用本轮实际外部物理原因。" : ""));
  }
  return `${prefix}\n\n<world_task_contract>\n${task.join("\n")}\n</world_task_contract>`;
}
