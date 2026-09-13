# koishi-plugin-yesimbot-world

YesImBot World：让 Bot 生活在一个由 LLM 独立维护的虚拟世界中。

两个 LLM 分工运行：

- **Bot-LLM**：持续推理的 Agent，一个接一个地生成工具调用（Tool Call），像文字版 VLA——它不是在"回复消息"，而是在世界中**生活**：行动、等待、休息、翻手机、聊天。
- **World-LLM**：按需读取最新的自然语言世界情境与角色处境，裁定操作，直接叙述环境、行动过程和 NPC 回应，并更新状态。它不保留跨任务的完整调用历史；当前状态就是后续裁定的主要上下文。聊天和真实设备继续以实际平台回执为准。

世界内容以自然语言为主。程序保留身份、时钟、执行状态、权限、版本和事件来源等必要数据；不要求把每个地点、物品或动作拆成实体操作。[原结构化架构说明](docs/structured-world.md) 保留为旧档协议与历史设计资料，不代表当前运行主链。

## 提醒

这个插件的 Bot 持续推理，World 按操作和心跳调用，token 用量可能非常大，只建议本地部署的用户或使用云端按月付费计划的用户尝试。要获得不错的效果，稠密模型参数量应在 27b 以上，MoE模型参数量应在 32b 以上，并且生成速度应达到 40 tokens/s 左右。

## 架构

Bot 通过 `act` 表达意图，通过 `observe` 主动了解细节；行动结果、身边发生的事情和设备通知也会作为被动感知送达。World 负责环境、NPC 与身体处境，Bot 自己形成认识、意图和记忆。World 不能替受控角色作选择或编造其台词。

每次 World 任务读取最新已提交的自然语言状态，包括物理现状、未结束的交谈、NPC 当前打算和仍会影响后续的事实。World 返回更新后的情境与各角色实际能感知的自然语言结果。运行时将状态、动作结果和按角色保存的感知写入同一笔追加日志，成功保存后才交付；下一次裁定不会依赖尚未完成的后台整理。完整世界状态只供 World 和获授权的管理员读取，Bot 与访客只接收分配给自己的感知。

```mermaid
flowchart LR
  B[Bot Agent / 玩家] -->|act / observe| A[任务调度与执行控制]
  S[最新自然语言情境与角色处境] --> W[World 按需裁定并叙述]
  A --> W
  T[世界时间 / NPC] --> W
  W --> J[状态与角色感知同笔保存]
  J --> S
  J -->|按角色交付自然语言感知| B
  B -->|reflect / recall_growth| G[既有成长证据账本]
  P[聊天 / 设备实际回执] --> B
```

自然语言中的可见性、空间关系和事实承接由 World-LLM 根据规则与情境判断，程序校验收件人身份和提交边界；这不等于旧内核对位置和属性可见性的严格校验。没有后台同步维护一份完整实体图，关系自动抽取也不是当前剧情运行的前置环节。

虚构应用读取世界中已确立的设备内容，不会把用户查看文件等操作直接记成 Bot 的经历。虚构应用写入会保存设备变化和私有回执，由设备流程按关注与接管模式交付。普通世界行动与这些应用操作分开处理，真实设备继续使用实际工具。

### 数据目录（`basePath`，默认 `data/yesimbot-world`）

| 文件 | 维护者 | 说明 |
|---|---|---|
| `Bot_Definition.md` | **用户** | Bot 角色定义（创世输入；原文以「最初的设定」置顶注入，见下文上下文规则） |
| `World_Definition.md` | **用户** | 世界定义（创世输入，World-LLM 的最高准则） |
| `world-narrative.jsonl` | 自然语言世界运行时 | 当前世界情境、角色处境、动作生命周期与按角色感知的权威追加日志；同笔保存，保留版本、事件 ID 和来源用于恢复与去重 |
| `Bot_Status.md` / `World_Status.md` | 状态阅读镜像 | 旧自然语言存档的迁移来源，迁移前快照保留原文；之后从已提交日志生成当前状态镜像，不作为独立写入接口 |
| `world-transactions.jsonl` | 旧版迁移资料 | 读取旧实体状态、对话和经历用于导入；原日志保留，新世界任务不再向实体内核提交操作 |
| `growth.jsonl` | 角色成长账本 | 角色感知证据、关系、承诺、偏好及修订链 |
| `context-commit.json` | 上下文提交恢复 | 压缩切换过程中出现，完成后清除 |
| `News.jsonl` | 历史资料 | 保留原新闻；真实 RSS 在新闻应用中带来源和发布时间显示 |
| `facts.jsonl` | 历史资料 / 用户 | 保留旧小事记与固定条目；不自动升级为角色成长证据 |
| `gallery/` | **用户 + Bot** | 收藏夹，按分类子目录存放：`表情包/`、`meme/`、`截图/`、`照片/`、`未整理/`。用户手动投放的文件放进 `未整理/`（或直接丢根目录，会被自动清扫进去），Bot 有空时会看图、写描述、归类 |
| `assets/` | 运行时 | 媒体资产库（收到/发出的图片、音频、视频，sha256 去重） |
| `stream.jsonl` | 运行时 | Bot 工作窗口（Tool Call 流）持久化 |
| `pinned.json` | 运行时 | 置顶上下文 + id 计数器 |
| `clock.json` | 运行时 | World Clock（世界时间 + 创世时生成的历法） |
| `meta.json` | 运行时 | 世界元数据（创世时判定：是否现实世界设定） |
| `phoneShell.html` | World-LLM（创世生成）/ 用户 | 浏览器带壳截图的外壳 HTML（含 `{{screen}}` 等占位符，可在 WebUI「世界设定 → 浏览器外壳」页预览与编辑） |
| `focus.json` | 运行时 | Bot 正在关注的频道（关注期间消息必定完整呈现） |
| `spill/` | 运行时 | 工具结果溢出治理（`bot.spillMinChars`）裁剪后的全文落盘：`<callId>.txt`；上下文里只留 head/tail 预览，完整结果可在此审计 |
| `archive/` | 运行时 | 压缩/重置/手动存档的历史快照（每份一个时间戳文件夹，含 `manifest.json`；可在 WebUI「记事与存档」页查看、回档、删除） |

## 使用步骤

运行 Koishi 的主机需要 Node.js 22.19.0 或更新版本，与插件的 HTTP 客户端依赖要求一致。

1. 配置插件（两个模型的 API 地址）并启用；
2. 编辑 `Bot_Definition.md` 与 `World_Definition.md`（首次启用后自动生成模板）；
3. 执行指令 `world.init` —— World-LLM 写下初始情境、角色处境和感知，保存到 `world-narrative.jsonl`；
4. 执行 `world.start` —— 世界时钟开始流动，Bot-LLM 进入持续推理。

### 开放世界 WebUI

启用 `webui.enabled` 后，通过 `world.webui` 查看地址。界面以开放边界、分支路径和展开中的地貌表达世界的可能性，采用深海蓝导航、全景世界插图与清晰的阅读面板。支持桌面、平板和手机，提供深浅主题、快捷导航及 `Ctrl/⌘ K` 搜索。品牌、主视觉、空状态和侧栏图形均为原创 SVG，源码与独立资源见 [美术资源说明](src/webui/assets/README.md)，不依赖外部图片或字体。

