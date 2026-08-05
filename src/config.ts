import { Schema } from "koishi";

export interface TextTemplateConfig {
  bos: string;
  systemPrefix: string;
  systemSuffix: string;
  streamPrefix: string;
}

export interface ModalitySupport {
  image: boolean;
  audio: boolean;
  video: boolean;
}

export interface BotModelConfig {
  mode: "chat" | "text";
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  disableThinking: boolean;
  blockingAct: boolean;
  maxWindowChars: number;
  minIntervalMs: number;
  retryDelayMs: number;
  modalities: ModalitySupport;
  template: TextTemplateConfig;
}

export interface CaptionerConfig {
  enabled: boolean;
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens: number;
}

export interface AudioCaptionerConfig extends CaptionerConfig {
  api: "chat" | "transcription";
}

export interface CaptionersConfig {
  image: CaptionerConfig;
  audio: AudioCaptionerConfig;
  video: CaptionerConfig;
}

export interface MediaConfig {
  maxBytes: number;
  maxAttachmentsPerEvent: number;
  maxAttachmentsPerRequest: number;
  maxAttachmentMbPerRequest: number;
  captionTimeoutMs: number;
}

export interface TtsConfig {
  enabled: boolean;
  baseURL: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "mp3" | "wav" | "opus" | "aac" | "flac";
  speed: number;
  timeoutMs: number;
}

export interface WorldModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  disableThinking: boolean;
  maxToolRounds: number;
  compressMaxInputChars: number;
  waitNarrateMinRealSeconds: number;
}

export interface ClockConfigData {
  syncRealTime: boolean;
  realSecondsPerUnit: number;
  worldSecondsPerUnit: number;
  epoch: string;
  tingleEveryUnits: number;
  offlineNarrateMinUnits: number;
}

export type NotifyPolicy = "count" | "channel" | "content";

/** 非本插件产生的 Bot 账号消息（其他插件/指令输出等）的呈现方式 */
export type ExternalSelfMessageMode = "off" | "simulate" | "event" | "silent";

export interface MessagingConfig {
  notifyChannels: string[];
  botManagedNotifyChannels: boolean;
  notifyPolicy: NotifyPolicy;
  wakeOnNotify: boolean;
  focusDurationUnits: number;
  longMessageChars: number;
  coldChannelMsgs: number;
  externalSelfMessages: ExternalSelfMessageMode;
  selfCommands: boolean;
}

/** 聊天平台扩展操作（收发消息之外的能力），每个接口独立开关，默认全部关闭 */
export interface PlatformOpsConfig {
  recall: boolean;
  react: boolean;
  emojiLikes: boolean;
  reply: boolean;
  forwardMsgs: boolean;
  poke: boolean;
  handleRequests: boolean;
  listFriends: boolean;
  userInfo: boolean;
  sendLike: boolean;
  deleteFriend: boolean;
  profile: boolean;
  modelShow: boolean;
  ocrImage: boolean;
  listGroups: boolean;
  groupInfo: boolean;
  listMembers: boolean;
  memberInfo: boolean;
  groupHonor: boolean;
  groupFiles: boolean;
  groupCard: boolean;
  groupName: boolean;
  groupPortrait: boolean;
  groupNotice: boolean;
  getGroupNotice: boolean;
  essence: boolean;
  essenceList: boolean;
  groupSign: boolean;
  groupBan: boolean;
  groupWholeBan: boolean;
  groupKick: boolean;
  groupAdmin: boolean;
  specialTitle: boolean;
  groupLeave: boolean;
}

/** 外接 MCP Server（对 Bot 呈现为手机里的一个 App） */
export interface McpServerConfig {
  enabled: boolean;
  name: string;
  description: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  headers: Record<string, string>;
}

/** Bot 的电脑：实现方式（由用户在下拉选框选择；仅现实世界以真实实现生效，虚构世界由 World-LLM 扮演） */
export type ComputerMode = "off" | "docker" | "remote_desktop";

/** Bot 的电脑：Docker 容器实现（mode=docker 时生效） */
export interface DockerComputerConfig {
  /** Docker CLI 可执行文件路径（如 docker，或 /usr/bin/docker） */
  cli: string;
  /** 容器名：Bot 的这台电脑（容器会复用，重启仍在） */
  containerName: string;
  image: string;
  pullPolicy: "missing" | "always" | "never";
  /** 电脑内固定工作目录（终端/资源管理器的根） */
  workdir: string;
  user: string;
  network: string;
  hostname: string;
  timezone: string;
  /** 显式映射到电脑里的主机目录（默认不映射，Bot 无法访问主机文件） */
  mounts: { host: string; container: string; readonly: boolean }[];
  extraArgs: string[];
  commandTimeoutMs: number;
  maxOutputChars: number;
}

/** Bot 的电脑：远程桌面实现（VNC / GUI Agent，mode=remote_desktop 时生效） */
export interface RemoteDesktopConfig {
  /** VNC 服务器地址 */
  host: string;
  port: number;
  /** VNC 登录密码（留空使用无密码认证） */
  password: string;
  /** 截屏最大宽度（像素）：超过后等比缩小，控制注入模型的图片体积、保护上下文预算 */
  maxWidth: number;
  /** 连接超时（毫秒） */
  connectTimeoutMs: number;
}

