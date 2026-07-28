# koishi-plugin-yesimbot-world

YesImBot World：让 Bot 生活在一个由 LLM 独立维护的虚拟世界中。

两个 LLM 同时运行：

- **Bot-LLM**：持续推理的 Agent，一个接一个地生成工具调用（Tool Call），像文字版 VLA——它不是在"回复消息"，而是在世界中**生活**：行动、等待、休息、翻手机、聊天。
- **World-LLM**：世界模拟引擎。无持续上下文，按需被唤起：裁定 Bot 行动的结果、响应等待到期、响应 Tingle（世界心跳）推进世界演化，并维护 `World_Status.md` 与 `News.db`。它只模拟 Bot 所处的虚拟世界——聊天平台属于外部真实系统，World-LLM 被明确禁止虚构平台内的事件（消息、好友申请等只能来自 Koishi）。

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
| `clock.json` | 运行时 | World Clock（世界时间 + 创世时生成的历法） |
| `meta.json` | 运行时 | 世界元数据（创世时判定：是否现实世界设定） |
| `focus.json` | 运行时 | Bot 正在关注的频道（关注期间消息必定完整呈现） |
| `archive/` | 运行时 | 压缩/重置时归档的历史 |

## 使用步骤

1. 配置插件（两个模型的 API 地址）并启用；
2. 编辑 `Bot_Definition.md` 与 `World_Definition.md`（首次启用后自动生成模板）；
3. 执行指令 `world.init` —— World-LLM 创世，生成 `Bot_Status.md` / `World_Status.md` / `News.db`；
4. 执行 `world.start` —— 世界时钟开始流动，Bot-LLM 进入持续推理。

### 指令

| 指令 | 权限 | 说明 |
|---|---|---|
| `world.init [-f]` | 3 | 创世（`-f` 归档并重新创世）。创世会**清空聊天消息记录**（全新的开始） |
| `world.start` / `world.stop` | 3 | 运转 / 暂停（时间静止） |
| `world.status` | 1 | 世界与 Bot 运行状态 |
| `world.reload` | 3 | 修改定义文件后重载：World-LLM 调整状态，并以世界观内方式告知 Bot |
| `world.inject <text>` | 3 | 注入一条系统事件（调试用，会唤醒等待中的 Bot） |
| `world.clearmsg` | 4 | 只清空 Bot 的聊天消息记录（不影响世界状态与定义） |
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

- 世界以 **Time Unit (TU)** 计时：`1 TU = realSecondsPerUnit 现实秒 = worldSecondsPerUnit 世界秒`。
  TU 是现实与虚拟世界时间换算的桥梁：插件只累计流逝的 TU，需要展示世界时刻时再叠加到初始时刻上；
- **`syncRealTime`（默认开启）**：世界时间与现实时间同步——世界时钟即现实时钟，1 TU 固定为 1 秒，
  无视 `epoch` 与流速配置（创世时也不生成自定义历法），时间无法冻结（`world.stop` 只停下 Bot 与心跳）。
  关闭后世界才拥有下述独立时间线；
- `epoch` 定义 T=0 对应的世界时刻，**自由文本**：可以是现实日期，也可以是幻想纪年（如「王历1024年 春月初三 辰时」）。
  创世（`world.init`）时 World-LLM 依据世界定义与 `epoch` 生成一套匹配的**历法**（现实公历，或自定义纪年/单位/进制）
  并持久化进 `clock.json`，此后 TU → 世界时间由代码按该历法确定性换算；
- 只有 `world.stop` 显式暂停才会冻结时间；**插件停用 / Koishi 关闭期间世界时间照常流逝**——
  重新启动时通过持久化的现实时间锚点补回离线时段，唤醒事件会告知 Bot 意识中断了多少 TU，
  离线达到 `offlineNarrateMinUnits` 时还会由 World-LLM 补叙这段时间世界发生了什么；
