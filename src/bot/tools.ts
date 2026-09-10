/** Bot-LLM 可用工具的定义（用于渲染置顶工具列表与 GBNF 语法约束） */

import type { PlatformOpsConfig } from "../config.js";

export interface BotToolDef {
  name: string;
  signature: string;
  description: string;
}

/**
 * 工具层级：模仿真实手机的操作逻辑，分层展开、按需可见。
 *
 * - core：常驻（世界/身体动作 + 收藏夹 + 手机的物理动作），进置顶工具列表；
 * - chat：打开聊天应用后可用（消息列表、好友/群、账号设置）；
 * - channel：进入某个频道页后可用（发消息、撤回、贴表情……id 缺省为当前频道）；
 * - group：进入的频道是群聊时，在 channel 层之上追加（群信息与群管理）。
 *
 * 非 core 层的工具不进置顶列表，在打开应用/进入频道时以事件展开用法，
 * 并动态加入允许列表与 GBNF 语法（关闭/离开后失效）。
 */
export type ToolLayer = "core" | "chat" | "channel" | "group";

const CHAT_LAYER = new Set([
  "check_msg", "select_channel", "list_friends", "list_groups", "handle_request",
  "user_info", "send_like", "delete_friend", "set_profile", "set_model_show", "ocr_image",
]);
const CHANNEL_LAYER = new Set([
  "send", "pick_media", "unsend", "react", "get_emoji_likes",
  "forward_msgs", "view_forward", "exit_forward", "poke", "channel_notify",
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

export const BOT_TOOLS: BotToolDef[] = [
  {
    name: "wait",
    signature: 'wait(n: number)',
    description:
      "等待 n 个 Time Unit。你会暂停思考，直到等待结束（世界会告诉你期间发生了什么）。收到重要通知可能会提前唤醒你。",
  },
  {
    name: "act",
    signature: 'act(description: string, target?: string, observationId?: string, speech?: string, repeat?: boolean)',
    description:
      "在世界中做一件事，用自然语言描述。description 只写**行动本身**——简短、明确地说你" +
      "要做什么（如「去厨房泡一杯咖啡」「走到窗边看看外面」），**不要写剧情**：不要描写环境、心情，" +
      "也不要在行动里预设结果或替别人说话。结果由世界裁定，会在动作完成时以事件返回。记得给出合理的 duration；作用于具体对象时，target 填最近 observe 返回的 observedId，observationId 可填对应观察编号。" +
      "要在物理世界开口说话时，speech 写你自己决定说出的逐字原话；世界只负责传播和他人的反应，不替你生成台词。" +
      "上一个相同的动作还在进行中时，重复的 act 会被拦截（结果会自动送达，无需再发起一次）；确实要同时再做一遍时加 repeat: true。",
  },
  {
    name: "rest",
    signature: "rest(duration?: number)",
    description:
      "按自己的身体状态和生活安排休息一段时间，duration 以 TU 为单位。有重要动静可提前醒来。记忆整理独立进行，不需要为了整理记忆而睡觉。",
  },
  {
    name: "check_status",
    signature: 'check_status(target: "self" | "world", full?: boolean)',
    description:
      "兼容旧用法：self 观察自身，world 观察周围；与 observe 一样只提供你此刻能感知到的信息。不会提供世界全局状态或他人的秘密。",
  },
  {
    name: "observe",
    signature: "observe(target?: string, modality?: string)",
    description: "观察自己或周围。target 可填 self 或最近观察到的 observedId；modality 可选 all（默认，周围视觉与台词）、sight（视觉）或 self（自身状态）。返回可感知实体、属性及观察句柄；看不到的对象和秘密不会出现。行动时可把 observedId 交给 act 的 target。",
  },
  {
    name: "reflect",
    signature: 'reflect(kind: "relationship" | "commitment" | "preference", subject: string, statement: string, event_ids: string[], relation?: "support" | "counter" | "revise", claim_id?: string)',
    description: "根据亲身感知的经历形成或修正认识：关系、承诺、偏好。event_ids 引用意识流 event 的 id，至少一个；无法引用未感知的事。新认识保持暂定；已有认识用 claim_id，support 补证据、counter 记录反例、revise 修正判断。重复观察同一来源不会算新证据；单次经历不自动变成永久人格。",
  },
  {
    name: "recall_growth",
    signature: 'recall_growth(kind?: "relationship" | "commitment" | "preference", subject?: string, keyword?: string, claim_id?: string, n?: number)',
    description: "回顾自己的关系、承诺和偏好，包括原始感知证据、反例与过去的修正。它们是可修正的主观认识，不是世界真相或不可改变的性格。",
  },
  {
    name: "check_time",
    signature: "check_time()",
    description:
      "看一眼现在几点了（看手表、掏手机、找附近的时钟）。能否看到、通过什么看到由世界决定——身边没有计时工具时可能失败。",
  },
  {
    name: "check_msg",
    signature: "check_msg(n: number)",
    description: "刷新消息列表：列出最近活跃的 n 个频道及各自的最新一条消息。",
  },
  {
    name: "select_channel",
    signature: 'select_channel(id: string)',
    description:
      '点进消息列表中的一个频道（id 格式为 "platform:channelId"）。进入频道页后能进行频道内的完整操作（发消息、撤回、贴表情等，进入时会看到可用操作）。' +
      "此后的一段时间内你会持续留意这个频道，它的新消息会直接呈现在你眼前（发消息给某频道也有同样效果）。" +
      "对刚来新消息的频道，也可以不进频道页、直接发消息快捷回复。已经在这个频道里时无需再次点进；想刷新/看更多消息用 read_channel。",
  },
  {
    name: "read_channel",
    signature: "read_channel(n: number)",
    description:
      "读当前所在频道最近 n 条消息（n 至少 10，调大看更早的历史消息）。只看消息、不切换频道。",
  },
  {
    name: "put_down_phone",
    signature: "put_down_phone()",
    description:
      "把手机放到一边：关闭打开着的应用，不再留意任何频道。之后再有消息你只会感觉到手机震了一下" +
      "（不呈现内容也不知道来自哪里），直到你用 pick_up_phone 拿起手机。想清静时用。",
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
    description: "把手机拿回手里：恢复正常的消息通知（不会自动打开应用）。",
  },
  {
    name: "channel_notify",
    signature: 'channel_notify(allow: boolean, id?: string)',
    description:
      "开启或关闭一个频道的消息通知（免打扰）。关闭后这个频道的新消息不再提醒你（消息仍会入库，翻记录可见）。" +
      "id 缺省为当前频道。",
  },
  {
    name: "open_app",
    signature: 'open_app(name: string)',
    description:
      "打开手机里的一个应用。应用的操作按需展开：打开聊天应用会看到消息列表，并解锁查看好友/群、进入频道等操作；" +
      "打开其他应用会看到它提供的操作。展开的操作即刻可以像普通能力一样调用，" +
      "一次只能打开一个应用，打开新的会自动关掉上一个（其操作随之失效）。",
  },
  {
    name: "close_app",
    signature: "close_app()",
    description: "关闭当前打开的应用，它提供的操作随之失效。",
  },
  {
    name: "open_computer",
    signature: "open_computer()",
    description:
      "打开你自己的电脑：一台与手机平级的另一台设备，不是手机里的应用。打开后电脑上的工具会展开" +
      "（取决于它的实现方式：终端/文件管理器，或远程桌面的屏幕/鼠标/键盘），" +
      "关闭手机里的应用不影响电脑，反之亦然；用 close_computer 关机后这些工具随之失效。",
  },
  {
    name: "close_computer",
    signature: "close_computer()",
    description: "关闭你的电脑（关机），它提供的工具随之失效。",
  },
  {
    name: "check_gallery",
    signature: "check_gallery(category?: string)",
    description:
      "翻看你的收藏夹。收藏夹按分类存放：表情包、meme、截图、照片、未整理。不带参数看总览（各分类的数量），" +
      "带 category 打开某一类，列出每项的内容和描述（挑中后用 pick_media 插入输入框）。" +
      "发图先来这里挑；「未整理」里是主人放进来还没归类的东西，有空时看看（view_media）并用 gallery_move 整理。",
  },
  {
    name: "check_media",
    signature: 'check_media(n?: number, type?: "image" | "audio" | "video")',
    description:
      "翻看媒体缓存：你在聊天里见过的图片、语音、视频都留在缓存里（只读，不能删改）。" +
      "列出最近 n 项（默认 10）的编号、大小与内容摘要。用于翻找没存进收藏夹的东西；想留下的用 gallery_save 收藏。",
  },
  {
    name: "view_media",
    signature: 'view_media(media: string[])',
    description:
      '把几张图/几段媒体拿起来仔细看看。media 填媒体编号或收藏夹文件（如 ["12", "gallery:表情包/xx.png"]，最多 6 个）。' +
      "**发图前拿不准内容时，先用它确认再发**——光凭文件名和一句摘要挑图很容易发错。整理「未整理」时也先用它看清内容。",
  },
  {
    name: "gallery_save",
    signature: 'gallery_save(media_id: string, category: string, description: string, name?: string)',
    description:
      '把缓存里的媒体存进你的收藏夹（比如看到喜欢的表情包就存下来）。media_id 为媒体编号（如 "12"）；' +
      "category 必须是：表情包 / meme / 截图 / 照片；description 用你自己的话写清这是什么、什么梗/情绪、适合什么场合发" +
      "——以后挑图全靠这段描述，别偷懒。name 可选，给它起个好记的文件名。",
  },
  {
    name: "gallery_move",
    signature: 'gallery_move(name: string, category: string, description?: string)',
    description:
      "把收藏夹里的文件移到某个分类，主要用来整理「未整理」里主人放进来的东西。" +
      'name 为文件名（可带分类前缀，如 "未整理/xx.png"）；category 为目标分类（表情包 / meme / 截图 / 照片）。' +
      "还没有描述的文件必须先 view_media 看清内容，再带上 description 一起移动。",
  },
  {
    name: "gallery_remove",
    signature: 'gallery_remove(name: string)',
    description: '把一个文件移出你的收藏夹。name 为 check_gallery 里看到的文件名（可带分类前缀，如 "meme/xx.png"）。',
  },
  {
    name: "send",
    signature: 'send(msg: string, id?: string, media?: string[], reply_to?: string, at_sender?: boolean, resend?: boolean, confirm_long?: boolean, insist?: boolean)',
    description:
      "发送消息。id 缺省为当前所在频道页；要发给别的频道就给出完整频道 id（格式 \"platform:channelId\"）。" +
      "要发**图文混排**时，在 msg 里要插图的位置写 `<img>` 占位符（几张图写几个 `<img>`）——" +
      "这样消息不会立刻发出，而是提示你选图；你再用 pick_media 按占位符顺序选出对应张图，选满后消息自动发出。" +
      "若只是想单纯发文字/在末尾附一张图，也可用 media 参数直接给媒体编号。",
  },
  {
    name: "pick_media",
    signature: 'pick_media(media: string[])',
    description:
      "按 msg 里 `<img>` 占位符的顺序选图填充（结合 send 的图文混排用）。media 为媒体编号或收藏夹文件的列表（如 [\"12\", \"gallery:表情包/xx.png\"]）。" +
      "发图务必先用 check_gallery / check_media / view_media 看清内容——光凭编号随手选很容易发出不相关的图。选了 N 张就填 N 个占位符，填满后那张消息自动发出。",
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
      '仔细辨认一张图片里的文字（逐字识别，适合看清截图、菜单、告示上的字）。image 填图片编号（如 "12"）或收藏夹文件（如 "gallery:menu.png"）。',
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
    signature: "list_friends()",
    description: "翻看你在聊天平台上的好友列表：每个好友的名字与可直接用于 send 的频道 id。",
  },
  {
    name: "user_info",
    signature: 'user_info(user_id: string)',
    description: "查看某个用户的公开资料（昵称、性别、年龄、签名等）。user_id 为对方的账号数字 id。",
  },
  {
    name: "send_like",
    signature: 'send_like(user_id: string, times?: number)',
    description: "给某人的资料卡点赞（一种示好方式，每人每天最多 10 次）。times 默认 1。",
  },
  {
    name: "delete_friend",
    signature: 'delete_friend(user_id: string)',
    description: "删除一个好友。这是不可逆的绝交动作，请慎重。",
  },
  {
    name: "set_profile",
    signature: 'set_profile(nickname?: string, signature?: string, avatar?: string)',
    description:
      '修改你的聊天账号资料：昵称、个性签名、头像。avatar 填图片编号（如 "12"）或收藏夹文件（如 "gallery:me.png"）。至少给一个参数。',
  },
  {
    name: "set_model_show",
    signature: 'set_model_show(model: string)',
    description: "修改你资料卡上显示的在线机型（别人看到的「xxx 在线」那种），填想显示的机型名。",
  },
  {
    name: "list_groups",
    signature: "list_groups()",
    description: "查看你加入的群列表：群名、可用于 send 的频道 id、人数。",
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
    description: '修改群头像（需要管理员权限）。image 填图片编号（如 "12"）或收藏夹文件。',
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
    description: "退出一个群聊。这是不可逆的动作，请慎重。",
  },
  {
    name: "cancel",
    signature: "cancel(id: string)",
    description: '取消尚未提交的工具调用（如还没开始发送的消息）。已提交的操作不能保证撤销，真实结果仍会返回。id 是工具调用编号（形如 "tc_12"）。',
  },
  {
    name: "recall",
    signature: "recall(keyword?: string, since?: number, until?: number, n?: number, important?: boolean)",
    description:
      "查看旧版世界作者留下的私人资料（facts.jsonl）。这些记录未经当前感知核实，可能不完整或过时，不能当作新的成长证据；可验证的关系、承诺与偏好请用 recall_growth。\n" +
      "- keyword：按关键词回想（模糊匹配内容），如 recall(keyword: \"童年\")；\n" +
      "- since / until：只回想 T（时间单位）落在该范围内的往事，填 T 的数值（可在结果里的「T=12.5」或 check_time 里看到），可只给一端；\n" +
      "- important: true：只回想那些刻骨铭心、对你影响深远的重要回忆；\n" +
      "- n：最多回想多少条（默认 10）。\n" +
      "不确定从哪想起时可先不带参数，看看近来的过往；被问起经历、要说自己的过去、或感到自己可能" +
      "忘了什么时，用它确认记忆，别乱编。",
  },
];

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
  /** bot.waitRateThreshold > 0：等待占比过高时新的 wait 需要 confirm: true */
  waitConfirm?: boolean;
  /** bot.disableWait：移除 wait 工具 */
  disableWait?: boolean;
  /** bot.ignoreSendDuration：send 系工具的 duration 被忽略，消息立即发出 */
  ignoreSendDuration?: boolean;
  /** crossing.worlds 中允许 Bot 主动前往的世界（travel 工具的目的地列表） */
  crossingWorlds?: { name: string; note?: string }[];
  /** crossing.worlds 配置了任何世界（go_home 保留，以便被强制送出后能自己回来） */
  crossingConfigured?: boolean;
}): BotToolDef[] {
  const tools = BOT_TOOLS.filter((t) => {
    switch (t.name) {
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
    // 等待占比拦截：只有开启时才在 wait 描述里说明 confirm 参数
    if (def.name === "wait" && opts.waitConfirm) {
      def = {
        ...def,
        description:
          def.description +
          "最近大部分时间都在干等时，新的等待会被拦下——先考虑做点别的；确实要等的话，按拦截提示操作即可。",
      };
    }
    // blockingAct 专注模式：上一个动作未完成前新的 act 会被拒绝（不可绕过）——只有开启时才在描述里说明
    if (def.name === "act" && opts.blockingAct) {
      def = {
        ...def,
        description:
          def.description +
          "开启 blockingAct（同时只能专注做一件事）时：上一个动作还没完成前，新的 act 会被直接拒绝，" +
          "也不能用 repeat 绕过——手头的事照常推进，等它的结果自动送达即可。",
      };
    }
    // open_app 的描述里列出已安装的应用
    if (def.name === "open_app" && opts.apps?.length) {
      def = {
        ...def,
        description:
          def.description +
          `已安装的应用：${opts.apps.map((a) => `${a.name}（${a.description}）`).join("、")}。`,
      };
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
      };
    }
    return def;
  });
}

export function renderToolsText(tools: BotToolDef[] = BOT_TOOLS): string {
  return tools.map((t) => `- ${t.signature}\n  ${t.description}`).join("\n");
}
