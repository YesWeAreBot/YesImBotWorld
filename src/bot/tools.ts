/** Bot-LLM 可用工具的定义（用于渲染置顶工具列表与 GBNF 语法约束） */

import type { PlatformOpsConfig } from "../config.js";

export interface BotToolDef {
  name: string;
  signature: string;
  /** Short discovery text. The complete description is returned by help on demand. */
  summary?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * 工具层级：模仿真实手机的操作逻辑，分层展开、按需可见。
 *
 * - core：常驻（世界/身体动作 + 收藏夹 + 手机的物理动作），进置顶工具列表；
 * - chat：打开聊天应用后可用（消息列表、好友/群、账号设置）；
 * - channel：进入某个频道页后可用（send 必须显式 id，其他允许省略的操作用当前频道）；
 * - group：进入的频道是群聊时，在 channel 层之上追加（群信息与群管理）。
 *
 * 非 core 层的工具不进置顶列表，在打开应用/进入频道时以事件展开用法，
 * 并动态加入允许列表与 GBNF 语法（关闭/离开后失效）。
 */
export type ToolLayer = "core" | "chat" | "channel" | "group";

const CHAT_LAYER = new Set([
  "check_msg", "select_channel", "list_friends", "list_groups", "handle_request", "channel_notify",
  "user_info", "view_avatar", "send_like", "delete_friend", "set_profile", "set_model_show", "ocr_image", "view_forward",
]);
const CHANNEL_LAYER = new Set([
  "send", "unsend", "react", "get_emoji_likes",
  "forward_msgs", "exit_forward", "poke",
  "read_channel",
]);
const GROUP_LAYER = new Set([
  "group_info", "list_members", "member_info", "group_honor", "group_files",
  "set_group_card", "set_group_name", "set_group_portrait", "send_group_notice",
  "get_group_notice", "set_essence", "get_essence_list", "group_sign", "group_ban",
  "group_whole_ban", "group_kick", "group_admin", "set_special_title", "group_leave",
]);

export function toolLayer(name: string): ToolLayer {
  if (CHAT_LAYER.has(name)) return "chat";
  if (CHANNEL_LAYER.has(name)) return "channel";
  if (GROUP_LAYER.has(name)) return "group";
  return "core";
}

const TOOL_SUMMARIES: Record<string, string> = {
  think: "简短内心独白；不行动、发言或推进时间。",
  wait: "暂停决策 n 个 TU，可被动静打断；不表示睡觉。",
  act: "物理行动或观察，speech 为当面原话；不操作软件，以实际结果为准，未完不重复。",
  rest: "暂停决策，默认 300 TU，可被打断；不是睡觉或等结果的必经步骤。",
  observe_device: "看实际可及设备的界面；不拿起、开机或打开应用。",
  reflect: "凭已感知事件整理认识；不创造经历，复杂证据要求见 help。",
  recall_growth: "回顾认识或亲历证据；重读不算新经历。",
  check_msg: "看最近会话；无本地记录时尝试少量历史预览。",
  select_channel: "进入完整 id 指定的会话；新消息会呈现，补读用 read_channel。",
  read_channel: "读最近 10 至 200 条消息；id 省略用当前会话，指定完整 id 则进入它。",
  put_down_phone: "结束使用手机，关闭当前应用和频道关注；不等于免打扰。",
  pick_up_phone: "拿起手机；不会自动打开应用或回到会话。",
  travel: "去指定世界作客，按当地历法与规则行动；go_home 返回。",
  go_home: "从异世界返回自己的世界。",
  channel_notify: "设置频道通知或限时免打扰；mute_seconds 为世界秒，0 取消限时，不删除消息。",
  phone_notifications: "查看通知、标记已读或清除卡片；通知权限在设置 App 调整。",
  open_app: "打开应用；切换会关闭前一个应用，聊天先到消息列表。",
  close_app: "关闭当前应用，其操作随之失效。",
  open_computer: "打开独立电脑会话，取得其可用操作。",
  close_computer: "结束电脑会话；远程连接断开不等于关闭主机。",
  check_gallery: "看收藏分类或媒体；表情包按表达态度选用，不必例行收藏。",
  check_media: "看已见媒体缓存；可直接发送，不必先收藏。",
  view_media: "细看最多 6 项明确媒体引用；看图不等于发送。",
  view_avatar: "按需查看指定账号在频道中的头像；不发送消息。",
  gallery_save: "收藏指定缓存媒体；备注是自己的用法，不证明发送者心意。",
  gallery_move: "调整完整文件名指定的收藏分类或备注。",
  gallery_remove: "移除完整文件名指定的收藏。",
  send: "发送原话；每次明确填写目标频道 id，从对应消息或频道列表照抄。引用用 reply_to 或 <quote id=\"消息ID\"/>，同目标自动去重。media 尾部附图；确认发出后不重发。",
  pick_media: "确认最多 9 项 media:N 或完整 gallery: 引用；不会发送，也非发送前必需。",
  cancel: "取消指定 tc_ID 尚未提交的部分；不撤销已发生的结果。",
};

/** Keep application discovery compact, while retaining the supplied full help verbatim. */
export function toolSummary(def: Pick<BotToolDef, "name" | "description" | "summary">): string {
  if (def.summary?.trim()) return def.summary.trim();
  const first = def.description.trim().split(/(?<=[。！？])|\n/u)[0]?.trim() ?? "";
  return Array.from(first).length > 120 ? Array.from(first).slice(0, 117).join("") + "…" : first;
}

export const BOT_TOOLS: BotToolDef[] = [
  {
    name: "help",
    signature: "help(tool?: string)",
    description: "查看当前能力清单；指定 tool 名称可读该工具的完整用法、参数与限制。帮助只解释用法，不执行所查询的操作，也不会使不可用工具生效。",
    summary: "查看当前能力；指定 tool 读详细用法，不执行操作。",
  },
  {
    name: "think",
    signature: "think(thought: string)",
    description: '记录一段内心独白（1 至 1200 字符），区分已知、回忆与猜测；不行动、发言、获取新信息或推进时间。文本调用也可写 think("内容")；原生调用仍用 {"thought":"内容"}。不要求每步先思考。',
    inputSchema: { type: "object", properties: { thought: { type: "string", minLength: 1, maxLength: 1200 } }, required: ["thought"], additionalProperties: false },
  },
  {
    name: "wait",
    signature: 'wait(n: number)',
    description: "等待 n 个 Time Unit（TU），暂停自主思考；重要通知可提前唤醒。结束时只获得当时的感知，不代表期间发生过其他经历。",
  },
  {
    name: "act",
    signature: 'act(description: string, target?: string, speech?: string, repeat?: boolean)',
    description: "在物理世界行动或主动观察。description 简短说明要做什么，不预设结果、描写剧情或替别人说话；target 可写对象名称或可辨认的描述，speech 是你决定当面说出的逐字原话。普通感知和行动结果会自动送达，不必反复观察。duration 是预计耗时，开始感知不等于完成；needs_input 表示已推进到新的决策点，要选择下一步。act 不读消息、操作软件或收发内容，请用设备工具；拿放手机用 pick_up_phone/put_down_phone。受理不证明已经开始，以后续感知为准。相同动作未返回时不要重复提交；若允许并行且确要再做一次才用 repeat: true。",
  },
  {
    name: "rest",
    signature: "rest(duration?: number)",
    description: "暂停自主思考，不是等待其他操作结果的必经步骤。duration 单位 TU，缺省或 0 为 300，不能为负数；重要动静可提前恢复。它不表示睡觉或醒来，身体休息用 act。",
  },
  {
    name: "observe_device",
    signature: 'observe_device(device: "phone" | "computer")',
    description: "查看实际可及的手机或电脑界面，并开始留意它；放下的手机在可见范围内也能看。不会拿起手机、打开应用、开机或连接远程桌面，关机只能看到关闭状态；设备不一定在身边，不能据此看见远处或被遮挡的屏幕。",
  },
  {
    name: "reflect",
    signature: 'reflect(kind: "relationship" | "commitment" | "preference" | "state" | "habit" | "trait", subject: string, statement: string, event_ids: string[], relation?: "support" | "counter" | "revise" | "retire", claim_id?: string, situation?: string, cues?: string[], subject_id?: string, behavior?: string, expires_at?: number, insight?: object)',
    description: "整理或修正关系、承诺、偏好、临时状态、习惯或性格。event_ids 引用实际感知事件；已有认识给 claim_id，relation 可为 support 补证、counter 反例、revise 修正、retire 停止沿用。subject_id 只能用已感知身份；聊天关系必填，并须有对方的非本人消息作证，自己的话或通知不算。state/habit/trait 必填 situation，cues 是适用情境词。state 须有近两世界小时的身体或当前注意界面证据，拿手机或通知不证明关注某人；expires_at 是未来 TU，默认从最新证据起两世界小时，最长一天，不能用旧事续期。habit/trait 必填 behavior，逐字摘取证据中共同的已完成自主动作：habit 至少 3 次跨一个世界日，trait 至少 6 次跨 3 种情境及七个世界日。relationship/commitment/preference 的 support/revise 必填 insight={dimension:稳定认识维度,significance:对以后理解或选择的意义,anchors:[{eventId,quote:证据原文}]}。日常经过、网页选项不等于偏好或承诺。其他 kind 不填 behavior。失败、重读、被迫行为不能凑次数，不用近义标题重复新建；没机会实践不算习惯消退。",
  },
  {
    name: "recall_growth",
    signature: 'recall_growth(scope?: "claims" | "evidence" | "all", event_ids?: string[], kind?: "relationship" | "commitment" | "preference" | "state" | "habit" | "trait", subject?: string, keyword?: string, claim_id?: string, n?: number)',
    description: "回顾认识与亲历。scope 默认 claims（含过期、停止沿用的历史，注意 active 和适用时段）；evidence 查亲历，可用 event_ids 精确重读；all 查两者。keyword、n 通用，kind/subject/claim_id 只筛选认识。原始事件 ID 可用于 reflect，重读不算新经历。",
  },
  {
    name: "check_msg",
    signature: "check_msg(n: number)",
    description: "查看最近有记录的 n 个频道及各自最新消息。本地无记录时，会在可用范围内预览少量群或好友及旧消息；旧记录不是新通知。感兴趣可 select_channel，也可用群/好友列表发现更多会话。",
  },
  {
    name: "select_channel",
    signature: 'select_channel(id: string)',
    description: "进入会话，照抄列表中的完整频道 id。进入后可读历史、发消息及进行频道操作，接下来一段时间内的新消息会直接呈现；无需重复进入，补读用 read_channel。本地无记录时会尝试允许范围内的平台历史，读取失败不代表没人聊天。刚收到消息的频道也可直接 send 快捷回复。",
  },
  {
    name: "read_channel",
    signature: "read_channel(n: number, id?: string)",
    description: "读取最近 n 条消息，n 为 10 至 200。id 省略时读取实际当前频道，没有当前频道则不能读取；不会自行改用最近通知的频道。指定 id 时照抄完整频道标识，先进入该频道再读取。本地为空且允许时尝试平台历史，不保证记录完整。",
  },
  {
    name: "put_down_phone",
    signature: "put_down_phone()",
    description: "结束使用手机，把它放到一边；当前应用会关闭，不再留意频道。这不是免打扰，允许通知的消息仍可能令设备发出信号，但是否感知取决于实际交付；仅有震动也不知道来源和内容。需要静音时，拿起手机、打开聊天应用、进入目标频道，用 channel_notify 设置。",
  },
  {
    name: "travel",
    signature: 'travel(world: string)',
    description:
      "穿越到另一个世界作客。world 填目标世界名。到达后你身处那个世界：你的行动由那个世界裁定、" +
      "时间按那边的历法流动；你自己的世界在你离开期间照常存在（无人在场时会沉睡，等你回来时你会得知期间的变化）。" +
      "手机与聊天照常可用。用 go_home 随时返回。作客要有作客的样子——尊重对方世界的规则。",
  },
  {
    name: "go_home",
    signature: "go_home()",
    description: "从异世界返回你自己的世界（只在你身处异世界时有意义）。",
  },
  {
    name: "pick_up_phone",
    signature: "pick_up_phone()",
    description: "拿起手机，留意正常消息通知；不会自动打开应用或回到会话，聊天须先 open_app，必要时 select_channel。",
  },
  {
    name: "channel_notify",
    signature: 'channel_notify(allow?: boolean, id?: string, mute_seconds?: number)',
    description: "聊天 App 的频道通知设置。allow 修改长期通知开关；仅填 mute_seconds>0 则限时免打扰，按世界秒计时，到期恢复原设置；mute_seconds=0 取消限时。id 省略为当前频道，否则照抄完整频道标识。消息和未读保留。",
  },
  {
    name: "phone_notifications",
    signature: 'phone_notifications(action?: "list" | "read" | "clear", id?: string)',
    description: "通知中心。list 查看通知和未读数量；read 标记已读，不表示读过正文；clear 仅清通知卡片，保留未读。id 省略时处理全部会话。通知模式与各应用权限在手机设置 App 内调整，具体频道免打扰在聊天 App 内调整。",
  },
  {
    name: "open_app",
    signature: 'open_app(name: string)',
    description: "打开手机应用并获得它的操作；聊天应用先显示消息列表。一次只能开一个应用，切换会关闭前一个，其操作随之失效。",
  },
  {
    name: "close_app",
    signature: "close_app()",
    description: "关闭当前打开的应用，它提供的操作随之失效。",
  },
  {
    name: "open_computer",
    signature: "open_computer()",
    description: "打开电脑会话并获得终端/文件或远程桌面的操作。电脑与手机独立，关闭手机应用不影响电脑；close_computer 结束会话。",
  },
  {
    name: "close_computer",
    signature: "close_computer()",
    description: "结束电脑会话，收起其工具。远程桌面会断开连接，不会关闭远端主机。",
  },
  {
    name: "check_gallery",
    signature: "check_gallery(category?: string)",
    description: "翻看收藏夹，category 省略看分类总览，填写后看该类媒体及备注（表情包、meme、截图、照片、未整理）。先确定自己想表达的态度或接话方式，再选表情包。备注是自己的选用线索，不代表原图事实或原发送者意图；未整理不是待办，发图无需先收藏。",
  },
  {
    name: "check_media",
    signature: 'check_media(n?: number, type?: "image" | "audio" | "video")',
    description: "查看聊天中见过的媒体缓存（只读），返回最近 n 项编号、大小、摘要，默认 10；type 可筛选类型。表情包按表达态度与适用语境选用，可直接发送，不必先收藏或解说画面。",
  },
  {
    name: "view_media",
    signature: 'view_media(media: string[])',
    description: "细看最多 6 项媒体，media 填明确引用，如 [\"media:12\", \"gallery:表情包/xx.png\"]。现有线索不够时再看，不必每次发图都查看。表情包像 emoji 用来表态、接话，可能用途不等于原发送者意图；不需要点评画面或收藏。",
  },
  {
    name: "gallery_save",
    signature: 'gallery_save(media_id: string, category: string, description: string, name?: string)',
    description: "按需收藏缓存媒体，media_id 如 \"media:12\"，category 为表情包 / meme / 截图 / 照片，name 可选。description 写自己的选用备注（如表达态度、适用及易误读语境），不推断原发送者意图。备注不会发给别人；收藏不是发图前提，也无需宣告。",
  },
  {
    name: "gallery_move",
    signature: 'gallery_move(name: string, category: string, description?: string)',
    description: "调整收藏分类，name 照抄完整文件名（如 \"未整理/xx.png\"），category 为表情包 / meme / 截图 / 照片。description 可更新自己的选用备注，省略则保留；不代表原发送者意图。未整理无需清空，分类也不要求看图解说。",
  },
  {
    name: "gallery_remove",
    signature: 'gallery_remove(name: string)',
    description: '把一个文件移出你的收藏夹。name 为 check_gallery 里看到的文件名（可带分类前缀，如 "meme/xx.png"）。',
  },
  {
    name: "send",
    signature: 'send(msg: string, id: string, media?: string[], reply_to?: string, at_sender?: boolean, resend?: boolean, confirm_long?: boolean, insist?: boolean)',
    description: "发送你决定说的原话。每次都必须填写目标频道 id，从要回复的消息所属频道或频道列表照抄完整 id；即使已在该会话也不能省略，不把消息 ID 或用户 ID 当作频道 ID。需要时会自动进入指定频道，无需先单独切群。发完仍可留在会话接着聊，不必每条消息后放下手机；有事离开或聊完再放下。图文混排在 msg 对应位置写 <media ref=\"media:12\"/>，名称、摘要、原图对应同一 media:N；media 参数只在正文末尾追加。reply_to 从目标频道对应正文末尾照抄完整消息 ID；它引用那条原文，不是泛指那个人，不从媒体编号或文字猜 ID；at_sender=false 可取消引用时提醒对方。当前支持时，@ 用 <at id=\"账号ID\"/>（裸打 @名字 不提醒），平台表情用 <face id=\"表情ID\"/>；引用也可在 msg 中用 <quote id=\"完整消息ID\"/>，标识照抄实际记录；name/text 只是引用预览。标签与 reply_to 同目标时合并一次引用，移除标签及其后空白；目标冲突则不发送。以发送回执为准，不因回显缺失重发；pick_media 不会发送。confirm_long/resend/insist 仅在对应提醒后，仍确有必要发送时使用。",
  },
  {
    name: "pick_media",
    signature: 'pick_media(media: string[])',
    description: "确认最多 9 项媒体引用，media 填 media:N 或完整 gallery:分类/文件名。返回标签可按位置写进 send.msg，或用 send.media 末尾追加；文件名含引号时用后者。保留图库完整引用，不换成同资源的 media:N。选中不等于已发，以 send 回执为准。表情包按想表达的态度选择，不要求收藏或配画面解说；不确定内容或表意时再 view_media。",
  },
  {
    name: "unsend",
    signature: 'unsend(id: string, msg_id: string)',
    description:
      '撤回一条你已经发出的消息。msg_id 是消息记录里 (msg:xxx) 标注的编号。' +
      "只能撤回自己发出不久的消息（平台通常限制两分钟内）。还没发出去的消息请用 cancel。",
  },
  {
    name: "react",
    signature: 'react(id: string, msg_id: string, emoji: string, remove?: boolean)',
    description:
      '给某条消息贴一个表情回应（不发新消息的轻量回应）。emoji 填一个 emoji 字符（如 "👍"）或平台表情编号；' +
      "msg_id 来自消息记录里的 (msg:xxx) 标注。remove: true 表示移除你之前贴上的回应。",
  },
  {
    name: "get_emoji_likes",
    signature: 'get_emoji_likes(id: string, msg_id: string, emoji: string)',
    description: "看看某条消息上某个表情回应都是谁贴的。emoji 与 react 的参数一致。",
  },
  {
    name: "forward_msgs",
    signature: 'forward_msgs(id: string, msg_ids: string[])',
    description:
      "把几条已有消息打包成一份聊天记录，合并转发到某个频道。" +
      "msg_ids 为要转发的消息编号列表（按顺序，来自消息记录里的 (msg:xxx) 标注）。",
  },
  {
    name: "view_forward",
    signature: 'view_forward(id: string)',
    description:
      '点开一份合并转发的聊天记录查看内容。id 来自消息里的 <forward id="…"/> 标签；' +
      "里面若还嵌着聊天记录，可以继续点开。看完记得 exit_forward 退出，别把记录里的内容当成当前聊天。",
  },
  {
    name: "exit_forward",
    signature: "exit_forward()",
    description: "退出正在查看的聊天记录，返回上一层（或回到当前聊天窗口）。",
  },
  {
    name: "ocr_image",
    signature: 'ocr_image(image: string)',
    description:
      '仔细辨认一张图片里的文字（逐字识别，适合看清截图、菜单、告示上的字）。image 填图片编号（如 "media:12"）或收藏夹文件（如 "gallery:menu.png"）。',
  },
  {
    name: "poke",
    signature: 'poke(id: string, user_id?: string)',
    description:
      "戳一戳：轻量地引起某人注意。私聊里戳对方（user_id 可省略）；群聊里必须给 user_id 指明戳谁。",
  },
  {
    name: "handle_request",
    signature: 'handle_request(request_id: string, approve: boolean, reason?: string)',
    description:
      '处理好友申请或入群邀请/申请。request_id 是手机通知里的请求编号（形如 "req_1"）。' +
      "approve 为 true 同意、false 拒绝；reason 可选（同意好友申请时作为备注，拒绝入群申请时作为理由）。",
  },
  {
    name: "list_friends",
    signature: "list_friends(cursor?: string, limit?: number, preview?: boolean)",
    description: "分页查看好友、完整频道 id 和近期消息预览。limit 默认 5，范围 1—10；preview 默认 true，false 只看目录；cursor 用返回值翻页。预览是历史片段，不是新喊话；感兴趣再 select_channel，不必遍历全部。",
  },
  {
    name: "user_info",
    signature: 'user_info(user_id: string)',
    description: "查看用户的公开资料（昵称、性别、年龄、签名等）。user_id 照抄消息或列表中的账号 ID。",
  },
  {
    name: "view_avatar",
    signature: 'view_avatar(id: string, user_id: string)',
    description: "按需查看一个人的头像。id 照抄完整频道 id，user_id 照抄消息中的账号 ID；优先展示平台提供的群内头像，否则明确展示账号头像。头像不是聊天消息，不代表本人外貌或当前态度。私聊遵循用户资料权限，群聊遵循成员资料权限。",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, user_id: { type: "string", minLength: 1 } }, required: ["id", "user_id"], additionalProperties: false },
  },
  {
    name: "send_like",
    signature: 'send_like(user_id: string, times?: number)',
    description: "给某人的资料卡点赞（一种示好方式，每人每天最多 10 次）。times 默认 1。",
  },
  {
    name: "delete_friend",
    signature: 'delete_friend(user_id: string)',
    description: "删除好友，恢复好友关系需要重新添加。",
  },
  {
    name: "set_profile",
    signature: 'set_profile(nickname?: string, signature?: string, avatar?: string)',
    description:
      '修改你的聊天账号资料：昵称、个性签名、头像。avatar 填图片编号（如 "media:12"）或收藏夹文件（如 "gallery:me.png"）。至少给一个参数。',
  },
  {
    name: "set_model_show",
    signature: 'set_model_show(model: string)',
    description: "修改你资料卡上显示的在线机型（别人看到的「xxx 在线」那种），填想显示的机型名。",
  },
  {
    name: "list_groups",
    signature: "list_groups(cursor?: string, limit?: number, preview?: boolean)",
    description: "分页查看已加入的群、完整频道 id、人数和近期消息预览。limit 默认 5，范围 1—10；preview 默认 true，false 只看目录；cursor 用返回值翻页。预览是历史片段，不表示有人找你；感兴趣再 select_channel，不必遍历全部。",
  },
  {
    name: "group_info",
    signature: 'group_info(id: string)',
    description: "查看某个群的基本信息（群名、人数等）。id 为群频道 id。",
  },
  {
    name: "list_members",
    signature: 'list_members(id: string)',
    description: "查看某个群的成员列表（名片、账号 id、身份），群主和管理员排在前面。",
  },
  {
    name: "member_info",
    signature: 'member_info(id: string, user_id: string)',
    description: "查看某个群成员的详细信息：群名片、昵称、身份、头衔、入群时间。",
  },
  {
    name: "group_honor",
    signature: 'group_honor(id: string)',
    description: "看看某个群的群荣誉：谁是龙王，谁有群聊之火、快乐源泉等头衔。",
  },
  {
    name: "group_files",
    signature: 'group_files(id: string, folder_id?: string)',
    description:
      "翻看某个群的群文件。默认列出根目录的文件与文件夹；folder_id 可进入某个文件夹（来自列表里的 folder:xxx 标注）。",
  },
  {
    name: "get_group_notice",
    signature: 'get_group_notice(id: string)',
    description: "查看某个群的群公告列表。",
  },
  {
    name: "get_essence_list",
    signature: 'get_essence_list(id: string)',
    description: "翻看某个群的精华消息列表。",
  },
  {
    name: "set_group_card",
    signature: 'set_group_card(id: string, card: string)',
    description: "修改你在某个群里显示的名称（群名片）。id 为群频道 id，card 为新名称。",
  },
  {
    name: "set_group_name",
    signature: 'set_group_name(id: string, name: string)',
    description: "修改群名（需要管理员权限）。",
  },
  {
    name: "set_group_portrait",
    signature: 'set_group_portrait(id: string, image: string)',
    description: '修改群头像（需要管理员权限）。image 填图片编号（如 "media:12"）或收藏夹文件。',
  },
  {
    name: "send_group_notice",
    signature: 'send_group_notice(id: string, content: string)',
    description: "在群里发布公告（需要管理员权限）。",
  },
  {
    name: "set_essence",
    signature: 'set_essence(msg_id: string, remove?: boolean)',
    description:
      "把一条群消息设为群精华（需要管理员权限）。msg_id 来自消息记录里的 (msg:xxx) 标注；remove: true 表示移出精华。",
  },
  {
    name: "group_sign",
    signature: 'group_sign(id: string)',
    description: "在群里打卡（日常签到）。",
  },
  {
    name: "group_ban",
    signature: 'group_ban(id: string, user_id: string, minutes: number)',
    description: "禁言某个群成员 minutes 分钟（需要管理员权限）。minutes 为 0 表示解除禁言。",
  },
  {
    name: "group_whole_ban",
    signature: 'group_whole_ban(id: string, enable: boolean)',
    description: "开启或关闭全员禁言（需要管理员权限）。",
  },
  {
    name: "group_kick",
    signature: 'group_kick(id: string, user_id: string, block?: boolean)',
    description: "把某个成员移出群（需要管理员权限）。block: true 表示同时拒绝其再次加群。这是很重的动作，请慎重。",
  },
  {
    name: "group_admin",
    signature: 'group_admin(id: string, user_id: string, enable: boolean)',
    description: "设置或取消某个成员的群管理员身份（需要你是群主）。",
  },
  {
    name: "set_special_title",
    signature: 'set_special_title(id: string, user_id: string, title: string)',
    description: "授予某个群成员专属头衔（需要你是群主）。title 为空字符串表示移除头衔。",
  },
  {
    name: "group_leave",
    signature: 'group_leave(id: string)',
    description: "退出群聊，再加入可能需要邀请或批准。",
  },
  {
    name: "cancel",
    signature: "cancel(id: string)",
    description: '取消尚未提交的工具调用（如还没开始发送的消息）。已提交的操作不能保证撤销，真实结果仍会返回。id 是工具调用编号（形如 "tc_12"）。',
  },
].map(def => ({ ...def, summary: def.summary ?? TOOL_SUMMARIES[def.name] ?? toolSummary(def) }));

