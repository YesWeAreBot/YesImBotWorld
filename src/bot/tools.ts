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
  "send", "send_file", "send_voice", "recall", "react", "get_emoji_likes",
  "forward_msgs", "poke", "channel_notify",
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
    signature: 'act(description: string, repeat?: boolean)',
    description:
      "在世界中做一件事，用自然语言描述（如「去厨房泡一杯咖啡」）。结果由世界裁定，会在动作完成时以事件返回。记得给出合理的 duration。" +
      "上一个相同的动作还没出结果时，重复的 act 会被拦截（不要因为没马上看到结果就再做一遍）；确实要同时再做一遍时加 repeat: true。",
  },
  {
    name: "rest",
    signature: "rest(duration?: number)",
    description:
      "休息一段时间，整理思绪与记忆（你的近期经历会被总结沉淀）。醒来后会被告知过去了多少 Time Unit。感到疲惫（上下文冗长）时应主动休息。",
  },
  {
    name: "check_status",
    signature: 'check_status(target: "self" | "world", full?: boolean)',
    description:
      "查看自身状态（self）或世界状态与近期新闻（world）。默认只告诉你自上次查看以来**变化**的部分；" +
      "需要重温全文时加 full: true。状态不会频繁变化，无事时不必反复查看。",
  },
  {
    name: "check_time",
    signature: "check_time()",
    description:
      "看一眼现在几点了（看手表、掏手机、找附近的时钟）。能否看到、通过什么看到由世界决定——身边没有计时工具时可能失败。",
  },
  {
    name: "check_news",
    signature: "check_news(n?: number)",
    description:
      "回想或打听世界上近来发生的事（新闻与见闻），列出最近 n 条（默认 10）。check_status(world) 只给新增的，这里可以完整回看。",
  },
  {
    name: "check_msg",
    signature: "check_msg(n: number)",
    description: "刷新消息列表：列出最近活跃的 n 个频道及各自的最新一条消息。",
  },
  {
    name: "select_channel",
    signature: 'select_channel(id: string, n: number)',
    description:
      '点进消息列表中的一个频道，查看最近 n 条消息。id 格式为 "platform:channelId"。' +
      "进入频道页后才能进行频道内的操作（发消息等，进入时会看到可用操作）。" +
      "此后的一段时间内你会持续留意这个频道，它的新消息会直接呈现在你眼前（发消息给某频道也有同样效果）。",
  },
  {
    name: "put_down_phone",
    signature: "put_down_phone()",
    description:
      "把手机放到一边：关闭打开着的应用，不再留意任何频道。之后再有消息你只会感觉到手机震了一下" +
      "（不呈现内容也不知道来自哪里），直到你用 pick_up_phone 拿起手机。想清静时用。",
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
    name: "check_gallery",
    signature: "check_gallery()",
    description:
      "翻看你的收藏夹（表情包、图片、文件等）。会列出每一项的引用编号与内容描述，供 send 的 media 参数或 send_file 使用。" +
      "发图时优先从这里挑；收藏夹用 gallery_save / gallery_remove 管理。",
  },
  {
    name: "check_media",
    signature: 'check_media(n?: number, type?: "image" | "audio" | "video")',
    description:
      "翻看媒体缓存：你在聊天里见过的图片、语音、视频都留在缓存里（只读，不能删改）。" +
      "列出最近 n 项（默认 10）的编号、大小与内容摘要。用于翻找没存进收藏夹的东西；想留下的用 gallery_save 收藏。",
  },
  {
    name: "gallery_save",
    signature: 'gallery_save(media_id: string, name?: string)',
    description:
      '把缓存里的媒体存进你的收藏夹（比如看到喜欢的表情包就存下来）。media_id 为媒体编号（如 "12"）；' +
      "name 可选，给它起个好记的文件名。存入时会附上内容摘要。",
  },
  {
    name: "gallery_remove",
    signature: 'gallery_remove(name: string)',
    description: "把一个文件移出你的收藏夹。name 为 check_gallery 里看到的文件名。",
  },
  {
    name: "send",
    signature: 'send(msg: string, id?: string, media?: string[], resend?: boolean, confirm_long?: boolean, insist?: boolean)',
    description:
      "发送消息。id 缺省为当前所在频道；要发给别的频道就给出完整频道 id（格式 \"platform:channelId\"，来自消息列表，不要用人名代替），相当于先切换过去。" +
      'media 可附带图片或视频，元素为媒体编号（如 "12"，来自收藏夹或媒体缓存）。' +
      "在 msg 里写 [图片#12] 或 [视频#3] 会把对应媒体嵌在文字中间发出（图文混排，QQ 等平台可能分开显示）——" +
      "注意：msg 里写了标记这张图就会真的发出去，不想发就不要写。" +
      "duration 表示打字耗时，消息会在打字完成时真正发出（发出前可 cancel）。" +
      "与上一条完全相同的消息会被拦截（防止无意义复读）；确实要重复发送时加 resend: true。" +
      "像真人一样聊天：单条消息尽量简短（一般十来个字），长内容拆成多条短消息；" +
      "确需发送整段长文（如资料、文章）时须加 confirm_long: true。" +
      "连续发了几条对方都没回应时，继续发送会被拦下——确实有必须现在说的话再加 insist: true。",
  },
  {
    name: "send_file",
    signature: 'send_file(file: string, id?: string)',
    description:
      '以文件形式发送音频、视频或其他文件。file 为媒体编号（如 "7"）或收藏夹文件（如 "gallery:简历.pdf"）；' +
      "id 缺省为当前频道。图片请直接用 send 的 media 参数发送。",
  },
  {
    name: "send_voice",
    signature: 'send_voice(text: string, id?: string)',
    description:
      "把一段话转成你的声音，以语音消息发出（id 缺省为当前频道）。适合简短口语化的内容。duration 表示说话耗时，发出前可 cancel。",
  },
  {
    name: "recall",
    signature: 'recall(id: string, msg_id: string)',
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
    description: '取消一个尚未到期望完成时刻的工具调用（如撤回还没发出去的消息）。id 是工具调用编号（形如 "tc_12"）。',
  },
  {
    name: "identity_recall",
    signature: "identity_recall()",
    description: "静下心反思自己是谁：你的角色设定会被重新注入你的意识。感到迷失或行为偏离人设时使用。",
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
}): BotToolDef[] {
  const tools = BOT_TOOLS.filter((t) => {
    switch (t.name) {
      case "send_voice":
        return opts.tts;
      case "channel_notify":
        return !!opts.notifyManaged;
      case "recall":
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
  return tools.map((t) => {
    // 开启引用回复时，send 增加 reply_to / at_sender 参数说明
    if (t.name === "send" && opts.ops.reply) {
      return {
        ...t,
        signature: t.signature.replace(
          "media?: string[]",
          "media?: string[], reply_to?: string, at_sender?: boolean",
        ),
        description:
          t.description +
          "reply_to 可引用回复某条消息，填消息记录里 (msg:xxx) 的编号；由你决定要不要引用、引用哪条。" +
          "群聊里引用回复会像 QQ 一样自动在开头 @ 对方——大多数时候保留即可；" +
          "如果不想 @（比如只是顺带提到、或不想打扰对方），加 at_sender: false 去掉，就像真人删掉自动加上的 @。",
      };
    }
    // open_app 的描述里列出已安装的应用
    if (t.name === "open_app" && opts.apps?.length) {
      return {
        ...t,
        description:
          t.description +
          `已安装的应用：${opts.apps.map((a) => `${a.name}（${a.description}）`).join("、")}。`,
      };
    }
    return t;
  });
}

export function renderToolsText(tools: BotToolDef[] = BOT_TOOLS): string {
  return tools.map((t) => `- ${t.signature}\n  ${t.description}`).join("\n");
}