- 每个工具调用由 Bot-LLM 自己估计 `duration`（耗时），期望完成时刻 = 生成时刻 + duration；
- **生成与执行解耦**：生成完一个工具调用不等待结果、立即想下一步；结果在世界到达期望完成时刻时以 Event 注入（若届时结果未就绪，则就绪后立即注入）。模型快 → 角色行动连贯；模型慢 → 角色发呆愣神——推理速度本身塑造性格；
- `send` 在期望完成时刻（打字完成）才真正发出，此前可 `cancel`（撤回还没发出去的话）；
- **Tingle**：每 `tingleEveryUnits` 个 TU 触发一次 World-LLM，推进世界演化并追加 News（只有 Bot 能感知的事才打扰它）。

## 上下文规则（缓存友好 + 拟人）

- 除压缩外**禁止修改上下文**，一切变更以 Event 形式**追加**：配置变更导致工具集变化时，
  差异（新增工具的完整用法、失效工具名单）以 Event 告知并即刻生效，**置顶的工具列表保持不变**
  （保护前缀缓存），直到下次 rest 压缩时才同步；用户改设定通过 `world.reload` 以世界观内方式告知；
- 事件注入只发生在两次生成之间（当前工具调用生成完毕后统一应用）；每个调度类调用派发时立即注入
  一条"已开始执行"的确认事件——Bot 永远不会面对"没有任何反应"的信息真空，从源头消除因看不到
  结果而重复调用的问题，且不引入任何等待延迟；
- 上下文超过 `maxWindowChars` 时强制触发 `rest()`，Bot 收到的解释是"你感到疲惫不堪"——符合世界观；
- `rest()` 由 World-LLM 执行压缩：合并历史摘要、更新记忆摘要、按需演化 `Bot_Status.md`（这是角色设定唯一的合法修改渠道），醒来后被告知过去了几个 TU；
- 压缩有两道安全阀：送入 World-LLM 的意识流超过 `world.compressMaxInputChars` 时只保留最近部分
  （防止压缩请求本身超过模型窗口）；压缩失败时降级处理（归档丢弃工作窗口、沿用旧摘要），
  保证上下文一定缩小、不会陷入"压缩失败 → 立即再次强制 rest"的死循环。

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

- **发图/发视频**：`send` 的 `media` 参数附带媒体编号（如 `media: ["12"]`），支持图片与视频；
  在 `msg` 里写 `[图片#12]` / `[视频#3]` 可把媒体**嵌在文字中间**发出（图文混排，支持混排的
  平台原样呈现，QQ 等平台由平台自行分开显示）；
- **挑图流程**：优先翻**收藏夹**（`check_gallery`）；收藏夹里没有，再用 `check_media` 翻看
  媒体缓存——聊天中见过的所有图片/语音/视频都留在缓存里（**对 Bot 只读**），图片会按需生成
  内容摘要（缓存，同一媒体只解释一次）。喜欢的东西 Bot 可用 `gallery_save` 存进收藏夹
  （存入时生成摘要、可起名），不要的用 `gallery_remove` 移出；用户也可以直接向
  `basePath/gallery/` 目录投放文件；
- **发文件**：音频、视频文件和其他文件统一走 `send_file`（引用媒体编号或
  `gallery:文件名`），按类型映射为 audio / video / file 元素（audio 在 QQ 即语音）；
- **发语音**：配置 TTS（OpenAI 兼容 `/v1/audio/speech`，如 kokoro / fish-speech / openai）后
  Bot 获得 `send_voice` 工具，把文字合成为自己的声音发出。合成的语音同样入资产库留痕
  （转写缓存 = 原文本），聊天记录回看时能"记得自己说过什么"。

发送都遵循"打字/说话耗时"语义：duration 到点才真正发出，此前可 `cancel` 撤回；
发出的媒体以占位符入库，之后 `select_channel` 回看自己发过的图和语音。
未配置 TTS 时 `send_voice` 不会出现在工具列表（GBNF 语法同步收窄）。

另外两条拟人化约束：

