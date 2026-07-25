# koishi-plugin-yesimbot-world

YesImBot World：让 Bot 生活在一个由 LLM 独立维护的虚拟世界中。

两个 LLM 同时运行：

- **Bot-LLM**：持续推理的 Agent，一个接一个地生成工具调用（Tool Call），像文字版 VLA——它不是在"回复消息"，而是在世界中**生活**：行动、等待、休息、翻手机、聊天。
- **World-LLM**：世界模拟引擎。无持续上下文，按需被唤起：裁定 Bot 行动的结果、响应等待到期、响应 Tingle（世界心跳）推进世界演化，并维护 `World_Status.md` 与 `News.db`。

## 提醒

这个插件需要两个 LLM 同时不间断运行，token用量会非常大，只建议本地部署的用户或使用云端按月付费计划的用户尝试。要获得不错的效果，稠密模型参数量应在 27b 以上，MoE模型参数量应在 32b 以上，并且生成速度应达到 40 tokens/s 左右。

## 架构

```
┌────────────────────────────── Koishi ──────────────────────────────┐
│  Gateway(中间件): 所有消息入库 ──┐          KoishiMessenger          │
│  Allow Notification → Event ────┤          (check_msg/send)         │
└─────────────────────────────────┼────────────────────▲─────────────┘
                                  ▼                    │
┌─────────── Bot-LLM (BotAgent) ──────────┐   ┌── World-LLM (WorldAgent) ──┐
│ 主循环: 排空事件邮箱 → 生成 Tool Call    │   │ 无状态，按需唤起            │
│         → 追加进流 → 派发执行(不等结果)  │   │ 工具: check / update /      │
│ 上下文: 置顶区(角色/历史/工具/记忆)      │◄──┤       check_time /          │
│         + Tool Call 流(只追加)          │事件│       send_event            │
│ 调度器: duration → 期望完成时刻 → Event │──►│ 维护: World_Status.md       │
└──────────────────┬──────────────────────┘act│       News.db               │
                   │                          └──────────▲─────────────────┘
              WorldClock (TU) ── Tingle 心跳 ────────────┘
```

### 数据目录（`basePath`，默认 `data/yesimbot-world`）

| 文件 | 维护者 | 说明 |
|---|---|---|
| `Bot_Definition.md` | **用户** | Bot 角色定义（创世输入） |
| `World_Definition.md` | **用户** | 世界定义（创世输入，World-LLM 的最高准则） |
| `Bot_Status.md` | Bot-LLM（经压缩流程） | Bot 当前状态，作为角色设定置顶注入 |
| `World_Status.md` | World-LLM | 世界当前状态 |
| `News.db` | World-LLM | 世界事件列表（JSONL 格式，一行一个事件） |
| `gallery/` | **用户** | 收藏夹：投放供 Bot 使用的表情包、图片与文件 |
| `assets/` | 运行时 | 媒体资产库（收到/发出的图片、音频、视频，sha256 去重） |
| `stream.jsonl` | 运行时 | Bot 工作窗口（Tool Call 流）持久化 |
| `pinned.json` | 运行时 | 置顶上下文 + id 计数器 |
| `clock.json` | 运行时 | World Clock（暂停时时间静止） |
| `archive/` | 运行时 | 压缩/重置时归档的历史 |

## 使用步骤

1. 配置插件（两个模型的 API 地址）并启用；
2. 编辑 `Bot_Definition.md` 与 `World_Definition.md`（首次启用后自动生成模板）；
3. 执行指令 `world.init` —— World-LLM 创世，生成 `Bot_Status.md` / `World_Status.md` / `News.db`；
4. 执行 `world.start` —— 世界时钟开始流动，Bot-LLM 进入持续推理。

### 指令

| 指令 | 权限 | 说明 |
|---|---|---|
| `world.init [-f]` | 3 | 创世（`-f` 归档并重新创世） |
| `world.start` / `world.stop` | 3 | 运转 / 暂停（时间静止） |
| `world.status` | 1 | 世界与 Bot 运行状态 |
| `world.reload` | 3 | 修改定义文件后重载：World-LLM 调整状态，并以世界观内方式告知 Bot |
| `world.inject <text>` | 3 | 注入一条系统事件（调试用，会唤醒等待中的 Bot） |
| `world.reset` | 4 | 归档并清空全部运行时状态（保留定义文件） |

## Bot-LLM 两种持续生成模式

### `text` 模式（推荐，llama.cpp server）

调用原生 `/completion` 端点：