- **世界实况**：阅读当前自然语言情境、角色处境、行动进度和最近事件，长文可展开。总览直接展示世界此刻与常驻角色的处境，快捷搜索可按名字定位角色。
- **角色与成长**：查看已经形成的关系、承诺与偏好，沿着支持、反证和修订追溯认识的依据，点击其引用的证据查看角色实际收到的观测。
- **设备工作台**：共享 Bot 当前的手机与电脑。聊天、天气、浏览器、记事本、新闻和 MCP 各有独立界面；电脑按实际模式提供终端、文件工具或远程桌面。记事本展示创建与最近编辑时间，支持按两者倒序排序；世界时间和仅有文件时间的旧笔记分组排序。
- **走进世界**：填写角色卡作为独立角色入场，或选择「仅操纵身体 / 完全入替 Bot」。页面采用固定、可收起的操作台，按名称点选能力、应用、会话与媒体；世界动作和观察目标直接用自然语言描述，无需实体 ID 或观测句柄。行动组按最新在前排列，直接展示意图、World 的自然语言经过与结果，原始回执可展开。有调用查看权限时，还能直接看到 Bot / World 流式输出。设备自动继承角色模式。
- **总览操作**：欢迎区域保留启动/暂停世界和探索世界，右侧「更多」收纳其他 `world.*` 操作。无参操作点击菜单项直接执行，需要参数时才展开表单；回执与执行记录在浮层内查看，与 Koishi 共用执行逻辑，不发送指令消息。刷新及切页保留草稿和执行状态；旧 `#commands` 地址兼容转到总览。
- **运行洞察**：合并实时调用和调试分析。顶部持续显示 Bot / World 流式输出，下方切换「调用详情」与「事件与图表」。调用默认以阅读视图展示请求消息、模型正文、思考、工具及参数，流式 SSE 会拼接为连续内容并动态更新；切换「原始数据」可查看、复制完整请求体和原始 JSON / SSE 返回。旧 `#debug` 地址兼容转到 `#live`。
- **调用状态**：待响应调用直接展示已发送的请求，琥珀呼吸灯和慢速边框流光表示等待，蓝绿流光表示生成；完成、失败与取消保留静态颜色及文字。主动阅读请求后不会被首个返回切走，返回标签以小点提示新内容。系统设置减少动态效果时保留静态指示。
- **模型用量与图表**：柱状图、事件密度和请求曲线支持横向触摸滑动、鼠标拖动、缩放与方向键选择。点击或触摸直接展开详情，不依赖悬停；刷新保留选中的时间段、缩放和滚动位置。

设备默认使用「偷偷操作」：Bot 保持自主运行，人和 Bot 可以轮流改变同一设备的界面；关注时收到可见变化，未关注时保留正常通知规则。隐藏操作不会被记作 Bot 自己发出的动作，也不会替角色写心理或原因判断。Bot 可用只读的 `observe_device` 主动查看当前可及设备。选择「强制接管」则暂停自主生成，等待已提交操作结束后进行人工操作，完成后交还。聊天发送均需在页面明确提交。远程桌面需要已有 VNC 配置；虚拟世界里的电脑会明确显示为模拟模式。接口与模式说明见 [设备工作台文档](docs/webui-devices.md)。

世界情境和角色感知以自然语言正文展示。工具参数、事件元数据与旧结构回执展开为可读字段与列表，保留原始字段名和精确的字符串值。嵌套数据可以展开，长列表和长文本按需加载更多，也可展开全文并再次收起。请求中的 Base64 图片显示为可放大的缩略图，音频可播放，文件提供名称、大小、下载和文本预览；嵌套 JSON 中的附件也按此展示。远程附件通过明确点击打开。原始 JSON 仍可展开和完整复制。

总览向访问者问候，常驻 Bot 卡片自动读取 Koishi 平台头像，优先匹配当前聊天使用的账号。调用原文保存至插件数据目录的 `webui/calls`，重启后恢复；保留最近 200 次已结束调用，正在生成的调用额外保留。32 MB 总量和 8 MB 单次限制仅用于内存缓存，长请求和附件不会因此丢失。查看返回时不下载请求体，请求在打开对应标签后按需读取。磁盘写入异常时回退内存并显示原因。旧版已经淘汰的原文无法补回。原文沿用 `debug` 查看权限，不包含 Authorization 请求头。

前端源码按功能放在 `src/webui/client/`，`src/webui/index.html` 负责组合。`npm run build` 和 `npm test` 会自动内联生成 `src/webui/page.ts`，发布时仍只有一个内嵌页面，无静态资源部署步骤。构建完成后需重新加载 Koishi 插件才能让已有服务使用新版页面。

本地开发可使用完全隔离的内存样本世界：

```bash
npm run preview:webui
# 默认 http://127.0.0.1:18131，可通过 STUDIO_PREVIEW_PORT 修改
npm run test:webui
# 需要 Node.js 22 和 Chromium；可通过 CHROMIUM_PATH 指定浏览器
```

预览页会明确标记样本数据。它不读取现有世界，不调用 LLM、聊天平台、Docker 或 VNC；消息和笔记只写入内存。浏览器测试自行启动临时预览服务，检查三种屏宽和主要交互，完成后清理服务与浏览器。设置 `STUDIO_SCREENSHOT_DIR` 可保存截图。真实 VNC 的连接与画面仍需在目标环境中验证。

### 指令

| 指令 | 权限 | 说明 |
|---|---|---|
| `world.init [-f]` | 3 | 创世（`-f` 归档并重新创世）。创世会**清空聊天消息记录**（全新的开始） |
| `world.start` / `world.stop` | 3 | 运转 / 暂停（时间静止） |
| `world.status` | 1 | 世界与 Bot 运行状态 |
| `world.reload` | 3 | 修改定义文件后重载：World-LLM 调整状态，并以世界观内方式告知 Bot |
| `world.inject <text>` | 3 | 注入一条系统事件（调试用，会唤醒等待中的 Bot） |
| `world.travel <世界名\|home>` | 3 | 穿越：把 Bot 强制送往指定异世界（填 `home` 送回自己的世界）；不填列出可去世界 |
| `world.webui` | 1 | 查看运维 WebUI 的访问地址（需已启用 `webui.enabled`） |
| `world.clearmsg` | 4 | 只清空 Bot 的聊天消息记录（不影响世界状态与定义） |
| `world.reset` | 4 | 归档并清空全部运行时状态（保留定义文件与固定的小事记） |

## WebUI 访客模式（只读 · 多账号 · 分级授权）

运维 WebUI 除了管理员（凭 `webui.token`）之外，还支持**访客账号**登录——给协作者/玩家一个**只读**视角（玩家档除外，见下文的「入世界」）。账号由管理员在 WebUI 里增删改，存 `<webuiDir>/visitors.json`。

- **多账号 + 密码哈希**：每个账号独立用户名/密码（scrypt 加盐哈希，不存明文）；密码登录后派发**短期会话 token**（内存态，12 小时 TTL，重启失效）；
- **权限实时生效**：会话只记账号 id，每次请求**实时从账号表刷新** grants/preset——管理员改权限或删账号，访客立即生效（删号即时失效）；
- **档位（preset）**决定默认可见的数据块集合（也可逐项调整成 `custom`）：
  - **operator（运维）**：全读（含 debug 原始请求/响应、config、prompts、usage），唯独默认**不看 bot_status**（运维员不看 Bot 人设/现状）；
  - **viewer（观察者）**：读世界演化产物（world_status/bot_status/news/facts/stream/notes/gallery/media/archive/devices/crossing/overview），**不看** definitions/config/prompts/debug/usage；
  - **player（玩家）**：只以「角色视角」入世界——看世界剧情（overview/world_status/news），不看 Bot 内心/状态/意识流/定义等内部；
  - **custom（自定义）**：按 16 个 grants 块开关逐项控制（overview / world_status / bot_status / news / facts / stream / notes / gallery / archive / devices / crossing / definitions / config / prompts / debug / usage）；
- **只读保证**：访客的写请求一律拒绝（服务端强制，不是靠前端藏按钮），唯独两类例外：
  - 访客可改**自己的密码**；
  - `player` 档账号可用 `/api/player/*` 执行自己的**入世界写操作**（arrive / task / leave）。

## 穿越与真人入世界

除了常驻 Bot 自己生活，世界还支持**双向互动**——Bot 穿越去别的世界作客，以及**真人**（或异世界 Bot）进来。

```mermaid
flowchart LR
  subgraph host["我方世界（Host）"]
    HOST["World-LLM<br/>自然语言裁定 / 角色感知"]
    RES["常驻 Bot"]
  end

  subgraph peer["远方世界（Peer）"]
    PEER["对方 World-LLM"]
    PBOT["对方常驻 Bot"]
  end

  subgraph player["真人玩家"]
    P1["player 档账号<br/>WebUI 入世界"]
    P2["管理员<br/>接管 Bot（同名 avatar/puppet）"]
  end

  RES -- "travel / go_home<br/>（凭邀请码作客）" --> PEER
  PBOT -- "凭我方邀请码到达" --> HOST
  P1 -- "cross" --> HOST
  P2 -- "扮演/操纵常驻 Bot" --> RES
```

### 联机穿越（`crossing.*`，Bot 到异世界作客 / 接待异世界 Bot）