- **短消息**：Prompt 要求 Bot 像真人一样发短消息；`msg` 超过 `messaging.longMessageChars`
  （默认 100 字符）时不会发出，而是提醒 Bot 拆分或加 `confirm_long: true` 二次确认（发长文资料时用）；
- **频道 id 纠错**：Bot 把频道 id 写错时（如把用户名当频道 `onebot:TouchNight`），插件会用
  已知频道的参与者模糊匹配，**不执行发送**，而是以事件提示正确的频道 id 让它下次填对。

### 指令消息与外部自发消息

- 他人发送的**指令消息**（如 `world.status`）与普通消息一视同仁：照常入库、按通知策略投递给
  Bot（指令本身也照常执行，互不影响）；
- `messaging.externalSelfMessages`（默认 `off`）控制 Bot 账号发出的、**非本插件产生**的消息
  （其他插件的输出、Koishi 指令回复等）是否让 Bot-LLM 看到：
  - `simulate`：伪装成 Bot 自己的 `send` 工具调用注入流——Bot 会以为是自己发的（适合特殊玩法）；
  - `event`：以事件告知"你的账号发出了一条消息，但那不是你发的"——Bot 知情但不认领；
  - `silent`：不做任何通知，只是像普通消息一样入库（发送者是 Bot 自己的账号）——
    等 Bot 之后翻看聊天记录（`select_channel`）时自己"意外发现"；
  - 各模式下这类消息都会入库，`select_channel` 可回看；本插件自己发的消息通过内部标记区分，
    不会被重复上报。

## Bot 可用工具

工具**模仿真实手机分层展开**：只有 core 层进置顶列表（省上下文），其余层在打开应用/进入频道时
以事件展开用法，并动态加入允许列表与 GBNF 语法（关闭/离开后失效）：

- **core 常驻**：世界/身体动作、收藏夹、手机的物理动作（open_app / put_down_phone 等）；
- **chat 层**（`open_app` 打开聊天应用后）：消息列表、好友/群列表、账号设置等；
- **channel 层**（`select_channel` 进入频道页后）：发消息、撤回、贴表情等，**id 参数缺省为当前频道**，
  给别的频道 id 等效于先切换过去；
- **group 层**（进入的频道是群聊时追加）：群信息与全部群管理操作。

### core 常驻工具

| 工具 | 说明 |
|---|---|
| `wait(n)` | 等待 n 个 TU（计时器准时唤醒）；现实等待达 `waitNarrateMinRealSeconds` 时由 World-LLM 提前生成期间见闻随唤醒送达 |
| `act(description)` | 在世界中做事，World-LLM 裁定结果 |
| `rest(duration?)` | 休息：压缩上下文 + 预热 KV cache，醒来获知流逝的 TU（打开的应用自动关闭） |
| `check_status(target)` | 查看自身（`self`）或世界（`world`，含近期 News） |
| `check_time()` | 看一眼现在几点（世界裁定能否得知） |
| `check_news(n?)` | 回看世界近期新闻/见闻 |
| `check_gallery()` / `check_media(n?, type?)` | 浏览收藏夹 / 只读翻看媒体缓存 |
| `gallery_save(media_id, name?)` / `gallery_remove(name)` | 收藏夹管理 |
| `open_app(name)` | 打开应用：聊天应用 → 消息列表 + 解锁 chat 层；MCP/内置应用 → 展开其工具 |
| `close_app()` | 关闭当前打开的应用（其操作失效） |
| `put_down_phone()` | 把手机放到一边：关闭应用、清除关注，之后通知一律降级为"手机震了一下" |
| `pick_up_phone()` | 拿起手机：恢复正常通知 |
| `cancel(id)` | 取消倒计时中的工具调用 |
| `identity_recall()` | 反思身份：角色设定以 Event 再次注入 |

### chat / channel / group 层（节选）