- **GBNF 语法**强制输出恰好一个合法工具调用 JSON——语法完成前 EOS 被屏蔽（禁止提前停止），语法完成后仅 EOS 合法（恰好停在一个工具调用末尾）；
- 整个上下文是**单一连续文档**：`BOS + system(置顶区) + 一个永不结束的 assistant 段（Tool Call 流）`，事件以 `<event …>` 内联注入；
- `cache_prompt: true` + 确定性的追加式渲染 → KV cache 几乎全量命中；
- `rest()` 压缩后自动发送 `n_predict: 0` 请求预热 KV cache；
- 多模型代理（llama-swap）部署时填写 `model` 字段用于路由；
- 按模型调整 `template`（默认 ChatML；Gemma 用 `<start_of_turn>system\n` / `<end_of_turn>\n` / `<start_of_turn>model\n`）。

### `chat` 模式（任意 OpenAI 兼容 API）

拿到上次 Response、追加进上下文后立即再发一次请求。工具调用映射为 assistant 消息、事件映射为 user 消息（连续同角色合并，保持前缀稳定以命中服务端 prompt cache）。无语法约束，输出不合法时以系统事件形式提示重试（对 Bot 表现为"恍惚了一下"）。

> 用付费 API 时务必设置 `minIntervalMs` 节流——Bot 是**持续**请求的。

## 时间模型

- 世界以 **Time Unit (TU)** 计时：`1 TU = realSecondsPerUnit 现实秒 = worldSecondsPerUnit 世界秒`；
- `epoch` 定义 T=0 对应的世界时刻；世界暂停（`world.stop` / 插件停用）时时间静止；
- 每个工具调用由 Bot-LLM 自己估计 `duration`（耗时），期望完成时刻 = 生成时刻 + duration；
- **生成与执行解耦**：生成完一个工具调用不等待结果、立即想下一步；结果在世界到达期望完成时刻时以 Event 注入（若届时结果未就绪，则就绪后立即注入）。模型快 → 角色行动连贯；模型慢 → 角色发呆愣神——推理速度本身塑造性格；
- `send` 在期望完成时刻（打字完成）才真正发出，此前可 `cancel`（撤回还没发出去的话）；
- **Tingle**：每 `tingleEveryUnits` 个 TU 触发一次 World-LLM，推进世界演化并追加 News（只有 Bot 能感知的事才打扰它）。

## 上下文规则（缓存友好 + 拟人）

- 除压缩外**禁止修改上下文**，一切变更以 Event 形式**追加**（工具列表更新、用户改设定，均通过 Event / `world.reload` 通知）；
- 事件注入只发生在两次生成之间（当前工具调用生成完毕后统一应用）；
- 上下文超过 `maxWindowChars` 时强制触发 `rest()`，Bot 收到的解释是"你感到疲惫不堪"——符合世界观；
- `rest()` 由 World-LLM 执行压缩：合并历史摘要、更新记忆摘要、按需演化 `Bot_Status.md`（这是角色设定唯一的合法修改渠道），醒来后被告知过去了几个 TU。

## 多模态

消息中的**图片 / 音频 / 视频**会被下载进本地资产库（`basePath/assets/`，sha256 去重——平台的媒体 URL 会过期），消息记录中只存占位符。Bot 感知媒体的方式由配置决定：

1. **原生模态**（`bot.modalities.image/audio/video`）：声明 Bot-LLM 自身支持的模态。
   仅 chat 模式生效（text 模式的 `/completion` 无法输入媒体）。原生支持的模态在事件中
   以 content part 附件注入（image_url / input_audio / video_url），文本侧显示
   `[图片#12（见附件）]`。受 `media.maxAttachmentsPerEvent` 上限约束，超出部分回退解释器。
2. **外挂解释器**（`captioners.image/audio/video`）：模型不具备某模态时，外挂另一个模型
   把媒体解释为文本，Bot 看到 `[图片#12：一只橘猫瘫在键盘上]`。
   - image / video：多模态 chat completion（video 需支持 video_url 的模型，如 Qwen-VL 系）；
   - audio：默认 whisper 风格 `/v1/audio/transcriptions`，也可切换为多模态 chat（input_audio）。
   解释结果按媒体缓存（同一文件只解释一次），且为**惰性**执行——只有 Bot 真正查看
   （select_channel / 通知策略为 content）时才调用解释器；check_msg 的预览只显示 `[图片]` 标记。
3. 两者都没有：Bot 看到 `[图片#12（无法查看内容）]`——它知道那里有个媒体，但看不见内容。

### 媒体发送

Bot 不只能收，也能发：

- **发图**：`send` 的 `images` 参数附带图片编号（如 `images: ["12"]`），来源是聊天记录中
  收到过的图片（资产库）或**收藏夹**——用户把表情包/图片放进 `basePath/gallery/` 目录，
  Bot 通过 `check_gallery` 浏览（图片经解释器生成内容描述并缓存，方便它挑选合适的图）；