- **去作客**：`crossing.worlds` 填别人分享给你的邀请码 + 地址，并允许自主前往后，Bot 可在当前能力允许时调用 `travel`（或由 `world.travel` 强制送去）；作客期间动作由宿主世界裁定，感知由宿主 World 根据角色处境裁定，程序按访客身份交付，自己的世界照常存在，`go_home` 返回；
- **接待访客**：`crossing.serverEnabled` 开启后本世界起一个 HTTP + SSE 服务（`crossing.port`，默认 18112），持有你 `crossing.invites` 邀请码的异世界 Bot 可以凭码到达（`maxVisitors` 限制同时接待数，SSE 断线 180s 自动视为离开）；
- **安全边界**：网络上只传任务与事件**文本**，**绝不传任何 LLM API 地址/密钥，也不暴露世界文件**——程序只向访客交付宿主为该角色保存的感知，不直接传递全知状态；感知正文的语义边界仍取决于宿主 World 的裁定；
- **访客档案**作为角色创作资料传递，不把其中的物品、位置或能力直接当作宿主世界的事实。旧 `visitorPersonaMode` 已停用，不再提供没有实际作用的档案工具选项。

### 真人入世界（`player` 档账号）

真人通过 WebUI 的 `player` 账号登录，以 `cross` 方式创建独立访客角色。任务按会话 ID 绑定，不能通过同名冒用他人；到达完成后才接受动作，按世界秒换算时长，离开会取消未提交任务并清理角色。

普通 NPC 的 avatar/puppet 接管暂不开放，需要进一步实现明确的角色选择和控制权移交。管理员接管常驻 Bot 保留为下面的独立功能，不创建同名副本。

### 管理员接管 Bot（手动驾驶）

管理员在「走进世界」选择**接管常驻角色**，页面自动使用 Bot 的名字和角色定义，再选择 `avatar`/`puppet`：

- **完全入替（avatar）**：暂停自主生成，由用户代替角色决定意图。调用和实际结果进入角色的意识流，离场后自然继承为自己的选择与经历；操作来源另存审计记录，不编造“醒来”或附身经历。
- **仅操纵身体（puppet）**：Bot 继续观察、回忆、反思和等待，身体与设备由用户控制。动作回执明确是非自主经历，并可唤醒仍存在的意识；角色的感受与解释由它自己形成。用户不能通过此模式替 Bot 反思或修改认识。
- 驾驶舱使用后端当前开放的工具 Schema，应用、频道、目标、消息及媒体优先按名称或摘要点选，数组和嵌套对象按字段编辑；高级原始参数保留在折叠选项中。应用/频道切换后同步能力目录。等待和休息按参数中的 TU 计时；其他工具的预计世界秒会换算为 TU，发送工具需明确确认。
- 手机上的浮动操作台适配底部导航和软键盘，可收起以阅读世界。状态更新保留当前输入、焦点和草稿；行动组汇集自然语言经过与结果；直接描述行动或观察意图，目标可填写名字或描述。旧观测中的实体按钮以名称带入目标，不再发送 `observationId`。驾驶舱镜像当前授权会话中已持久交付给 Bot 的同源感知事件，重连按稳定 ID 去重；会话仅保留最近 256 条镜像供回放，不读取全部世界日志或额外调用观察。
- 切换到设备、洞察等页面仍保留角色连接。角色模式控制设备语义，设备页不能单独解除角色接管。离场需等到已提交操作的真实回执；长期失联会收尾并归还控制。接口见 [设备与玩家文档](docs/webui-devices.md)。

群聊消息会保留频道、发言人、实际 @、引用作者和媒体类型，包括图片请求中的有序内容。新增独立 `bot.conversation` 提示词区分群友之间的讨论、直接对 Bot 的交流和表情氛围；通知和模型唤醒不等于回复义务。参与判断仍由模型结合上下文作出，既有通知/唤醒配置保持有效。

## Bot-LLM 调用协议

当前使用 `/chat/completions`，由 `bot.nativeToolCalls` 选择输出协议：

- 开启：第一次生成时冻结当时可用工具的原生 function calling 声明，直到下一次成功压缩才更新。每次请求恰好一个调用；应用原始 JSON Schema 保留嵌套结构、枚举与必填字段。期间新增工具或更新参数时，若固定声明尚未包含它们，可在正文输出一个完整 `{"name":"工具名","arguments":{},"duration":0}` 对象。
- 关闭：在正文输出一个 `{"name":"工具名","arguments":{},"duration":0}` 对象。应用展开事件附带原始参数 schema；不要求调用不存在的原生工具接口。

工具新增、失效及参数变更以事件追加，实际允许集立即更新；关闭应用后的工具即使仍在旧原生声明中，也不会执行。生成后的调用还会在派发和实际执行前复核，避免使用过期界面。没有关注的设备变化不会仅因后台工具刷新而泄露，需等到实际可感知时才更新 Bot 所知的能力。

系统提示与格式错误反馈随该开关选择。原生响应中出现多个调用会整体拒绝，不静默挑第一个执行；非法参数 JSON 也不再降级为空参数。

### 内置提示词与覆盖

WebUI 展示运行时使用的模板。自然语言 World 裁定使用 `narrativeSystem`，只读应用呈现使用 `presentationSystem`；创世辅助判定与 Bot 记忆压缩模板保持独立。主动 `observe`、入场、离开、行动与自然演化走同一套世界裁定语义，不建立跨任务的 World 对话历史。

旧结构裁定 `adjudicationSystem`、旧 `system`、`send_event` / Markdown 更新及访客叙事模板已停用，不会迁入新的 `narrativeSystem` 裁定提示。读取配置不改写原文件；首次保存时，含停用模板的原始覆盖备份到 `webui/prompts.legacy.json`。有效的用户覆盖保留，需在编辑器中「恢复默认」才采用更新后的内置文本。旧 `adjudicationSystem` 覆盖会按停用模板隔离，避免继续要求 `propose_world` 或实体操作；需要沿用的叙事风格应按新协议加入 `narrativeSystem`。World 模板保存后用于后续请求；Bot 的固定提示块在下一次成功压缩时刷新，已发送的请求与历史前缀不改写。

内置提示区分受理、提交与完成；`duration` 不承诺可撤销，`cancel` 不能回滚既有副作用。设备界面变化不自动等于角色移动或某人接管，同账号消息不自动成为 Bot 自主经历。虚构天气、网页和文件查询只呈现已知观测；命令与写文件走明确动作裁定，不能假称执行了真实操作系统命令。`rest` 是可打断计时，不宣称已恢复体力；记忆压缩也不改变身体状态。

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
- 插件离线期间错过的**群消息**：重新上线（`world.start`）时若 `messaging.offlineHistory` 开启，
  会用 OneBot 的 `get_group_msg_history` 扩展接口补拉关注中 / 通知列表 / 最近活跃的 QQ 群消息写进记录
  （翻记录时能看到，不注入逐条事件打扰上下文，完成后推一条汇总事件），与上面的世界补叙互补；
- 每个工具调用由 Bot-LLM 自己估计 `duration`（耗时），期望完成时刻 = 生成时刻 + duration；
- **生成与执行解耦**：生成完一个工具调用不等待结果、立即想下一步；结果在世界到达期望完成时刻时以 Event 注入（若届时结果未就绪，则就绪后立即注入）。模型快 → 角色行动连贯；模型慢 → 角色发呆愣神——推理速度本身塑造性格；
- `send` 通常在期望完成时刻才真正发出；启用 `bot.ignoreSendDuration` 时忽略发送耗时。`cancel` 仅能阻止尚未提交的调用，不能撤销已发送的消息；
- **Tingle**：按配置间隔请求 World 结算自然过程与 NPC 行为。更新后的自然语言状态与角色感知保存成功后才交付；自动间隔配置当前沿用基准间隔。
- `send` 的 `duration` 语义判定：系统按消息字数线性估算打字耗时（`messaging.typingCharsPerSec`），
  duration 未超过「估算 × `sendDeferFactor`」时当作打字时间照常发送；明显超过时视为「过会儿再发」的意图——
  不会自动发出，到点后系统会询问 Bot 到底要不要发（想发再调用一次 send）；延期期间若目标频道来了新消息、
  自己的账号在那边发了消息（其他插件 / 主人顶号）、或 Bot 把注意力转去了别处，这个念头会被打断并以事件告知。

## Bot 上下文规则