| 工具 | 层 | 说明 |
|---|---|---|
| `check_msg(n)` | chat | 刷新消息列表：最近活跃的 n 个频道及最新一条消息 |
| `select_channel(id, n)` | chat | 点进一个频道查看最近 n 条消息，进入频道页（解锁 channel/group 层） |
| `send(msg, id?, media?)` | channel | 发消息（id 缺省当前频道）；超长与冷频道刷屏会被拦下要求确认（`confirm_long` / `insist`） |
| `send_file(file, id?)` / `send_voice(text, id?)` | channel | 发文件 / TTS 语音（需配置 tts） |
| `channel_notify(allow, id?)` | channel | 频道免打扰/开通知（需开启 `botManagedNotifyChannels`，持久化到 notify.json） |
| 其余 | chat/channel/group | 即上文平台扩展操作，按层展开（群管理只在群频道页可见） |

### 平台扩展操作（`platformOps.*`，每项独立开关，默认全部关闭）

收发消息之外的平台能力逐接口单独适配，用户可细粒度控制 Bot 拥有哪些能力。
开关变化以 Event 告知 Bot 并即刻生效；置顶工具列表在下次 rest 压缩时才同步（保护前缀缓存）。

| 开关 | 工具 | 底层接口 | 说明 |
|---|---|---|---|
| `recall` | `recall(id, msg_id)` | `delete_msg`（通用 deleteMessage） | 撤回已发出的消息 |
| `react` | `react(id, msg_id, emoji, remove?)` | `set_msg_emoji_like` / 通用 createReaction、deleteReaction | 贴/移除表情回应（emoji 字符或表情编号） |
| `emojiLikes` | `get_emoji_likes(id, msg_id, emoji)` | `fetch_emoji_like`（NapCat 特有） | 查看某条消息上某个表情回应的用户列表 |
| `reply` | `send(…, reply_to, at_sender?)` | quote + at 元素（OneBot 回复） | 引用回复：是否引用、引用哪条由 Bot 自己决定；群聊里默认模拟 QQ 客户端在开头自动 @ 原发送人，Bot 可传 `at_sender: false` 去掉（如同真人删掉自动加的 @） |
| `forwardMsgs` | `forward_msgs(id, msg_ids)` | `send_group_forward_msg` / `send_private_forward_msg` | 把几条已有消息打包成聊天记录合并转发 |
| `poke` | `poke(id, user_id?)` | `friend_poke` / `group_poke` | 戳一戳 |
| `handleRequests` | `handle_request(request_id, approve, reason?)` | `set_friend_add_request` / `set_group_add_request` | 处理好友申请与入群邀请/申请（请求以手机通知事件告知 Bot） |
| `listFriends` | `list_friends()` | `get_friend_list`（通用） | 好友列表（含可 send 的频道 id） |
| `userInfo` | `user_info(user_id)` | `get_stranger_info` | 查看用户资料 |
| `sendLike` | `send_like(user_id, times?)` | `send_like` | 资料卡点赞 |
| `deleteFriend` | `delete_friend(user_id)` | `delete_friend` | 删除好友（谨慎开启） |
| `profile` | `set_profile(nickname?, signature?, avatar?)` | `set_qq_profile` / `set_qq_avatar` | 改自己的昵称/签名/头像 |
| `modelShow` | `set_model_show(model)` | `set_model_show` | 改资料卡上显示的在线机型 |
| `ocrImage` | `ocr_image(image)` | `ocr_image` | 识别图片中的文字（与解释器互补，拿到精确文本） |
| `listGroups` | `list_groups()` | `get_group_list` | 群列表 |
| `groupInfo` | `group_info(id)` | `get_group_info` | 群信息 |
| `listMembers` | `list_members(id)` | `get_group_member_list` | 群成员列表 |
| `memberInfo` | `member_info(id, user_id)` | `get_group_member_info` | 群成员详情 |
| `groupHonor` | `group_honor(id)` | `get_group_honor_info` | 群荣誉（龙王、群聊之火等） |
| `groupFiles` | `group_files(id, folder_id?)` | `get_group_root_files` / `get_group_files_by_folder` | 浏览群文件与文件夹（只读） |
| `groupCard` | `set_group_card(id, card)` | `set_group_card` | 改自己在群里显示的名称 |
| `groupName` | `set_group_name(id, name)` | `set_group_name` | 改群名 |
| `groupPortrait` | `set_group_portrait(id, image)` | `set_group_portrait` | 改群头像 |
| `groupNotice` | `send_group_notice(id, content)` | `_send_group_notice` | 发群公告 |
| `getGroupNotice` | `get_group_notice(id)` | `_get_group_notice` | 查看群公告列表 |
| `essence` | `set_essence(msg_id, remove?)` | `set_essence_msg` / `delete_essence_msg` | 设置/移出群精华 |
| `essenceList` | `get_essence_list(id)` | `get_essence_msg_list` | 查看群精华消息列表 |
| `groupSign` | `group_sign(id)` | `set_group_sign` / `send_group_sign` | 群打卡 |
| `groupBan` | `group_ban(id, user_id, minutes)` | `set_group_ban` | 禁言/解除禁言 |
| `groupWholeBan` | `group_whole_ban(id, enable)` | `set_group_whole_ban` | 全员禁言 |
| `groupKick` | `group_kick(id, user_id, block?)` | `set_group_kick` | 移出群成员（谨慎开启） |
| `groupAdmin` | `group_admin(id, user_id, enable)` | `set_group_admin` | 设置/取消管理员（需群主） |
| `specialTitle` | `set_special_title(id, user_id, title)` | `set_group_special_title` | 授予专属头衔（需群主） |
| `groupLeave` | `group_leave(id)` | `set_group_leave` | 退群（谨慎开启） |