/** 全部工具名（宽松解析用的允许列表上限） */
export const BOT_TOOL_NAMES = BOT_TOOLS.map((t) => t.name);

/** 手机里已安装的应用（用于 open_app 的描述） */
export interface AppInfo {
  name: string;
  description: string;
}

/** 按配置过滤实际可用的工具（如未配置 TTS 时不提供 send_voice、平台扩展操作默认关闭） */
export function availableTools(opts: {
  tts: boolean;
  ops: PlatformOpsConfig;
  apps?: AppInfo[];
  /** messaging.botManagedNotifyChannels：Bot 可自管通知频道列表 */
  notifyManaged?: boolean;
  /** bot.blockingAct：act 专注模式（上一个动作未完成前拒绝新的 act） */
  blockingAct?: boolean;
  /** bot.waitRateThreshold > 0: wait/rest share the autonomous pause budget. */
  waitConfirm?: boolean;
  /** bot.disableWait：移除 wait 工具 */
  disableWait?: boolean;
  /** bot.thinkEnabled: an independent capability switch, enabled when omitted. */
  thinkEnabled?: boolean;
  /** Unconditional phone access is the default; disabled preserves physical constraints. */
  unrestrictedPhone?: boolean;
  /** bot.ignoreSendDuration：send 系工具的 duration 被忽略，消息立即发出 */
  ignoreSendDuration?: boolean;
  /** crossing.worlds 中允许 Bot 主动前往的世界（travel 工具的目的地列表） */
  crossingWorlds?: { name: string; note?: string }[];
  /** crossing.worlds 配置了任何世界（go_home 保留，以便被强制送出后能自己回来） */
  crossingConfigured?: boolean;
}): BotToolDef[] {
  const tools = BOT_TOOLS.filter((t) => {
    switch (t.name) {
      case "think":
        return opts.thinkEnabled !== false;
      case "wait":
        return !opts.disableWait;
      case "travel":
        return (opts.crossingWorlds?.length ?? 0) > 0;
      case "go_home":
        return !!opts.crossingConfigured;
      case "channel_notify":
        return !!opts.notifyManaged;
      case "unsend":
        return opts.ops.recall;
      case "react":
        return opts.ops.react;
      case "get_emoji_likes":
        return opts.ops.emojiLikes;
      case "forward_msgs":
        return opts.ops.forwardMsgs;
      case "ocr_image":
        return opts.ops.ocrImage;
      case "poke":
        return opts.ops.poke;
      case "handle_request":
        return opts.ops.handleRequests;
      case "list_friends":
        return opts.ops.listFriends;
      case "user_info":
        return opts.ops.userInfo;
      case "view_avatar":
        return opts.ops.userInfo || opts.ops.memberInfo;
      case "send_like":
        return opts.ops.sendLike;
      case "delete_friend":
        return opts.ops.deleteFriend;
      case "set_profile":
        return opts.ops.profile;
      case "set_model_show":
        return opts.ops.modelShow;
      case "list_groups":
        return opts.ops.listGroups;
      case "group_info":
        return opts.ops.groupInfo;
      case "list_members":
        return opts.ops.listMembers;
      case "member_info":
        return opts.ops.memberInfo;
      case "group_honor":
        return opts.ops.groupHonor;
      case "group_files":
        return opts.ops.groupFiles;
      case "set_group_card":
        return opts.ops.groupCard;
      case "set_group_name":
        return opts.ops.groupName;
      case "set_group_portrait":
        return opts.ops.groupPortrait;
      case "send_group_notice":
        return opts.ops.groupNotice;
      case "get_group_notice":
        return opts.ops.getGroupNotice;
      case "set_essence":
        return opts.ops.essence;
      case "get_essence_list":
        return opts.ops.essenceList;
      case "group_sign":
        return opts.ops.groupSign;
      case "group_ban":
        return opts.ops.groupBan;
      case "group_whole_ban":
        return opts.ops.groupWholeBan;
      case "group_kick":
        return opts.ops.groupKick;
      case "group_admin":
        return opts.ops.groupAdmin;
      case "set_special_title":
        return opts.ops.specialTitle;
      case "group_leave":
        return opts.ops.groupLeave;
      default:
        return true;
    }
  });
  // 各分支按顺序叠加
  return tools.map((t) => {
    let def = t;
    if (def.name === "pick_up_phone" && opts.unrestrictedPhone !== false) {
      def = { ...def,
        description: "拿到可正常使用的手机；丢失、损坏或距离不阻止拿取。不会自动打开应用或回到会话，聊天须先 open_app，必要时 select_channel。",
        summary: "拿到可正常使用的手机，不受丢失、损坏或距离限制；不自动打开应用或回到会话。",
      };
    } else if (def.name === "pick_up_phone") {
      def = { ...def, description: "手机可达时拿起；不恢复遗失或损坏的设备，不自动打开应用或回到会话。",
        summary: "拿起可及手机，不修复设备或打开应用。" };
    }
    if ((def.name === "wait" || def.name === "rest") && opts.waitConfirm) {
      def = {
        ...def,
        signature: def.name === "wait" ? "wait(n: number, confirm?: boolean)" : "rest(duration?: number, confirm?: boolean)",
        description:
          def.description +
          "近期 wait/rest 过多时会先要求确认；确需继续，紧接着用同一工具加 confirm: true 确认该次。",
        summary: toolSummary(def) + "频繁暂停时须按提示 confirm。",
      };
    }
    if (def.name === "rest" && opts.disableWait) {
      def = { ...def, description: def.description + "wait 已关闭，不要用连续 rest 代替空等消息。", summary: toolSummary(def) + "不要连续空等消息。" };
    }
    // blockingAct 专注模式：上一个动作未完成前新的 act 会被拒绝（不可绕过）——只有开启时才在描述里说明
    if (def.name === "act" && opts.blockingAct) {
      def = {
        ...def,
        description:
          def.description +
          "当前一次只能专注一个 act，须等结果后再行动，repeat 不能绕过。",
        summary: toolSummary(def) + "当前一次只可有一个 act。",
      };
    }
    // open_app 的描述里列出已安装的应用
    if (def.name === "open_app" && opts.apps?.length) {
      def = {
        ...def,
        description:
          def.description +
          `已安装的应用：${opts.apps.map((a) => `${a.name}（${a.description}）`).join("、")}。`,
        summary: toolSummary(def) + `应用：${opts.apps.map(a => a.name).join("、")}。`,
      };
    }
    if (def.name === "send" && opts.ignoreSendDuration) {
      def = { ...def, description: def.description + "当前忽略发送耗时，duration 不会延后发送或留下取消窗口。", summary: toolSummary(def) + "忽略发送耗时，无打字取消窗口。" };
    }
    // travel 的描述里列出可去的世界
    if (def.name === "travel" && opts.crossingWorlds?.length) {
      def = {
        ...def,
        description:
          def.description +
          `你能前往的世界：${opts.crossingWorlds
            .map((w) => `「${w.name}」${w.note?.trim() ? `（${w.note.trim()}）` : ""}`)
            .join("、")}。`,
        summary: toolSummary(def) + `目的地：${opts.crossingWorlds.map(w => w.name).join("、")}。`,
      };
    }
    return def;
  });
}