- 角色定义来自用户的 `Bot_Definition.md`；身体和环境来自角色可见的观测；成长单独保存在证据账本中。
- 事件在模型生成之间追加。工具接受、执行、提交与结果交付分别处理，失败不会伪装成成功。
- 固定提示块、原生工具声明和已经渲染的历史媒体在一个工作窗口内保持不变。能力变化与错误解释追加为事件，成功压缩后才切换固定块和媒体预算窗口。
- 每条意识流记录保留独立的请求消息边界；新增同角色事件也不会合并进上一条已发送消息，完整的历史消息前缀保持稳定。
- 上下文达到阈值时只请求压缩，不制造疲劳、强迫角色入睡或改写状态。
- 压缩与生成互斥；按快照清理已经成功总结的前缀，保留期间新到的事件。失败保留原流；跨文件切换可从提交记录恢复。
- `rest` 是角色主动选择的可唤醒等待。停止服务可以立刻中断，不等待睡眠时长。
- `reflect` 引用已经实际感知的事件；重复来源不会累计为新经历，反证与修订保留历史。
- `recall_growth(scope="evidence", keyword?, event_ids?, n?)` 可以检索或精确重读亲历事件，包括已从当前上下文压缩掉的证据；默认 `scope="claims"` 查询认识，`scope="all"` 同时返回两者。回忆不会制造新的经历。
- 累计至少 24 个新的独立根证据后，若仍有可整理的经历且 `reflect` 可用，系统低频追加整理提示，并列出至多 6 个可引用事件。提示不强制反思，也不保证形成结论；普通聊天、写笔记和记忆压缩不会自动创建关系、承诺或偏好。

## 上下文退化治理（防复读 / 防循环）

长时间自主运行的 LLM 会退化成几种循环：**复读同一个工具调用**、**交替循环**
（`act ↔ wait` 反复）、**口头禅式重复发言**。插件用「纵深防御」层层拦截（从最温和的提醒到最硬的阻断），
并把所有提醒文案都做成 **≥10 套字面差异大的变体随机返回**（事实值如次数/工具名/参数原样保留，只随机话术），
避免固定文案本身在长上下文里被模型无视、成为另一种循环。

```mermaid
flowchart TD
  A["检测到重复 / 循环"] --> B{"severity 分级"}
  B -- "低（连续次数少）" --> C["advisory 提醒<br/>（10 套变体随机）"]
  B -- "中（连续次数多）" --> D["递进加压提醒<br/>（点名工具 / 连击数 / 参数）"]
  B -- "高（达到 breakLoopRemoveToolAt）" --> E["暂时移除被重复的工具<br/>（下次压缩后恢复）"]
  B -- "顽固（达到 breakLoopForceRestAt）" --> F["请求记忆压缩<br/>（清掉循环历史）"]
  E --> G{"仍在重复?"}
  G -- "是" --> F
  G -- "否" --> H["循环解除"]
  C --> H
  D --> H
  F --> H
```

| 层 | 机制 | 说明 |
|---|---|---|
| 单工具复读 | **RepeatGuard**（移植 dsh 的 repeat-tool-reminder） | 按 `(工具名, 规范化参数)` 链式计数，连续相同达阈值（默认 `[3,5,8]`）注入递进提醒：首个阈值温和、后续点名工具+连击数+参数。纯 advisory，从不硬拦 |
| 交替循环 | **跨工具周期检测** | 滚动窗口识别 `act → wait → act → wait` 这类短周期反复（≥3 轮），点明「你在反复执行同一组动作」 |
| 口头禅复读 | **近 N 条发言去重**（`messaging.recentRepeatThreshold` / `recentRepeatWindow`） | 同一句话在最近 N 条里重复达到阈值就拦；**判重只按「频道 + 内容 + 图片」，忽略引用/@ 目标**——同一句话引用 A 还是 B 都是同一句 |
| 同上重复 | **same-act / same-send 拦截** | act 被 `blockingAct` 拦（上一个动作未完成）；send 与 sendBlocking 拦截，各带递进文案 |
| 压缩折叠 | **serializeForCompression** | 压缩时把「连续完全相同的工具调用」折叠成一条 + 汇总标记，避免复读正文被 World-LLM 当真实经历沉淀进摘要 |
| 结果裁剪 | **spill / prune**（`bot.spillMinChars`） | 超阈值（默认 4000 字符）的纯文本工具结果裁成「头部 + 省略 + 尾部」，全文落盘 `spill/`，防止超大结果反复占据窗口 |
| 强力兜底 | **breakLoop**（默认关） | 两段升级：先「暂时移除被重复的工具」（`breakLoopRemoveToolAt`，默认 6 次），无效再「请求记忆压缩」（`breakLoopForceRestAt`，默认 12 次）。移除的工具在下次压缩后自动恢复 |

相关配置（`bot.*`，除标注外）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `repeatThresholds` | `[3, 5, 8]` | 单工具连续重复提醒阈值（升序；`[]` 关闭） |
| `repeatExclude` | `[]` | 排除的工具名匹配（`*` 通配）；bookkeeping 工具既不计数也不重置，不会洗白循环。代码里对 `rest`/`wait` 有默认兜底 |
| `spillMinChars` | `4000` | 工具结果溢出裁剪阈值（`0` 禁用） |
| `breakLoop` | `false` | 打破死循环的强制手段总开关 |
| `breakLoopRemoveToolAt` | `6` | 连续重复达此次数暂时移除该工具 |
| `breakLoopForceRestAt` | `12` | 移除后仍重复达此次数请求记忆压缩 |
| `messaging.recentRepeatThreshold` | `1` | 近 N 条里同一句出现这么多次就拦（第 2 次拦） |
| `messaging.recentRepeatWindow` | `20` | 近期重复检测的滑动窗口条数 |

## 动作提交

`act` 先登记 pending，达到预期完成时刻后基于最新世界情境裁定。执行、观察和自然演化通过串行提交协调，避免并发任务覆盖彼此的状态。程序保留动作身份、版本、完成状态与幂等标识；它不再要求每个目标具有实体 ID 或属性版本。取消只对尚未提交的操作有效，已提交变化不能回滚。

World-LLM 直接描写完成意图所需的过程、环境变化与 NPC 回应，并把仍会影响后续的内容保留到自然语言状态中。例如“去吃饭”可以经过走到餐厅、店员询问并等待点餐；无需先创建餐厅与菜单的实体再拼接文字。探索此前未确定的细节时可依照世界设定合理确立新事实，但不能改写已经发生的事情，也不能为了必然成功而凭空提供便利条件。过程丰富度与语义一致性仍取决于模型裁定。

`completed` 表示本次意图完成，`failed` 表示未能完成；`needs_input` 表示已推进到需要新决定的地方，本次动作停止，整体目标尚未完成。界面显示“等你决定”，由 Bot 或玩家以新的 `act` 继续，不会自动替角色选择。Bot 或玩家可用 `speech` 提供自己决定说出的原话；World 必须保持原话与实际开口时机一致，不能代写受控角色的回答或心理。此前按实体操作位置插入台词的 `speechAfter` 协议不再用于新世界裁定。

`observe(intent?, target?, modality?)` 是主动观察入口，`intent` 与 `target` 使用自然语言。普通行动已包含所见所闻；需要进一步查看菜单、检查伤口或留意周围时再观察。观察可能确定此前未描写的细节：World 必须把新确定的菜单内容等事实写入状态，供后续裁定承接。角色没有打开抽屉时不能直接知道里面的东西，但这种可感知性由 World 根据情境判断，不是实体内核的空间证明。

感知回包以 `mode:"narrative"` 标识，`narrative` 和 `scene.text` 展示已保存的 World 自然语言结果，保留稳定事件 ID、世界版本、时间、动作关联与 `sourceEventIds`。场景不再由 `scene.ts` 拼接属性变化，也不再增加一次只读 LLM 润色。旧 `entities`、`experiences` 回包仍可在历史中阅读，新观测不依赖它们。`peek` 只读已保存的感知，不调用模型，也不暴露完整世界状态；主动观察可以产生新的已确认细节，重放同一感知不会变成新的成长证据。