/** Bot 的个人电脑：与手机平级的另一台设备，实现方式二选一（仅现实世界生效） */
export interface ComputerConfig {
  /** 电脑的实现方式：off 关闭 / docker 容器 / remote_desktop 远程桌面 */
  mode: ComputerMode;
  /** Docker 容器实现（mode=docker 时生效） */
  docker: DockerComputerConfig;
  /** 远程桌面实现（VNC，mode=remote_desktop 时生效） */
  remoteDesktop: RemoteDesktopConfig;
}

/** 手机应用（Apps）：聊天平台之外，Bot 可以用 open_app 打开的应用 */
export interface AppsConfig {
  chatAppName: string;
  weatherEnabled: boolean;
  weatherDefaultCity: string;
  browserEnabled: boolean;
  browserSearchURL: string;
  browserProxy: string;
  notesEnabled: boolean;
  filesEnabled: boolean;
  filesCwd: string;
  computer: ComputerConfig;
  mcpServers: McpServerConfig[];
}

/** 这些平台操作需要引用消息编号：开启任意一项时，消息记录会附带 (msg:xxx) 标注 */
export function needsMsgIds(ops: PlatformOpsConfig): boolean {
  return ops.recall || ops.react || ops.reply || ops.forwardMsgs || ops.emojiLikes || ops.essence;
}