说明：

- 开启 `recall` / `react` / `reply` / `forwardMsgs` / `emojiLikes` / `essence` 任意一项后，消息记录与发送结果会附带 `(msg:xxx)` 消息编号供引用；
- 标准 OneBot v11 之外的扩展接口（贴表情、戳一戳、改资料/头像、群打卡等）需要实现端支持
  （NapCat / LLOneBot / Lagrange 等，支持范围各有差异，不支持时 Bot 会收到明确的失败提示）；
- **无法主动添加好友**：OneBot 协议没有"发起好友申请"的接口（QQ 协议限制），只能处理收到的申请。

### 手机应用（Apps / MCP，`apps.*`）

对 Bot 来说，**MCP Server 就是手机/电脑里的 App**——如同 Koishi 是手机里的聊天平台，
只不过聊天平台的能力常驻工具位，而 App 的操作不占常驻位、按需展开：

- `open_app(name)` 打开一个应用：
  - 打开聊天应用（名字可配置，默认 `QQ`，也认 `聊天`/`chat`/`koishi` 等别名）= 看一眼最近消息（等效 `check_msg(10)`）；
  - 打开其他应用 = 连接对应 MCP Server / 内置应用，其工具（名字、参数签名、说明）以事件展开，
    即刻可像普通工具一样调用（动态加入允许列表与 GBNF 语法，工具名与常驻工具冲突时加 `应用名.` 前缀）；
- **一次只能打开一个 App**：打开新的自动关掉上一个；`close_app()` 主动关闭；`rest` 睡醒后自动关闭；
- MCP 客户端为零依赖极简实现（`initialize` / `tools/list` / `tools/call`），
  传输支持 **stdio**（本地子进程）与 **Streamable HTTP**（含 SSE 响应）；