世界情境、角色处境、动作结果与按角色感知写入同一笔 `world-narrative.jsonl` 提交，保存成功后才交付。裁定期间可查看真实 LLM 流式输出，但未提交的内容不会提前成为角色的既有经历。下一次任务读取刚提交的状态，避免旧版“先发送剧情，后台状态还没更新”造成的脱节。World 每次任务重新组织上下文，Bot 的固定提示块与既有历史仍遵循只追加和压缩后切换的规则。

从旧版本升级时，旧 Markdown 状态或实体事务日志会导入新的自然语言状态，旧资料保留。实体内核仅参与读取旧档与恢复原有感知边界，不继续驱动新剧情。既有 `growth.jsonl` 证据与认识链不重写，也不把迁移生成的重复摘要当成多份新经历；本轮没有新增后台关系图抽取系统。

## 多模态

消息中的**图片 / 音频 / 视频**会进入本地资产库（`basePath/assets/`，按 sha256 去重，以避免平台 URL 过期）。消息记录保存内部媒体引用，呈现给 Bot 时转换为统一的 `media:N`：名称、摘要和实际媒体内容紧邻同一标识，并保留文字与多张图片在原消息中的顺序。收藏夹引用使用完整的 `gallery:分类/文件名`，实际文件的哈希决定它对应哪个媒体和摘要，同名文件不会被直接视为同一张图。

1. **原生模态**（`bot.modalities.image/audio/video`）：声明 Bot-LLM 支持的输入能力。当前统一使用 `/chat/completions`，原始内容以 `image_url` / `input_audio` / `video_url` 紧跟对应媒体身份注入，不使用“第几个附件”建立对应关系。GIF 在有视频能力时使用视频通道，仅有图像能力时尝试转成拼帧图，并保留原媒体标识。
2. **外挂解释器**（`captioners.image/audio/video`）：按需生成并缓存与该媒体绑定的文字摘要，也可辅助原生观看；不具备原生能力时，仅呈现同一 `media:N` 的摘要并明确说明没有展开原始媒体。image / video 使用多模态 chat completion，audio 默认使用 `/v1/audio/transcriptions`，也可配置多模态 chat。`check_msg` 的轻量预览不触发解释器；详细查看、进入会话或内容通知才按需展开。
3. **无法查看**：没有可用原始输入或解释结果时，仍保留媒体身份并明确标记无法查看。摘要属于辅助材料，不能据此补造未看到的细节。

原生输入受以下预算约束：

| 配置 | 默认值 | 作用 |
|---|---|---|
| `media.maxAttachmentsPerEvent` | `4` | 媒体展开时的原始附件上限，超出部分保留摘要 |
| `media.maxAttachmentsPerRequest` | `8` | 工作窗口在一次请求中重发的原始附件总数上限 |
| `media.maxAttachmentMbPerRequest` | `6 MB` | 原始附件总体积上限，按 Base64 体积计算；单个过大的媒体不注入 |

每个事件首次渲染时冻结媒体内容与预算决策。新媒体超出请求预算时保留原位的身份和摘要，并请求记忆压缩；不会为了容纳新图而淘汰、替换较早的历史图片。成功压缩后才开始新的预算窗口。含原始媒体的请求遭遇 400/413 时，系统追加失败与能力降级说明，先整理上下文再尝试后续生成；整理失败保留原始经历并重试，不静默重写已经发送过的媒体前缀。遇到 413 时应核对附件预算及模型服务、反向代理的请求体上限。

### 媒体发送

Bot 不只能收，也能发：

- **发图/发视频**：`send` 的 `media` 参数使用明确引用（如 `media: ["media:12", "gallery:照片/猫.png"]`），在正文末尾追加。图文混排则在 `msg` 原位置写 `第一张 <media ref="media:12"/> 第二张 <media ref="media:27"/>`。表情包按平台要求可能独立成消息，但与前后文字、其他图片的顺序保持一致；
- **选择与发送分开**：`pick_media(media)` 只解析所选媒体，返回可用于发送的明确引用，不创建草稿、不自动发送。内容不确定时先 `view_media` 查看，再用一次完整的 `send` 提交；旧槽位与按图片序号发送的协议已停用，错误引用不会静默变成普通文本发送；
- **挑图流程**：优先翻**收藏夹**（`check_gallery`）——收藏夹按 `表情包 / meme / 截图 / 照片 / 未整理`
  分类，每项都带着 Bot 收藏时**亲笔写下的描述**（内容、梗、情绪、适用场景），描述存数据库、
  按文件哈希关联（用户手动移动/改名文件后仍能对上）。分类浏览时若 Bot-LLM 原生识图，
  会附上前几张原图直接看；光凭描述拿不准的图，Bot 会在发出前用 `view_media` 细看确认
  （原生识图 → 附原图；否则用解释器产出比常规摘要更完整的详述），避免发不合时宜的图。
  收藏夹里没有合适的，再用 `check_media` 翻看媒体缓存——聊天中见过的所有图片/语音/视频都留在
  缓存里（**对 Bot 只读**），图片会按需生成内容摘要（缓存，同一媒体只解释一次）。
  喜欢的东西 Bot 可用 `gallery_save` 存进收藏夹——**必须选定分类并写好描述**；
  不要的用 `gallery_remove` 移出；
- **用户投放**：用户可以直接把文件丢进 `basePath/gallery/未整理/`（或 gallery 根目录，会被自动
  清扫进未整理），**无须自己写描述、做分类**——Bot 之后翻收藏夹时会被提醒：有空 `view_media`
  看清内容，再用 `gallery_move` 归类并补上描述；
- **发文件**：音频、视频文件和其他文件使用 `send_file`（引用 `media:N` 或
  `gallery:分类/文件名`），按类型映射为 audio / video / file 元素（audio 在 QQ 即语音）；
- **发语音**：配置 TTS（OpenAI 兼容 `/v1/audio/speech`，如 kokoro / fish-speech / openai）后
  Bot 获得 `send_voice` 工具，把文字合成为自己的声音发出。合成的语音同样入资产库留痕
  （转写缓存 = 原文本），聊天记录回看时能"记得自己说过什么"。

发送遵循当前耗时配置；启用 `bot.ignoreSendDuration` 时忽略发送耗时。`cancel` 只阻止尚未提交的发送，最终以平台回执为准。
发出的媒体以内部引用入库，之后通过 `read_channel` 回看时仍按同一媒体身份与原位顺序呈现。
duration 明显超过按字数估算的打字时间时，视为"过会儿再发"而非打字耗时：
不自动发出，到点询问 Bot 是否要发（详见「时间模型」），延期期间的三种打断条件也会以事件告知。
未配置 TTS 时 `send_voice` 不会进入可用工具列表。

回复目标使用 `reply_to`：接受完整平台消息 ID、`msg:ID` 或 `(msg:ID)`，保留字母、符号和负号，不从文字中抽取数字。`media:12` 和 `msg:12` 属于不同命名空间，不能互换。无效引用、冲突的引用标签或旧 `images` 等发送参数会明确阻止发送；未启用引用能力时也不会静默改成普通消息。

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

**撤回感知**：别人撤回一条消息时（包括群管理员撤别人、对方撤自己的消息），消息记录里对应那条会被
改写为 `[某某 撤回了一条消息]` 标记（Bot 已看过的上下文不动——它自然记得内容，只是知道"这条被收回
去了"）；Bot 正关注该频道时会追加一条事件告知。Bot 自己撤回消息只改记录，不另行打扰。

### World 内部工具

World 模型使用 `resolve_world` 返回自然语言世界情境、角色处境、各角色感知和动作结果。运行时校验任务身份、收件人、版本与动作生命周期，再将它们同笔保存；模型没有任意文件写入或绕开提交直接投递事件的能力。地点、物件、NPC 对话与场景细节无需拆成 create/move/set 等操作。只读应用呈现仍没有工具执行或写入权限，真实设备操作继续通过对应的程序工具。

## Bot 可用工具

工具**按实际界面与角色状态分层展开**。新世界的初始固定说明只包含当前已开放的能力；之后每次成功压缩时，再同步当时可感知、可用的工具与原生声明快照。期间的增删与参数变化通过事件追加，立即更新实际允许列表。原生声明尚未包含的新能力可使用正文 JSON 调用，不通过逐轮重写固定块更新工具。

- **core 基础能力**：世界/身体动作、收藏夹、设备入口等；仍会按当前状态过滤；
- **chat 层**（`open_app` 打开聊天应用后）：消息列表、好友/群列表、账号设置等；
- **channel 层**（`select_channel` 进入频道页后）：发消息、撤回、贴表情等，**id 参数缺省为当前频道**，
  给别的频道 id 等效于先切换过去；