- **发文件**：音频、视频不能作为图片直接发送，统一走 `send_file`（引用媒体编号或
  `gallery:文件名`），按类型映射为 audio / video / file 元素（audio 在 QQ 即语音）；
- **发语音**：配置 TTS（OpenAI 兼容 `/v1/audio/speech`，如 kokoro / fish-speech / openai）后
  Bot 获得 `send_voice` 工具，把文字合成为自己的声音发出。合成的语音同样入资产库留痕
  （转写缓存 = 原文本），聊天记录回看时能"记得自己说过什么"。

三种发送都遵循"打字/说话耗时"语义：duration 到点才真正发出，此前可 `cancel` 撤回；
发出的媒体以占位符入库，之后 `select_channel` 回看自己发过的图和语音。
未配置 TTS 时 `send_voice` 不会出现在工具列表（GBNF 语法同步收窄）。

## Bot 可用工具

| 工具 | 说明 |
|---|---|
| `wait(n)` | 等待 n 个 TU，暂停生成；到期由 World-LLM 生成期间见闻并唤醒（可配置被通知打断） |
| `act(description)` | 在世界中做事，World-LLM 裁定结果 |
| `rest(duration?)` | 休息：压缩上下文 + 预热 KV cache，醒来获知流逝的 TU |
| `check_status(target)` | 查看自身（`self`）或世界（`world`，含近期 News） |
| `check_msg(n)` | 最近活跃的 n 个频道及最新一条消息 |
| `select_channel(id, n)` | 查看频道最近 n 条消息（`id` 为 `platform:channelId`） |
| `check_gallery()` | 浏览收藏夹（`basePath/gallery/`，用户投放的图片/文件） |
| `send(id, msg, images?)` | 发消息，可附图片（duration = 打字时间，发出前可撤回） |
| `send_file(id, file)` | 发送音频/视频/任意文件（媒体编号或 `gallery:文件名`） |
| `send_voice(id, text)` | TTS 合成语音消息（需配置 tts，duration = 说话时间） |
| `cancel(id)` | 取消倒计时中的工具调用 |
| `identity_recall()` | 反思身份：角色设定以 Event 再次注入 |

## 部署到 Koishi 实例（开发链接）

```bash
cd /home/username/App/Koishi # 你的Koishi实例位置
yarn add koishi-plugin-yesimbot-world@portal:/home/username/App/YesImBotWorld # 此项目的位置
```

`koishi.yml` 配置示例（本地 llama.cpp，text 模式）：

```yaml
plugins:
  yesimbot-world:
    basePath: data/yesimbot-world
    autoStart: false
    bot:
      mode: text
      baseURL: http://127.0.0.1:8080
      model: Qwen3.6
      minIntervalMs: 0
      maxWindowChars: 262144
      modalities: # text 模式下不生效，媒体一律走解释器
        image: false
        audio: false
        video: false
      template:
        systemPrefix: "<start_of_turn>system\n"
        systemSuffix: "<end_of_turn>\n"
        streamPrefix: "<start_of_turn>model\n"
    world:
      baseURL: http://127.0.0.1:8080/v1
      model: Qwen3.6
    captioners:
      image:
        enabled: true
        baseURL: http://127.0.0.1:8080/v1
        model: Gemma-4 # 需带视觉投影（mmproj）
      audio:
        enabled: false
        api: transcription # whisper 系服务
        baseURL: http://127.0.0.1:9000/v1
        model: whisper-1
      video:
        enabled: false
    tts:
      enabled: false # 启用后 Bot 获得 send_voice
      baseURL: http://127.0.0.1:8880/v1
      model: tts-1
      voice: alloy
      format: mp3
    clock:
      realSecondsPerUnit: 60
      worldSecondsPerUnit: 60
      epoch: "2026-01-01 08:00"
      tingleEveryUnits: 30
    messaging:
      notifyChannels: ["onebot:123456789"]
      notifyPolicy: channel
      wakeOnNotify: true
```

## 已知限制

- World-LLM 需要支持 OpenAI tool calling；
- 重启后未完成的动作（进行中的 act/send）不恢复，Bot 会收到"失神"事件提示自查状态；
- 工具列表按配置在启动时确定（如 TTS 开关影响 send_voice）；运行中动态增删工具（含以 Event 通知变更）留有设计位；
- 视频解释走 video_url content part（Qwen-VL 系约定），不做本地抽帧；
- 文件/媒体发送以 base64 data URL 传给适配器，超大文件受平台限制。