export interface Config {
  basePath: string;
  autoStart: boolean;
  serializeSameEndpoint: boolean;
  bot: BotModelConfig;
  world: WorldModelConfig;
  clock: ClockConfigData;
  messaging: MessagingConfig;
  platformOps: PlatformOpsConfig;
  apps: AppsConfig;
  captioners: CaptionersConfig;
  media: MediaConfig;
  tts: TtsConfig;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    basePath: Schema.string()
      .default("data/yesimbot-world")
      .description("数据目录（存放 Bot_Status.md / World_Status.md / News.db 等）"),
    autoStart: Schema.boolean()
      .default(false)
      .description("Koishi 启动后自动恢复世界运行（需先执行 world.init 初始化）"),
    serializeSameEndpoint: Schema.boolean()
      .default(true)
      .description(
        "同源推理端点互斥：Bot-LLM 与 World-LLM 的 baseURL 同源（协议+主机+端口相同）时，" +
          "双方的请求排队执行、绝不并发——World 任务（act 裁定、Tingle 等）期间 Bot 的生成会短暂等待。" +
          "适用于并发请求下会饿死请求甚至崩溃的后端（模型换载层、单实例本地部署等）。" +
          "若你的后端能真正并发处理多个请求，关闭本项可让两个 LLM 并行工作。" +
          "两个 baseURL 不同源时本项没有任何影响",
      ),
  }).description("基础配置"),

  Schema.object({
    bot: Schema.object({
      mode: Schema.union([
        Schema.const("chat").description("chat_completion 循环（任意 OpenAI 兼容 API）"),
        Schema.const("text").description("text_completion + GBNF（llama.cpp server 专属，强约束输出）"),
      ])
        .default("chat")
        .description("持续生成的实现方式"),
      baseURL: Schema.string()
        .default("http://127.0.0.1:8080/v1")
        .description("API 地址。chat 模式填 OpenAI 兼容根路径（含 /v1）；text 模式填 llama.cpp server 根路径"),
      apiKey: Schema.string().role("secret").default("").description("API Key（本地部署可留空）"),
      model: Schema.string().default("").description("模型名（text 模式下 llama.cpp 单模型部署可留空）"),
      temperature: Schema.number().min(0).max(2).default(0.8).description("采样温度"),
      maxTokens: Schema.natural()
        .default(4096)
        .description(
          "单次生成的最大 token 数。普通工具调用很小，但文件 App 的 write/patch 可能携带较长内容，调低后 JSON 容易在闭合前被截断。",
        ),
      disableThinking: Schema.boolean()
        .default(false)
        .description(
          "关闭模型思维链（对支持开关思考模式的模型生效，如 Qwen3 / DeepSeek V3.1+ / GLM 系）。" +
            "请求会附带 enable_thinking: false，以及 chat_template_kwargs 里的 " +
            "enable_thinking: false（Qwen/GLM 系模板）与 thinking: false（DeepSeek 系模板）。" +
            "生成工具调用不需要深度思考，关闭可显著提速省钱。仅 chat 模式生效",
        ),
      blockingAct: Schema.boolean()
        .default(false)
        .description(
          "act() 的专注模式：开启后，上一个动作还没完成（结果交付）前，新的 act 会被直接拒绝并提示等待——" +
            "不能被 repeat 等参数绕过；但其他工具调用（发消息、等待、看状态等）不受影响、照常进行。" +
            "一个人同时只能专注做一件事，做别的不受影响",
        ),
      maxWindowChars: Schema.natural()
        .default(32000)
        .description("上下文预算（近似字符数）。超出后强制触发 rest() 压缩上下文"),
      minIntervalMs: Schema.natural()
        .default(1000)
        .description(
          "Tool Call 生成速率限制：两次生成之间的最小间隔（毫秒），text / chat 两种模式均生效。" +
            "云端 API 建议设为 3000 以上避免触发限速；本地模型可设为 0",
        ),
      retryDelayMs: Schema.natural().default(5000).description("生成失败后的重试等待（毫秒）"),
      modalities: Schema.object({
        image: Schema.boolean().default(false).description("模型原生支持图片输入"),
        audio: Schema.boolean().default(false).description("模型原生支持音频输入"),
        video: Schema.boolean().default(false).description("模型原生支持视频输入"),
      }).description(
        "Bot-LLM 的原生多模态能力（仅 chat 模式生效；text 模式的 /completion 无法输入媒体，一律使用外挂解释器）。" +
          "原生支持的模态会以 content part 附件注入上下文；未支持的模态回退到外挂解释器。" +
          "GIF 动图按能力路由：支持视频 → 走视频通道；仅支持图像 → 抽帧拼成一张网格图注入；都不支持 → 优先外挂视频解释器",
      ),
      template: Schema.object({
        bos: Schema.string().default("").description("BOS 文本（llama.cpp 通常自动加 BOS token，留空即可）"),
        systemPrefix: Schema.string().default("<|im_start|>system\n").description("system 段前缀"),
        systemSuffix: Schema.string().default("<|im_end|>\n").description("system 段后缀"),
        streamPrefix: Schema.string().default("<|im_start|>assistant\n").description("Tool Call 流（持续的 assistant 段）前缀"),
      }).description("text 模式的提示词模板（按模型的 chat template 调整，默认 ChatML）"),
    }).description("Bot-LLM：持续生成工具调用流的角色模型"),
  }),

  Schema.object({
    world: Schema.object({
      baseURL: Schema.string()
        .default("http://127.0.0.1:8080/v1")
        .description("OpenAI 兼容 API 根路径（含 /v1）。需支持 tool calling"),
      apiKey: Schema.string().role("secret").default("").description("API Key"),
      model: Schema.string().default("").description("模型名"),
      temperature: Schema.number().min(0).max(2).default(0.7).description("采样温度"),
      maxTokens: Schema.natural().default(4096).description("单次生成的最大 token 数"),
      disableThinking: Schema.boolean()
        .default(false)
        .description(
          "关闭模型思维链（对支持开关思考模式的模型生效，如 Qwen3 / DeepSeek V3.1+ / GLM 系）。" +
            "请求会附带 enable_thinking: false，以及 chat_template_kwargs 里的 " +
            "enable_thinking: false（Qwen/GLM 系模板）与 thinking: false（DeepSeek 系模板）",
        ),
      maxToolRounds: Schema.natural().default(8).description("单次响应中允许的最大工具调用轮数"),
      compressMaxInputChars: Schema.natural()
        .default(100000)
        .description(
          "上下文压缩时送入 World-LLM 的意识流文本上限（字符数）。" +
            "超出部分会从最早处截断（仅保留最近内容），防止压缩请求本身超过模型上下文窗口而失败",
        ),
      waitNarrateMinRealSeconds: Schema.natural()
        .default(300)
        .description(
          "wait 期间补叙的阈值（现实秒）：等待的现实时长达到该值时，wait 快结束时由 World-LLM " +
            "提前生成期间见闻，随唤醒事件送达（生成不及时则先准时唤醒、见闻随后补送）。" +
            "更短的等待到点直接唤醒，不调用 World-LLM。0 表示从不补叙",
        ),
    }).description("World-LLM：维护世界状态、裁定事件的模型（也负责上下文压缩与初始化）"),
  }),

  Schema.object({
    clock: Schema.object({
      syncRealTime: Schema.boolean()
        .default(true)
        .description(
          "虚拟世界时间与现实时间同步：世界时钟即现实时钟，1 TU 固定为 1 秒，" +
            "并忽略下方的流速与初始时刻配置（创世时也不再生成自定义历法）。" +
            "同步模式下时间无法冻结——world.stop 只会停下 Bot，时间照常流逝。" +
            "关闭后世界拥有独立的时间线，按下方配置运转",
        ),
      realSecondsPerUnit: Schema.number()
        .min(0.1)
        .default(1)
        .description("1 个 Time Unit 等于现实世界多少秒（世界时间流速）。仅在关闭「与现实同步」时生效"),
      worldSecondsPerUnit: Schema.number()
        .min(1)
        .default(1)
        .description("1 个 Time Unit 在虚拟世界内代表多少秒（用于换算世界时钟显示）。仅在关闭「与现实同步」时生效"),
      epoch: Schema.string()
        .default("2026-01-01 08:00")
        .description(
          "世界初始时刻（T=0 对应的世界时间），自由文本：可以是现实日期（如 2026-01-01 08:00），" +
            "也可以是幻想世界的纪年（如「王历1024年 春月初三 辰时」）。" +
            "创世（world.init）时 World-LLM 会依据世界定义与这里的描述生成一套匹配的历法并持久化，" +
            "此后世界时钟按该历法显示时间，修改本项需重新创世才生效。仅在关闭「与现实同步」时生效",
        ),
      tingleEveryUnits: Schema.number()
        .min(0)
        .default(1800)
        .description("每过多少个 Time Unit 产生一次 Tingle（触发 World-LLM 推进世界、生成 News）。默认 1800（同步模式下即 30 分钟）。0 表示禁用"),
      offlineNarrateMinUnits: Schema.number()
        .min(0)
        .default(600)
        .description(
          "Koishi 关闭期间世界时间照常流逝（用 world.stop 显式暂停才会冻结时间）。" +
            "重新启动世界时，若离线时长达到此 TU 数，将由 World-LLM 补叙这段时间世界发生了什么并告知 Bot。" +
            "默认 600（同步模式下即 10 分钟）。0 表示只告知流逝了多少时间、不做补叙",
        ),
    }).description("World Clock"),
  }),

  Schema.object({
    platformOps: Schema.object({
      recall: Schema.boolean()
        .default(false)
        .description("recall：撤回自己已发出的消息。开启后消息记录与发送结果会附带 (msg:xxx) 消息编号"),
      react: Schema.boolean()
        .default(false)
        .description(
          "react：给消息贴/移除表情回应（OneBot 走 set_msg_emoji_like，需实现端支持，如 NapCat / LLOneBot / Lagrange；" +
            "其他平台走通用 createReaction / deleteReaction）。开启后消息记录会附带 (msg:xxx) 消息编号",
        ),
      emojiLikes: Schema.boolean()
        .default(false)
        .description(
          "get_emoji_likes：查看某条消息上某个表情回应都是谁贴的（NapCat 特有）。" +
            "开启后消息记录会附带 (msg:xxx) 消息编号［fetch_emoji_like］",
        ),
      reply: Schema.boolean()
        .default(false)
        .description("reply：send 时可用 reply_to 引用回复某条消息。开启后消息记录会附带 (msg:xxx) 消息编号"),
      forwardMsgs: Schema.boolean()
        .default(false)
        .description(
          "forward_msgs：把几条已有消息打包成聊天记录，合并转发到某个频道。" +
            "开启后消息记录会附带 (msg:xxx) 消息编号［send_group_forward_msg / send_private_forward_msg］",
        ),
      poke: Schema.boolean()
        .default(false)
        .description("poke：戳一戳（仅 OneBot，需实现端支持 friend_poke / group_poke，如 NapCat / LLOneBot）"),
      handleRequests: Schema.boolean()
        .default(false)
        .description(
          "handle_request：处理好友申请与入群邀请/申请。" +
            "开启后相应请求会以手机通知事件的形式告知 Bot，由它决定同意或拒绝",
        ),
      listFriends: Schema.boolean()
        .default(false)
        .description("list_friends：查看好友列表（名字与可用于 send 的频道 id）［get_friend_list］"),
      userInfo: Schema.boolean()
        .default(false)
        .description("user_info：查看某个用户的资料（昵称、性别、年龄、签名等）［get_stranger_info］"),
      sendLike: Schema.boolean()
        .default(false)
        .description("send_like：给某人的资料卡点赞（每天最多 10 次）［send_like］"),
      deleteFriend: Schema.boolean()
        .default(false)
        .description("delete_friend：删除好友（不可逆，谨慎开启）［delete_friend］"),
      profile: Schema.boolean()
        .default(false)
        .description("set_profile：修改自己的昵称、个性签名、头像［set_qq_profile / set_qq_avatar］"),
      modelShow: Schema.boolean()
        .default(false)
        .description("set_model_show：修改资料卡上显示的在线机型（如「iPhone 15 Pro」）［set_model_show］"),
      ocrImage: Schema.boolean()
        .default(false)
        .description("ocr_image：识别图片中的文字（与多模态解释器互补，能拿到精确文本）［ocr_image］"),
      listGroups: Schema.boolean()
        .default(false)
        .description("list_groups：查看自己加入的群列表［get_group_list］"),
      groupInfo: Schema.boolean()
        .default(false)
        .description("group_info：查看某个群的信息（群名、人数等）［get_group_info］"),
      listMembers: Schema.boolean()
        .default(false)
        .description("list_members：查看群成员列表［get_group_member_list］"),
      memberInfo: Schema.boolean()
        .default(false)
        .description("member_info：查看某个群成员的详细信息（名片、头衔、身份等）［get_group_member_info］"),
      groupHonor: Schema.boolean()
        .default(false)
        .description("group_honor：查看群荣誉（龙王、群聊之火、快乐源泉等）［get_group_honor_info］"),
      groupFiles: Schema.boolean()
        .default(false)
        .description("group_files：浏览群文件与文件夹（只读）［get_group_root_files / get_group_files_by_folder］"),
      groupCard: Schema.boolean()
        .default(false)
        .description("set_group_card：修改自己在群里显示的名称（群名片）［set_group_card］"),
      groupName: Schema.boolean()
        .default(false)
        .description("set_group_name：修改群名（需要相应权限）［set_group_name］"),
      groupPortrait: Schema.boolean()
        .default(false)
        .description("set_group_portrait：修改群头像（需要管理员权限）［set_group_portrait］"),
      groupNotice: Schema.boolean()
        .default(false)
        .description("send_group_notice：发布群公告（需要管理员权限）［_send_group_notice］"),
      getGroupNotice: Schema.boolean()
        .default(false)
        .description("get_group_notice：查看群公告列表（普通成员也可用）［_get_group_notice］"),
      essence: Schema.boolean()
        .default(false)
        .description(
          "set_essence：把群消息设为/移出精华（需要管理员权限）。" +
            "开启后消息记录会附带 (msg:xxx) 消息编号［set_essence_msg / delete_essence_msg］",
        ),
      essenceList: Schema.boolean()
        .default(false)
        .description("get_essence_list：查看群精华消息列表［get_essence_msg_list］"),
      groupSign: Schema.boolean()
        .default(false)
        .description("group_sign：群打卡［set_group_sign / send_group_sign］"),
      groupBan: Schema.boolean()
        .default(false)
        .description("group_ban：禁言/解除禁言群成员（需要管理员权限）［set_group_ban］"),
      groupWholeBan: Schema.boolean()
        .default(false)
        .description("group_whole_ban：开启/关闭全员禁言（需要管理员权限）［set_group_whole_ban］"),
      groupKick: Schema.boolean()
        .default(false)
        .description("group_kick：把成员移出群（需要管理员权限，谨慎开启）［set_group_kick］"),
      groupAdmin: Schema.boolean()
        .default(false)
        .description("group_admin：设置/取消群管理员（需要群主权限）［set_group_admin］"),
      specialTitle: Schema.boolean()
        .default(false)
        .description("set_special_title：授予群成员专属头衔（需要群主权限）［set_group_special_title］"),
      groupLeave: Schema.boolean()
        .default(false)
        .description("group_leave：退出群聊（不可逆，谨慎开启）［set_group_leave］"),
    }).description(
      "聊天平台扩展操作：为 Bot 提供收发消息之外的平台能力（默认全部关闭）。" +
        "开关变化会以事件告知 Bot 并即刻生效；置顶的工具列表在下次 rest 压缩时才同步（保护前缀缓存）",
    ),
  }),

  Schema.object({
    apps: Schema.object({
      chatAppName: Schema.string()
        .default("QQ")
        .description("聊天平台在 Bot 手机里的应用名。open_app 打开它 = 看一眼最近消息（check_msg）"),
      weatherEnabled: Schema.boolean()
        .default(true)
        .description(
          "内置天气应用：现实世界设定查询真实天气（Open-Meteo，免费无需 key）；" +
            "虚构世界设定由 World-LLM 生成并沉淀进世界状态。现实/虚构在创世（world.init）时由 World-LLM 依据世界定义判定",
        ),
      weatherDefaultCity: Schema.string()
        .default("")
        .description("真实天气的默认城市（Bot 查询时不指定城市则使用；留空则要求 Bot 自己给出城市）"),
      browserEnabled: Schema.boolean()
        .default(true)
        .description(
          "内置浏览器应用：现实世界设定对接真实互联网（搜索 + 打开网页 + 保存网页图片）；" +
            "虚构世界设定由 World-LLM 生成符合世界观的网页。" +
            "两种模式都支持网页截图并自动存入收藏夹「截图」分类（需要安装 koishi-plugin-puppeteer，未安装时仅截图不可用）",
        ),
      browserSearchURL: Schema.string()
        .default("https://www.so.com/s?q=%s")
        .description(
          "现实世界模式的搜索引擎地址，%s 为搜索词占位（无 %s 时追加在末尾）。" +
            "默认 360 搜索（中国大陆可直连、结果页可解析、跳转链可还原）。可选：" +
            "DuckDuckGo Lite https://lite.duckduckgo.com/lite/?q=%s（需能访问外网）、" +
            "自建 SearxNG 实例 http://…/search?q=%s（最干净可控）。" +
            "百度/搜狗/必应不推荐：页面过大、反爬或对无 cookie 请求返回不相关结果",
        ),
      browserProxy: Schema.string()
        .default("")
        .description(
          "浏览器访问真实互联网时使用的代理 URL（如 http://127.0.0.1:7890）。" +
            "留空时依次读取 HTTPS_PROXY / HTTP_PROXY 环境变量；都没有则不代理。",
        ),
      notesEnabled: Schema.boolean()
        .default(true)
        .description(
          "内置记事本应用：Bot 的私人笔记（备忘、值得注意的事、对群友的印象、日记）。" +
            "由 Bot 主动记录、随时翻看，不受上下文压缩影响。存储为世界数据目录 Notes/ 下的 Markdown 文件" +
            "（文件名即标题），你可以直接翻看/编辑，也可以自己放 .md 进去给 Bot 看；创世重置时整个文件夹随其他状态归档",
        ),
      filesEnabled: Schema.boolean()
        .default(false)
        .description(
          "内置资源管理器（文件）：Bot 打开电脑后可以用它查看/修改这台电脑主目录里的文件。电脑为 Docker 实现（apps.computer.mode 选 docker）或虚构世界时可用。",
        ),
      filesCwd: Schema.string()
        .default(".")
        .description("资源管理器在电脑里打开的工作目录，相对电脑主目录；留空为主目录根"),
      computer: Schema.object({
        mode: Schema.union([
          Schema.const("off").description("不启用真实的电脑（虚构世界里仍由 World-LLM 扮演这台电脑）"),
          Schema.const("docker").description("Docker 容器：本地创建一台电脑，命令只在这台容器里执行"),
          Schema.const("remote_desktop").description("VNC 远程桌面：连到另一台机器，看屏幕、动鼠标键盘"),
        ])
          .default("off")
          .description(
            "电脑的实现方式，由你从下拉框选择。电脑是 Bot 与手机平级的另一台设备，Docker 与远程桌面是平级的两种实现，选哪种就开哪种；" +
              "它**仅在世界类型为「现实世界」时以选定的实现生效**，虚构世界里由 World-LLM 扮演这台电脑",
          ),
        docker: Schema.object({
          cli: Schema.string()
            .default("")
            .description("Docker CLI 可执行文件路径（如 docker，或 /usr/bin/docker）"),
          containerName: Schema.string()
            .default("yesimbot_bot_pc")
            .description("Bot 的这台电脑的容器名。容器创建一次可复用，重启仍在（镜像升级后重命名即可换新机）"),
          image: Schema.string()
            .default("node:20-slim")
            .description("电脑的镜像（首次开机时按需拉取）。带常用命令的通用镜像更接近真实电脑"),
          pullPolicy: Schema.union([
            Schema.const("missing").description("本地没有该镜像时才拉取"),
            Schema.const("always").description("每次开机都重新拉取"),
            Schema.const("never").description("不拉取，只使用本地已有的镜像"),
          ])
            .default("missing")
            .description("镜像拉取策略"),
          workdir: Schema.string()
            .default("/workspace")
            .description("电脑内的固定主目录（终端与资源管理器的根）"),
          user: Schema.string().default("1000").description("容器内执行命令的用户（uid:gid 或用户名；留空用镜像默认用户）"),
          network: Schema.string().default("none").description("容器网络模式：默认 none 断网，Bot 的电脑连不上外网（需联网时改为 bridge 或 host）"),
          hostname: Schema.string().default("bot-pc").description("这台电脑的主机名"),
          timezone: Schema.string().default("Asia/Shanghai").description("电脑的系统时区"),
          mounts: Schema.array(
            Schema.object({
              host: Schema.string().description("主机目录（绝对路径）"),
              container: Schema.string().description("映射进电脑的路径"),
              readonly: Schema.boolean().default(false).description("只读挂载（防止 Bot 修改主机文件）"),
            }),
          )
            .default([])
            .description(
              "显式映射到电脑里的主机目录。默认不映射任何主机路径，Bot 无法访问主机文件；" +
                "需要把某个目录交给它时（如相册、文档）在此声明",
            ),
          extraArgs: Schema.array(Schema.string())
            .default([])
            .description("docker create 的附加参数（如 --memory、--cpus 限制电脑资源）"),
          commandTimeoutMs: Schema.natural().default(30000).description("单条命令的超时（毫秒）"),
          maxOutputChars: Schema.natural().default(20000).description("返回给 Bot 的单条命令最大输出字符数"),
        }).description(
          "Docker 容器实现（mode 选 docker 时生效）：终端 / 资源管理器的操作都在这台容器里执行，与运行 Koishi 的主机隔离",
        ),
        remoteDesktop: Schema.object({
          host: Schema.string().default("127.0.0.1").description("VNC 服务器地址（如 192.168.1.5）"),
          port: Schema.natural().default(5900).description("VNC 端口（默认 5900）"),
          password: Schema.string()
            .role("secret")
            .default("")
            .description("VNC 登录密码（留空使用无密码认证）"),
          maxWidth: Schema.natural()
            .default(1024)
            .description(
              "截屏的最大宽度（像素）：更大的屏幕等比缩小到该宽度。" +
                "控制注入模型的图片体积，越小越省 token、前缀缓存越稳定；太大会挤爆请求体预算（见 media.maxAttachmentMbPerRequest）",
            ),
          connectTimeoutMs: Schema.natural().default(10000).description("连接远程桌面的超时（毫秒）"),
        }).description(
          "VNC 远程桌面实现（mode 选 remote_desktop 时生效）：Bot 的电脑连上另一台机器，像操作本地电脑一样看屏幕、动鼠标键盘。" +
            "需 Bot-LLM 开启图片多模态（bot.modalities.image）才能注入截屏；目标机器需安装并运行 VNC 服务端（TightVNC / TigerVNC / x11vnc / macOS 自带「远程管理」等）",
        ),
      }).description(
        "Bot 的个人电脑：与手机平级的另一台设备，由 mode 选择实现方式（Docker 容器 / VNC 远程桌面），" +
          "仅在世界类型为「现实世界」时以真实实现生效；虚构世界里由 World-LLM 扮演这台电脑",
      ),
      mcpServers: Schema.array(
        Schema.object({
          enabled: Schema.boolean().default(true).description("启用该应用"),
          name: Schema.string().default("").description("应用名（Bot 用 open_app 打开它的名字）"),
          description: Schema.string().default("").description("一句话介绍（展示在已安装应用列表里）"),
          transport: Schema.union([
            Schema.const("stdio").description("stdio：本地子进程"),
            Schema.const("http").description("http：Streamable HTTP 端点"),
          ])
            .default("stdio")
            .description("传输方式"),
          command: Schema.string()
            .default("")
            .description('stdio：启动命令（args 留空时可整条写在这里，如 "npx -y @modelcontextprotocol/server-filesystem /tmp"）'),
          args: Schema.array(Schema.string()).default([]).description("stdio：命令参数"),
          url: Schema.string().default("").description("http：MCP 端点 URL"),
          headers: Schema.dict(Schema.string()).default({}).description("http：附加请求头（如 Authorization）"),
        }),
      )
        .default([])
        .description("外接 MCP Server 列表：每个 Server 对 Bot 来说是手机里的一个 App"),
    }).description(
      "手机应用（Apps / MCP）：MCP Server 与内置应用（天气/浏览器）不占用常驻工具位，Bot 用 open_app 打开后其操作才展开可用（一次只开一个，切换/关闭/rest 后失效）。" +
        "Bot 的电脑是另一台平级的设备，不在这里，用 open_computer / close_computer 开关",
    ),
  }),

  Schema.object({
    captioners: Schema.object({
      image: Schema.object({
        enabled: Schema.boolean().default(false).description("启用图片解释器"),
        baseURL: Schema.string().default("http://127.0.0.1:8080/v1").description("OpenAI 兼容 API 根路径（含 /v1）"),
        apiKey: Schema.string().role("secret").default("").description("API Key"),
        model: Schema.string().default("").description("视觉模型名"),
        prompt: Schema.string()
          .role("textarea")
          .default("请用中文简明扼要地描述这张图片的内容（一两句话，保留关键细节，如文字、表情、梗）。")
          .description("解释提示词"),
        maxTokens: Schema.natural().default(512).description("最大生成 token 数"),
      }).description("图片 → 文本解释器（Bot-LLM 不具备图片能力时外挂）"),
      audio: Schema.object({
        enabled: Schema.boolean().default(false).description("启用音频解释器"),
        api: Schema.union([
          Schema.const("transcription").description("语音转写 API（/v1/audio/transcriptions，whisper 系）"),
          Schema.const("chat").description("多模态 chat API（input_audio content part）"),
        ])
          .default("transcription")
          .description("音频解释方式"),
        baseURL: Schema.string().default("http://127.0.0.1:8080/v1").description("API 根路径（含 /v1）"),
        apiKey: Schema.string().role("secret").default("").description("API Key"),
        model: Schema.string().default("whisper-1").description("模型名"),
        prompt: Schema.string()
          .role("textarea")
          .default("请用中文简述这段音频的内容（若是语音请转写，若是音乐/音效请描述）。")
          .description("解释提示词（chat 方式时使用）"),
        maxTokens: Schema.natural().default(512).description("最大生成 token 数（chat 方式时使用）"),
      }).description("音频 → 文本解释器"),
      video: Schema.object({
        enabled: Schema.boolean().default(false).description("启用视频解释器"),
        baseURL: Schema.string().default("http://127.0.0.1:8080/v1").description("OpenAI 兼容 API 根路径（含 /v1）"),
        apiKey: Schema.string().role("secret").default("").description("API Key"),
        model: Schema.string().default("").description("视频理解模型名（需支持 video_url content part，如 Qwen-VL 系）"),
        prompt: Schema.string()
          .role("textarea")
          .default("请用中文简述这段视频的内容（一两句话，包含画面与声音要点）。")
          .description("解释提示词"),
        maxTokens: Schema.natural().default(512).description("最大生成 token 数"),
      }).description("视频 → 文本解释器"),
    }).description("外挂多模态解释器：把 Bot-LLM 不具备的模态解释为文本（解释结果按媒体缓存，同一文件只解释一次）"),
  }),

  Schema.object({
    tts: Schema.object({
      enabled: Schema.boolean().default(false).description("启用语音合成（启用后 Bot 获得 send_voice 工具）"),
      baseURL: Schema.string()
        .default("http://127.0.0.1:8880/v1")
        .description("OpenAI 兼容 TTS API 根路径（含 /v1，使用 /audio/speech 端点）"),
      apiKey: Schema.string().role("secret").default("").description("API Key"),
      model: Schema.string().default("tts-1").description("TTS 模型名"),
      voice: Schema.string().default("alloy").description("音色"),
      format: Schema.union(["mp3", "wav", "opus", "aac", "flac"])
        .default("mp3")
        .description("音频格式"),
      speed: Schema.number().min(0.25).max(4).default(1).description("语速"),
      timeoutMs: Schema.natural().default(60000).description("合成超时（毫秒）"),
    }).description("语音合成（TTS）：Bot 可将文字以语音消息形式发送"),
  }),

  Schema.object({
    media: Schema.object({
      maxBytes: Schema.natural()
        .default(32 * 1024 * 1024)
        .description("单个媒体文件的下载大小上限（字节），超限的媒体只保留占位符"),
      maxAttachmentsPerEvent: Schema.natural()
        .default(4)
        .description("单个事件中原生注入的媒体附件数量上限，超出部分回退为文本解释"),
      maxAttachmentsPerRequest: Schema.natural()
        .default(8)
        .description(
          "单次生成请求注入的原生附件**总数**上限：工作窗口里的历史附件每次请求都会重发，必须设预算。" +
            "越限时较早的附件被整批淘汰为文字标记（水位降到一半，保护前缀缓存）。生成请求报 413（请求体过大）时调小",
        ),
      maxAttachmentMbPerRequest: Schema.number()
        .default(6)
        .description(
          "单次生成请求注入的原生附件**总体积**上限（MB，按 base64 编码后计）：" +
            "决定请求体大小的主要因素。单个超过此值的附件（过大的截图/大图）不注入。" +
            "生成请求报 413 时调小；注意反向代理的请求体上限（如 nginx client_max_body_size 默认仅 1MB）",
        ),
      captionTimeoutMs: Schema.natural().default(60000).description("单次解释调用的超时（毫秒）"),
    }).description("媒体处理"),
  }),

  Schema.object({
    messaging: Schema.object({
      notifyChannels: Schema.array(Schema.string())
        .default([])
        .description('Allow Notification 频道列表，格式 "platform:channelId"（如 "onebot:123456"）。"*" 表示所有频道'),
      botManagedNotifyChannels: Schema.boolean()
        .default(false)
        .description(
          "允许 Bot 自己管理通知频道列表（channel_notify 工具，像真人给聊天设免打扰/开提醒）。" +
            "开启后上面的列表只是初始值，此后的变更持久化在 notify.json",
        ),
      notifyPolicy: Schema.union([
        Schema.const("count").description("收到一条消息"),
        Schema.const("channel").description("收到来自 channelId 的消息"),
        Schema.const("content").description("收到来自 channelId 的消息：内容"),
      ])
        .default("channel")
        .description("通知事件的内容策略"),
      wakeOnNotify: Schema.boolean()
        .default(true)
        .description("Bot 处于 wait() 中时，收到通知是否将其唤醒（类似手机震动打断等待）"),
      focusDurationUnits: Schema.number()
        .min(0)
        .default(1800)
        .description(
          "Bot 打开频道（select_channel）或向频道发送消息后，持续关注该频道多少个 Time Unit。" +
            "关注期间该频道的消息无视通知策略与频道列表，必定呈现完整内容；" +
            "Bot 可用 put_down_phone 主动放下手机。默认 1800（同步模式下即 30 分钟）。0 表示禁用关注机制",
        ),
      longMessageChars: Schema.natural()
        .default(100)
        .description(
          "单条消息的长度提醒阈值（字符数）。send 的 msg 超过该长度时不会立即发出，" +
            "而是提醒 Bot 日常聊天应使用短消息，需要它加 confirm_long: true 二次确认才发送。0 表示禁用",
        ),
      coldChannelMsgs: Schema.natural()
        .default(3)
        .description(
          "冷频道刷屏提醒：连续向同一频道发出多少条消息而无人回应后，继续 send 会被拦下提醒" +
            "（像真人一样避免对着没人回应的窗口自说自话），需要 Bot 加 insist: true 才发出。0 表示禁用",
        ),
      externalSelfMessages: Schema.union([
        Schema.const("off").description("忽略（默认）"),
        Schema.const("simulate").description("伪装成 Bot 自己的 send 工具调用（Bot 会以为是自己发的）"),
        Schema.const("event").description("以事件告知 Bot：你的账号自己发出了一条消息（Bot 知道不是自己发的）"),
        Schema.const("silent").description("只入库不通知：像别人发的消息一样静静躺在记录里，等 Bot 翻看聊天记录时自己发现"),
      ])
        .default("off")
        .description(
          "Bot 账号发出的、非本插件产生的消息（其他插件的输出、Koishi 指令回复等）是否让 Bot-LLM 看到。" +
            "开启后这类消息也会入库（消息记录中可回看）",
        ),
      selfCommands: Schema.boolean()
        .default(false)
        .description(
          "允许 Bot 触发 Koishi 指令（自己玩自己）：它发出的消息若以某个已注册指令名开头（不带前缀），" +
            "将以它自己的身份执行，指令输出照常发回频道（配合 externalSelfMessages 可让它看到结果）。" +
            "能执行哪些指令取决于 Bot 账号在 Koishi 的权限等级；本插件自身的 world 系列指令除外",
        ),
    }).description("Koishi 消息接入"),
  }),
]);