- **group 层**（进入的频道是群聊时追加）：群信息与全部群管理操作。

拿着手机时不会提供再次拿起的工具，已放下时不会提供再次放下；没有打开应用、电脑或转发记录时，不提供对应关闭/退出操作。没有未提交任务时不提供 `cancel`，在本世界时不提供 `go_home`；旅行也需要有已配置、允许自主访问且当前可前往的目标。设备断线后相关操作退出实际允许集，Bot 只在能感知变化时收到对应能力事件。

### core 基础工具（按状态开放）

| 工具 | 说明 |
|---|---|
| `wait(n)` | 等待 n 个 TU，可被重要通知唤醒；返回实际可感知观测，不补造等待期间的经历 |
| `act(description, target?, speech?, repeat?)` | 用自然语言提出行动、可选目标与原话，提交后返回经过与结果；needs_input 停在新决定点，下一次 act 继续；相同动作尚未结束时阻止重复受理，明确要再次执行才使用 repeat |
| `rest(duration?)` | 角色主动休息，可被事件打断；记忆维护独立处理 |
| `observe(intent?, target?, modality?)` | 用自然语言指定想了解的细节，World 裁定所见所闻并保存新确定的事实；无参数时观察周围 |
| `observe_device(device)` | 只读查看可及手机/电脑的当前界面并开始关注，不拿起手机或建立设备连接 |
| `reflect(...)` / `recall_growth(scope?, event_ids?, ...)` | 引用亲历事件整理认识；按 claims / evidence / all 检索认识、原始证据或两者 |
| `check_gallery(category?)` / `check_media(n?, type?)` | 浏览收藏夹（分类总览 / 打开某一类）/ 只读翻看媒体缓存 |
| `view_media(media[])` | 发图前细看：原生识图附原图，否则解释器详述 |
| `gallery_save(media_id, category, description, name?)` | 收藏进分类（表情包 / meme / 截图 / 照片），描述必填 |
| `gallery_move(name, category, description?)` / `gallery_remove(name)` | 整理归类（「未整理」→ 分类，无描述时必须先看图补描述）/ 移出收藏夹 |
| `open_app(name)` | 打开应用：聊天应用 → 消息列表 + 解锁 chat 层；MCP/内置应用 → 展开其工具 |
| `close_app()` | 关闭当前打开的应用（其操作失效） |
| `open_computer()` / `close_computer()` | 打开/关闭 Bot 自己的电脑（与手机平级的另一台设备，Docker 终端/远程桌面，见「Bot 的个人电脑」） |
| `put_down_phone()` | 把手机放到一边：关闭应用、清除关注，之后通知一律降级为"手机震了一下" |
| `pick_up_phone()` | 拿起手机：恢复正常通知 |
| `travel(world)` | 穿越到另一个世界作客（需 `crossing.worlds` 配置了可去世界）：行动由对方 World-LLM 裁定，手机/聊天照常可用，`go_home` 返回 |
| `go_home()` | 从异世界返回自己的世界 |
| `cancel(id)` | 取消尚未提交的工具调用，不能撤销已产生的副作用；已提交调用的真实回执仍会送达 |

旧 `check_status`、`check_time` 和 `recall` 工具已移除；使用 `observe` 获取角色可感知的状态，使用 `recall_growth` 检索亲历与认识。`facts.jsonl` 中的旧资料仍保留供管理与审计，不自动作为角色成长的证据。

### chat / channel / group 层（节选）

| 工具 | 层 | 说明 |
|---|---|---|
| `check_msg(n)` | chat | 刷新消息列表：最近活跃的 n 个频道及最新一条消息 |
| `select_channel(id)` / `read_channel(n)` | chat / channel | 进入会话；在当前会话刷新或读取更多消息 |
| `send(msg, id?, media?)` | channel | 发消息（id 缺省当前频道）；超长与冷频道刷屏会被拦下要求确认（`confirm_long` / `insist`） |
| `pick_media(media)` | channel | 确认媒体引用，不发送；在有通知的消息列表页也可按当前能力提供 |
| `send_file(file, id?)` / `send_voice(text, id?)` | channel | 发文件 / TTS 语音（需配置 tts） |
| `channel_notify(allow, id?)` | channel | 频道免打扰/开通知（需开启 `botManagedNotifyChannels`，持久化到 notify.json） |
| `view_forward(id)` / `exit_forward()` | channel | 像真人一样点开合并转发的聊天记录（`<forward id="…"/>`，支持嵌套逐层深入）、看完退出返回聊天窗口 |
| 其余 | chat/channel/group | 即上文平台扩展操作，按层展开（群管理只在群频道页可见） |

### 平台扩展操作（`platformOps.*`，每项独立开关，默认全部关闭）

收发消息之外的平台能力逐接口单独适配，用户可细粒度控制 Bot 拥有哪些能力。
配置应用后，能力差异以 Event 告知 Bot 并进入实际校验；固定工具块与原生声明在下一次成功压缩时才同步（保护前缀缓存）。

| 开关 | 工具 | 底层接口 | 说明 |
|---|---|---|---|
| `recall` | `unsend(id, msg_id)` | `delete_msg`（通用 deleteMessage） | 撤回已发出的消息 |
| `react` | `react(id, msg_id, emoji, remove?)` | `set_msg_emoji_like` / 通用 createReaction、deleteReaction | 贴/移除表情回应（emoji 字符或表情编号） |
| `emojiLikes` | `get_emoji_likes(id, msg_id, emoji)` | `fetch_emoji_like`（NapCat 特有） | 查看某条消息上某个表情回应的用户列表 |
| `reply` | `send(…, reply_to, at_sender?)` 或 msg 内 `<quote id="…"/>` 标签 | quote + at 元素（OneBot 回复） | 引用回复：是否引用、引用哪条由 Bot 自己决定（照抄入站看到的 `<quote …/>` 标签即可）；群聊里默认模拟 QQ 客户端在开头自动 @ 原发送人，Bot 可传 `at_sender: false` 去掉（如同真人删掉自动加的 @） |
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
| `groupBan` | `group_ban(id, user_id, minutes)` | `set_group_ban` | 禁言/解除禁言。低于 1 分钟（不足 60 秒）的禁言会被拦下，需加 `robot: true` 二次确认才执行 |
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
聊天操作与其他 App 一样按当前界面展开：

- `open_app(name)` 打开一个应用：
  - 打开聊天应用（名字可配置，默认 `QQ`，也认 `聊天`/`chat`/`koishi` 等别名）= 看一眼最近消息（等效 `check_msg(10)`）；
  - 打开其他应用 = 连接对应 MCP Server / 内置应用，其工具（名字、参数签名、说明）以事件展开，
    即刻加入实际允许列表（名称冲突时使用应用 ID 前缀）；固定原生声明尚未包含的新工具使用正文 JSON 协议；
- **一次只能打开一个 App**：打开新的自动关掉上一个；`close_app()` 主动关闭；
- MCP 客户端为零依赖极简实现（`initialize` / `tools/list` / `tools/call`），
  传输支持 **stdio**（本地子进程）与 **Streamable HTTP**（含 SSE 响应）；
- **内置天气应用**（`apps.weatherEnabled`，默认开启）：`query_weather(city?)`——
  现实世界设定查询真实天气（Open-Meteo，免费无需 key，可配置 `weatherDefaultCity`）；
  虚构世界设定下只查询世界已有的可见天气信息，不修改世界状态；没有已知信息时明确说明未知。
  现实/虚构在创世（`world.init`）时由 World-LLM 依据 `World_Definition.md` 判定，持久化在 `meta.json`；
