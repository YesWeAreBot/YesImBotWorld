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
}

export interface ClockConfigData {
  realSecondsPerUnit: number;
  worldSecondsPerUnit: number;
  epoch: string;
  tingleEveryUnits: number;
}

export type NotifyPolicy = "count" | "channel" | "content";

export interface MessagingConfig {
  notifyChannels: string[];
  notifyPolicy: NotifyPolicy;
  wakeOnNotify: boolean;
  focusDurationUnits: number;
}

export interface Config {
  basePath: string;
  autoStart: boolean;
  bot: BotModelConfig;
  world: WorldModelConfig;
  clock: ClockConfigData;
  messaging: MessagingConfig;
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
      maxTokens: Schema.natural().default(1024).description("单次生成的最大 token 数（一个工具调用通常很小，思考型模型可调大）"),
      disableThinking: Schema.boolean()
        .default(false)
        .description(
          "关闭模型思维链（对支持开关思考模式的模型生效，如 Qwen3 系）。" +
            "请求会附带 enable_thinking: false 与 chat_template_kwargs.enable_thinking: false。" +
            "生成工具调用不需要深度思考，关闭可显著提速省钱。仅 chat 模式生效",
        ),
      blockingAct: Schema.boolean()
        .default(false)
        .description(
          "act() 是否阻塞后续生成：开启后 Bot 在动作完成前不会生成下一个工具调用" +
            "（一个人同时只能专注做一件事）。期间收到重要通知仍会被唤醒，动作会继续在后台进行",
        ),
      maxWindowChars: Schema.natural()
        .default(32000)
        .description("上下文预算（近似字符数）。超出后强制触发 rest() 压缩上下文"),
      minIntervalMs: Schema.natural()
        .default(1000)
        .description("两次生成之间的最小间隔（毫秒）。防止对付费 API 过度请求；本地模型可设为 0"),
      retryDelayMs: Schema.natural().default(5000).description("生成失败后的重试等待（毫秒）"),
      modalities: Schema.object({
        image: Schema.boolean().default(false).description("模型原生支持图片输入"),
        audio: Schema.boolean().default(false).description("模型原生支持音频输入"),
        video: Schema.boolean().default(false).description("模型原生支持视频输入"),
      }).description(
        "Bot-LLM 的原生多模态能力（仅 chat 模式生效；text 模式的 /completion 无法输入媒体，一律使用外挂解释器）。" +
          "原生支持的模态会以 content part 附件注入上下文；未支持的模态回退到外挂解释器",
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
          "关闭模型思维链（对支持开关思考模式的模型生效，如 Qwen3 系）。" +
            "请求会附带 enable_thinking: false 与 chat_template_kwargs.enable_thinking: false",
        ),
      maxToolRounds: Schema.natural().default(8).description("单次响应中允许的最大工具调用轮数"),
    }).description("World-LLM：维护世界状态、裁定事件的模型（也负责上下文压缩与初始化）"),
  }),

  Schema.object({
    clock: Schema.object({
      realSecondsPerUnit: Schema.number()
        .min(0.1)
        .default(60)
        .description("1 个 Time Unit 等于现实世界多少秒（世界时间流速）"),
      worldSecondsPerUnit: Schema.number()
        .min(1)
        .default(60)
        .description("1 个 Time Unit 在虚拟世界内代表多少秒（用于换算世界时钟显示）"),
      epoch: Schema.string()
        .default("2026-01-01 08:00")
        .description("世界初始时刻（T=0 对应的世界时间）"),
      tingleEveryUnits: Schema.number()
        .min(0)
        .default(30)
        .description("每过多少个 Time Unit 产生一次 Tingle（触发 World-LLM 推进世界、生成 News）。0 表示禁用"),
    }).description("World Clock"),
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
      captionTimeoutMs: Schema.natural().default(60000).description("单次解释调用的超时（毫秒）"),
    }).description("媒体处理"),
  }),

  Schema.object({
    messaging: Schema.object({
      notifyChannels: Schema.array(Schema.string())
        .default([])
        .description('Allow Notification 频道列表，格式 "platform:channelId"（如 "onebot:123456"）。"*" 表示所有频道'),
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
        .default(30)
        .description(
          "Bot 打开频道（select_channel）或向频道发送消息后，持续关注该频道多少个 Time Unit。" +
            "关注期间该频道的消息无视通知策略与频道列表，必定呈现完整内容；" +
            "Bot 可用 put_down_phone 主动放下手机。0 表示禁用关注机制",
        ),
    }).description("Koishi 消息接入"),
  }),
]);