- **内置天气应用**（`apps.weatherEnabled`，默认开启）：`query_weather(city?)`——
  现实世界设定查询真实天气（Open-Meteo，免费无需 key，可配置 `weatherDefaultCity`）；
  虚构世界设定由 World-LLM 生成，并把天气写进 `World_Status.md`，保证连续查询与世界裁定一致。
  现实/虚构在创世（`world.init`）时由 World-LLM 依据 `World_Definition.md` 判定，持久化在 `meta.json`。

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
      waitNarrateMinRealSeconds: 300 # wait 的现实时长达此值时，快结束前由 World-LLM 补叙期间见闻（0 从不补叙）
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
      syncRealTime: true # 世界时间与现实同步（1 TU 固定 1 秒，无视下面三项；时间无法冻结）
      realSecondsPerUnit: 1 # 以下三项仅在 syncRealTime: false 时生效
      worldSecondsPerUnit: 1
      epoch: "2026-01-01 08:00" # 自由文本，幻想纪年亦可（创世时由 World-LLM 生成匹配的历法）
      tingleEveryUnits: 1800 # 每 1800 TU（同步模式即 30 分钟）一次世界心跳
      offlineNarrateMinUnits: 600 # 离线达此 TU 数（同步模式即 10 分钟）时由 World-LLM 补叙离线期间的世界（0 禁用补叙）
    messaging:
      notifyChannels: ["onebot:123456789"]
      notifyPolicy: channel
      botManagedNotifyChannels: false # 允许 Bot 自管通知频道列表（channel_notify 工具，上面的列表变为初始值）
      wakeOnNotify: true
      longMessageChars: 100 # 单条消息超长提醒阈值（0 禁用）
      coldChannelMsgs: 3 # 连发几条无人回应后拦截 send 提醒别刷屏，需 insist: true 才发出（0 禁用）
      externalSelfMessages: off # 非本插件产生的 Bot 账号消息：off / simulate（伪装成 send）/ event（事件告知）/ silent（只入库，翻记录时发现）
    platformOps: # 平台扩展操作，每项独立开关（默认全部 false，此处为示例）
      recall: true
      react: true
      emojiLikes: false
      reply: true
      forwardMsgs: false
      poke: true
      handleRequests: true
      listFriends: true
      userInfo: false
      sendLike: false
      deleteFriend: false
      profile: false
      modelShow: false
      ocrImage: false
      listGroups: false
      groupInfo: false
      listMembers: false
      memberInfo: false
      groupHonor: false
      groupFiles: false
      groupCard: false
      groupName: false
      groupPortrait: false
      groupNotice: false
      getGroupNotice: false
      essence: false
      essenceList: false
      groupSign: false
      groupBan: false
      groupWholeBan: false
      groupKick: false
      groupAdmin: false
      specialTitle: false
      groupLeave: false
    apps: # 手机应用（Apps / MCP）：open_app 打开后工具才展开，一次只开一个
      chatAppName: QQ # 聊天平台在 Bot 手机里的应用名
      weatherEnabled: true # 内置天气应用（现实设定查 Open-Meteo，虚构设定由 World-LLM 生成）
      weatherDefaultCity: "" # 真实天气默认城市（留空则要求 Bot 自己给出）
      mcpServers: # 外接 MCP Server：每个都是手机里的一个 App
        - enabled: true
          name: 备忘录
          description: 记录和查看备忘
          transport: stdio # stdio / http
          command: npx -y @modelcontextprotocol/server-memory
          # args: []            # stdio 参数（command 里整条写也行）
          # url: ""             # http 端点
          # headers: {}         # http 附加请求头
```

## 已知限制

- World-LLM 需要支持 OpenAI tool calling；
- 重启后未完成的动作（进行中的 act/send）不恢复，Bot 会收到"失神"事件提示自查状态；
- 工具列表按配置在启动时确定（如 TTS / platformOps 开关）；配置变更后重启，差异以 Event 告知 Bot、置顶列表在下次 rest 时同步；
- 平台扩展操作以 OneBot（QQ）为主；`recall` / `react` / `reply` / `list_friends` 走 Koishi 通用接口，
  其他平台可部分复用，其余操作仅 OneBot；扩展接口的支持范围取决于实现端（NapCat / LLOneBot / Lagrange 等）；
- 无法主动发起好友申请（OneBot 协议无此接口）；
- 好友申请/入群邀请的待处理请求（`req_N`）只保存在内存中，重启后失效；
- 视频解释走 video_url content part（Qwen-VL 系约定），不做本地抽帧；
- 文件/媒体发送以 base64 data URL 传给适配器，超大文件受平台限制。