- **内置浏览器应用**（`apps.browserEnabled`，默认开启）：Bot 可以上网——
  `search(query)` 搜索、`open_url(url)` 打开网址、`open_link(n)` 点开页内链接、
  `scroll_down()` 翻页、`go_back()` 后退、`screenshot(description?)` 截图：
  - **现实世界设定**：对接真实互联网。零依赖 HTML→可读文本转换（标题、正文、链接 `[n]`、
    图片 `{图n}` 编号化），搜索引擎默认 360 搜索（大陆可直连；`apps.browserSearchURL` 可换成
    DuckDuckGo Lite / 自建 SearxNG 等，360/DDG/Bing 的跳转链会自动还原为真实目标）；
    `view_image(n)` 点开页内图片细看内容（原生识图附原图，否则解释器详述——
    alt 缺失/含糊时先看再选）；`save_image(n)` 把网页里的图片存进媒体缓存（得到 `media:N`，
    可用 `send.media` 或内联媒体标签发送，也可 `gallery_save` 收藏）；页面内的 `{图n}` 仅用于选择该页图片，不能替代媒体缓存引用。
  - **虚构世界设定**：只根据世界已有的可见页面信息呈现 HTML，未知内容显示不可用，不访问真实互联网、不补造新事实或修改世界状态；文本浏览与截图使用同一份 HTML；
  - **网页截图**（两种模式都支持）：依赖 `koishi-plugin-puppeteer` 提供的 `ctx.puppeteer`
    服务（本插件保持零直接依赖，未安装时仅截图不可用、浏览照常）。现实模式无头浏览器实拍网址，
    虚构模式渲染生成的 HTML；截图自动存入收藏夹「截图」分类并记下描述。
- **内置新闻应用**（`apps.newsEnabled`，默认开启）：Bot 手机里的「新闻」App，翻阅世界的最近大事
  （`News.jsonl`，World-LLM 维护的世界中心事件）。`headlines(n?)` 看最近头条、`search_news(keyword, n?)`
  按关键词搜索、`search_news_time(since?, until?, n?)` 按 T（时间单位）范围回看、`open_news(n)` 点进某条看详情；
  列表每条带编号，Bot 能像读新闻 App 一样「点进去」读全文。
  **现实世界设定**下（`meta.json` 的 `realWorld`）：Tingle 心跳会自动抓取 `apps.newsFeeds` 配置的 RSS 源
  （免费无需 key），经 World-LLM 摘编后写入 `News.jsonl`（每条含一句标题简述 + 一段详情正文，点进去即展开）——
  对 Bot 而言这些就是它世界真实发生的新闻，与虚构世界保持一致、无需区分来源；而 `search_news(keyword)` 会**同时**
  命中世界内已记录（World-LLM 摘编）的新闻与 RSS 原文（当下真实新闻标题），合并呈现；RSS 原文点进去会实时抓取该链接的网页正文。
  RSS 源可自行配置（`apps.newsFeeds`，数组），留空用内置默认源；默认源按中国大陆服务器环境可直连优先，被墙/不可达时可替换。
- **内置文件应用**（`apps.filesEnabled`，默认关闭）：`open_computer()` 打开电脑后在
  **这台电脑**（Docker 容器）里浏览/编辑文件，提供 `list` / `show` / `write` / `patch` /
  `mkdir` / `delete`，对应真人电脑上的"文件资源管理器"。`patch` 接受 apply_patch 块
  （`*** Begin Patch` / `Add File` / `Update File` / `Delete File` / `*** End Patch`）或
  unified diff，适合精确增删改；文件操作不要再靠终端拼 shell，避免引号、换行和平台差异把文件改坏。
  工作目录之外的路径（包括经符号链接逃逸）会被拒绝。内容较长时不要一次把整份文件塞进
  `write` / `patch`：先写开头，再用 `write(path, content, append: true)` 分块追加，或只 patch 局部；
  同时建议把 `bot.maxTokens` 调到 4096 以上，避免 JSON 在闭合前被截断。

### Bot 的个人电脑（`apps.computer`）

把"指令执行"具象化成 Bot 自己的一台**电脑**：与**手机平级的另一台设备**（不是手机里的一个 App，
不在 `open_app` 的应用列表里），用 `open_computer()` / `close_computer()` 开关。实现方式由用户
在下拉框选择（`apps.computer.mode`），Docker 与远程桌面是**平级的两种实现**，且**仅在世界类型为
「现实世界」时以选定的实现生效**——不是开关，虚构世界里始终由 World-LLM 扮演这台电脑。

- **Docker 实现**（`mode: docker`，默认关闭）：一个真实存在的 Docker 容器，替代旧的
  `run_command`（直接在 Koishi 所在主机上执行命令，有较大安全风险）。打开电脑后展开
  终端（`run_command(command, cwd?)`）与资源管理器（`apps.filesEnabled` 开启时的文件操作），
  指令只在这台电脑里执行，与主机天然隔离：
  - **终端**：打开电脑才会坐到桌前，之后用 `run_command` 在终端里敲命令，每一次执行都有拟人化的
    场景（打开终端、敲下命令、屏幕上显示输出），`close_computer` 关机后失效；
  - **资源管理器**（`apps.filesEnabled`）与终端共用同一台电脑、同一个 `apps.computer.docker.workdir`
    主目录：写出来的文件在终端里也能看到，反之亦然。它在电脑内用 node 脚本执行文件操作，因此电脑
    镜像需要带 node（默认 `node:20-slim` 自带；换其他镜像时请选含 node 的，否则文件操作会报错，
    终端命令不受影响）；
  - **隔离与权限**：默认不映射任何主机目录（`apps.computer.docker.mounts` 留空时 Bot 完全碰不到
    主机文件）、网络默认 `none`（连不上外网，需要联网时改为 `bridge`/`host`）。主机目录只有显式在
    `mounts` 里声明才会被映射进电脑（建议加 `readonly`），资源上限可用 `extraArgs`
    （如 `--memory`、`--cpus`）限制；
  - 容器创建一次可复用（`apps.computer.docker.containerName`，改名即换新机），本插件自建的容器会在
    世界停止时一并关机、下次打开再自动开机。
- **远程桌面实现**（`mode: remote_desktop`，默认关闭）：不看命令行，而是**看屏幕**——Bot 的电脑
  连上一台 VNC 远程桌面（GUI Agent 思路），打开后展开 `screen`（截屏，原生图片附件注入，Bot 直接
  "看见"画面）/ `mouse`（移动/点击/拖动/滚动）/ `keyboard`（输入/组合键）。**需 `bot.modalities.image`
  开启图片多模态**，否则截屏注入不了、该模式不可用。
- **双模式**（与内置应用一致）：现实世界设定按上面选定的实现真实运转；虚构世界设定由 World-LLM
  扮演这台电脑直接生成符合世界观的终端输出与文件内容，不会真的动 Docker、也不需要远程桌面。
  现实/虚构在创世（`world.init`）时判定，持久化在 `meta.json`。

## 部署到 Koishi 实例（开发链接）