/** Render schema types as a parameter signature, not a second block of JSON tutorials. */
function schemaType(schema: unknown): string {
  if (schema === true || schema === undefined) return "unknown";
  if (schema === false) return "never";
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "unknown";
  const s = schema as Record<string, unknown>;
  let type: string;
  if (Object.hasOwn(s, "const")) type = JSON.stringify(s.const);
  else if (Array.isArray(s.enum)) type = s.enum.map(value => JSON.stringify(value)).join(" | ");
  else if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) type = ((s.anyOf ?? s.oneOf) as unknown[]).map(schemaType).join(" | ");
  else if (s.type === "array") type = `Array<${schemaType(s.items)}>`;
  else if (s.type === "object" || s.properties) {
    type = `{ ${schemaParameters(s)}${s.additionalProperties === false ? "" : "; …"} }`;
  } else type = Array.isArray(s.type) ? s.type.join(" | ") : typeof s.type === "string" ? s.type : "unknown";
  // Keep validation constraints observable (including future schema extensions), but omit prose.
  const covered = new Set(["type", "const", "enum", "anyOf", "oneOf", "items", "properties", "required", "additionalProperties", "description", "title", "examples", "$comment"]);
  const constraints = Object.entries(s).filter(([key]) => !covered.has(key));
  if (s.additionalProperties && typeof s.additionalProperties === "object") constraints.push(["additionalProperties", s.additionalProperties]);
  return type + (constraints.length ? `[${constraints.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")}]` : "");
}