> [!IMPORTANT]
> 本插件加载入口是 `dist/index.cjs`，但 `dist/` 已被 `.gitignore` 忽略。
> 克隆或更新源码后必须先在项目目录构建一次，否则 Koishi 会报
> `Cannot find module .../koishi-plugin-yesimbot-world/dist/index.cjs`：
>
> ```bash
> cd /home/username/App/YesImBotWorld # 此项目的位置
> yarn install # 首次拉取源码时执行
> yarn build
> ```

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
      maxTokens: 4096 # write/patch 内容较长时避免 JSON 在闭合前被截断
      minIntervalMs: 0
      maxWindowChars: 262144
      repeatThresholds: [3, 5, 8] # 单工具连续重复提醒阈值（升序；[] 关闭）
      repeatExclude: []           # 排除的工具名匹配（* 通配）；bookkeeping 工具不计数也不重置
      spillMinChars: 4000         # 超大工具结果裁剪阈值（0 禁用），全文落盘 spill/
      breakLoop: false            # 打破死循环的强制手段总开关（先移工具、无效再请求记忆压缩）
      breakLoopRemoveToolAt: 6    # 连续重复达此次数暂时移除该工具
      breakLoopForceRestAt: 12    # 移除后仍重复达此次数请求记忆压缩
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
      tingleMode: fixed # fixed = 固定间隔；auto = 由 World 动态决定下一次间隔（配合 set_tingle）
      tingleMinUnits: 300 # auto 模式下间隔下限（同步模式即 5 分钟）
      tingleMaxUnits: 14400 # auto 模式下间隔上限（同步模式即 4 小时）
      offlineNarrateMinUnits: 600 # 离线达此 TU 数（同步模式即 10 分钟）时由 World-LLM 补叙离线期间的世界（0 禁用补叙）
    messaging:
      notifyChannels: ["onebot:123456789"]
      notifyPolicy: channel
      botManagedNotifyChannels: false # 允许 Bot 自管通知频道列表（channel_notify 工具，上面的列表变为初始值）
      wakeOnNotify: true
      longMessageChars: 100 # 单条消息超长提醒阈值（0 禁用）
      coldChannelMsgs: 3 # 连发几条无人回应后拦截 send 提醒别刷屏，需 insist: true 才发出（0 禁用）
      externalSelfMessages: off # 非本插件产生的 Bot 账号消息：off / simulate（伪装成 send）/ event（事件告知）/ silent（只入库，翻记录时发现）
      selfCommands: false # 允许 Bot 触发 Koishi 指令（消息以指令名开头即执行，自己玩自己；world 系列除外）
      offlineHistory: true # 重新上线时用 get_group_msg_history 补拉离线期间错过的群消息（只入库 + 汇总事件，不打扰上下文）
      typingCharsPerSec: 5 # 打字速度（字/现实秒），按消息字数线性估算打字耗时，判定 send 的 duration 语义
      sendDeferFactor: 4 # duration 超过「打字估算 × 该倍数」视为"过会儿再发"：到点询问、三类情况打断
      recentRepeatThreshold: 1 # 近 N 条里同一句出现这么多次就拦（1 = 第 2 次说同一句就拦；0 关闭）
      recentRepeatWindow: 20 # 近期重复检测的滑动窗口条数
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
    computer: # Bot 的个人电脑：与手机平级的另一台设备（open_computer / close_computer 开关）
      mode: off # 实现方式下拉框：off（不启用）/ docker（Docker 容器）/ remote_desktop（VNC 远程桌面）；仅现实世界生效
      docker: # Docker 容器实现（mode: docker 时生效）
        cli: docker # Docker CLI（可执行文件路径）
        containerName: yesimbot_bot_pc # 容器名（创建一次可复用，改名即换新机）
        image: node:20-slim # 电脑的镜像（首次开机按需拉取）
        pullPolicy: missing # missing / always / never
        workdir: /workspace # 电脑内固定主目录（终端与资源管理器的根）
        user: "1000" # 容器内执行命令的用户
        network: none # 默认断网（需要联网时改为 bridge / host）
        hostname: bot-pc
        timezone: Asia/Shanghai
        mounts: [] # 显式映射进电脑的主机目录，默认不映射（Bot 碰不到主机文件）；建议 readonly
        extraArgs: [] # docker create 附加参数，如 --memory=512m --cpus=0.5 限制资源
        commandTimeoutMs: 30000
        maxOutputChars: 20000
      remoteDesktop: # VNC 远程桌面实现（mode: remote_desktop 时生效；需 bot.modalities.image）
        host: 127.0.0.1 # VNC 服务器地址
        port: 5900
        password: "" # VNC 登录密码（留空使用无密码认证）
        maxWidth: 1024 # 截屏最大宽度（像素），等比缩小控制注入体积
        connectTimeoutMs: 10000
    apps: # 手机应用（Apps / MCP）：open_app 打开后工具才展开，一次只开一个
      chatAppName: QQ # 聊天平台在 Bot 手机里的应用名
      weatherEnabled: true # 内置天气应用（现实设定查 Open-Meteo，虚构设定由 World-LLM 生成）
      weatherDefaultCity: "" # 真实天气默认城市（留空则要求 Bot 自己给出）
      browserEnabled: true # 内置浏览器（现实设定上真互联网；虚构设定由 World-LLM 生成网页；截图需 koishi-plugin-puppeteer）
      browserSearchURL: https://www.so.com/s?q=%s # 搜索引擎（%s 为搜索词占位；默认 360，大陆可直连）
      browserProxy: "" # 代理 URL，如 http://127.0.0.1:7890；留空读取 HTTPS_PROXY / HTTP_PROXY
      newsEnabled: true # 内置新闻应用：翻阅世界最近大事（News.jsonl），看头条/关键词搜索/按时间回看；现实世界设定下 Tingle 抓取 RSS 经 World-LLM 摘编写入
      newsFeeds: [] # 现实世界新闻 RSS 源列表（留空用内置默认源；可自行配置为服务器可直连的地址）
      filesEnabled: false # 内置资源管理器：Bot 打开电脑后可查看/修改这台电脑里的文件（docker 实现或虚构世界）；默认关闭
      filesCwd: . # 资源管理器打开的工作目录，相对电脑主目录；例如 work
      mcpServers: # 外接 MCP Server：每个都是手机里的一个 App
        - enabled: true
          name: 备忘录
          description: 记录和查看备忘
          transport: stdio # stdio / http
          command: npx -y @modelcontextprotocol/server-memory
          # args: []            # stdio 参数（command 里整条写也行）
          # url: ""             # http 端点
          # headers: {}         # http 附加请求头
    webui: # 运维 WebUI：管理配置/提示词/状态/相册；另有访客账号（只读/分级授权）与玩家入世界入口
      enabled: true
      host: 127.0.0.1 # 局域网访问填 0.0.0.0（注意安全）
      port: 18111
      token: "" # 访问令牌；留空不鉴权（仅本机用）；设置后页面与 API 都要携带
    crossing: # 穿越（联机）：Bot 到异世界作客 / 接待异世界 Bot；真人入世界也用它的通道
      serverEnabled: false # 开放本世界接待异世界访客（持邀请码的 Bot 可到达）
      host: 0.0.0.0 # 接待服务监听地址（要接待别的机器需 0.0.0.0 或公网/反代）
      port: 18112 # 穿越服务端口；对方填 http://你的地址:该端口
      worldName: "" # 你的世界对外名字（访客到达时看到）
      botName: "" # 你的 Bot 去别人世界作客时用的名字（留空显示「异界来客」）
      maxVisitors: 3 # 同时接待的异世界访客上限
      invites: # 发出的邀请码列表（分享给别人，别人的 Bot 凭码到达；可随时吊销）
        - code: secret-code-1
          name: 给小明
          enabled: true
      worlds: # 可前往的异世界列表（填别人分享的邀请码 + 地址，Bot 用 travel 前往）
        - name: 阿伟的世界
          url: http://1.2.3.4:18112
          inviteCode: 对方分享的邀请码
          allowVoluntary: true # 允许 Bot 主动前往；关闭则仅能用 world.travel 强制送去
          note: "" # 世界简介（写进 travel 工具说明，帮 Bot 决定去不去）
```

## 已知限制

- World-LLM 需要支持 OpenAI tool calling；
- 物理、空间、可见性与叙事连贯性由 World 模型根据自然语言状态判断，程序不能保证这些语义判断始终正确；
- 重启不会重放孤立的未完成动作；已经提交的效果不会倒退，能恢复的持久回执继续交付。Bot 根据已有回执与新观测确认当前状态，暂停本身不被写成失神或睡眠经历；
- 工具目录受配置、当前界面、连接和角色控制状态共同约束。配置变更需要重新应用；差异追加为事件，固定块与原生声明只在成功压缩后同步；
- 平台扩展操作以 OneBot（QQ）为主；消息撤回（`platformOps.recall`）、表情回应、引用回复及 `list_friends` 走 Koishi 通用接口，
  其他平台可部分复用，其余操作仅 OneBot；扩展接口的支持范围取决于实现端（NapCat / LLOneBot / Lagrange 等）；
- 无法主动发起好友申请（OneBot 协议无此接口）；
- 好友申请/入群邀请的待处理请求（`req_N`）只保存在内存中，重启后失效；
- 视频解释走 video_url content part（Qwen-VL 系约定），不做本地抽帧；
- 文件/媒体发送以 base64 data URL 传给适配器，超大文件受平台限制；
- 终端与资源管理器只在 `apps.computer.mode` 选了 docker 且世界性质为现实世界时才真正执行命令；
  即使如此，Bot 的操作范围也被限定在这台 Docker 电脑里（默认不映射主机目录、断网、`mounts`/`extraArgs`
  显式控制权限与资源），不会触碰运行 Koishi 的主机。
## 离线回归测试

运行 `npm run check` 与 `npm test`。测试仅使用临时目录和桩，不连接当前世界、真实模型、聊天平台或 Docker；`npm run build` 生成发布产物。`npm run test:webui` 在隔离预览中用 Chromium 验证多端布局、流式原文、设备/入世界操作及图表的触摸、鼠标和键盘交互。