function schemaParameters(schema: Record<string, unknown>): string {
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(value => typeof value === "string") as string[] : []);
  const names = [...new Set([...Object.keys(props), ...required])];
  return names.map(name => `${name}${required.has(name) ? "" : "?"}: ${schemaType(props[name])}`).join(", ");
}

export function toolSignature(def: BotToolDef): string {
  return def.inputSchema ? `${def.name}(${schemaParameters(def.inputSchema)})` : def.signature;
}

export function renderToolsText(tools: readonly BotToolDef[] = BOT_TOOLS): string {
  return tools.map(def => {
    const constraints = def.inputSchema && Object.fromEntries(Object.entries(def.inputSchema).filter(([key]) =>
      !["type", "properties", "required", "description", "title", "examples", "$comment"].includes(key)));
    return `- ${toolSignature(def)}\n  ${toolSummary(def)}${constraints && Object.keys(constraints).length ? "\n  参数限制：" + JSON.stringify(constraints) : ""}`;
  }).join("\n");
}

/** Only explicit help or a relevant failed call should insert the complete tutorial. */
export function renderToolHelp(def: BotToolDef): string {
  return `${def.signature}\n${def.description}${def.inputSchema ? "\n参数 JSON Schema（参数结构以此为准）：" + JSON.stringify(def.inputSchema) : ""}`;
}

export function renderToolHelpIndex(defs: readonly BotToolDef[]): string {
  return "当前可用能力（help(tool) 查看完整用法）：\n" + renderToolsText(defs);
}
