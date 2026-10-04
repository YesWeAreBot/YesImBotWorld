# 工具、手机与电脑

[文档目录](README.md) · [项目首页](../README.md)

按能力查找工具，了解应用展开、现实与虚构设备，以及可选的平台扩展。

## 手机探索与自主生活

浏览器现在支持隔离的真实网页会话、可操作 DOM、表单和原生截图，默认门户提供搜索、Bilibili 与新闻入口。没有 Puppeteer 时保留文字浏览。新增后台时钟/闹钟/秒表、可配置图片模型的相机，以及可自定义名字和模型的流式问答助手；笔记可以充当剪贴板、作业本、账本和待办。设备页使用实际工具，保留共享控制与移动端输入。

相机和助手默认关闭，手机桌面仍展示设置入口与未就绪原因；可以就地填写模型配置后启用。它们只在主动使用时请求模型，不为每次决策增加额外生成。群与好友列表按页展示真实历史线索，空消息列表也可主动发现会话，每页最多补拉两个频道；历史预览不当作新通知。聊天时可回想少量自己的真实经历，区分回应别人、分享自身内容和保持安静，不设置发言配额。配置、生命周期与能力边界见 [手机应用说明](phone-apps.md)。

## Bot 可用工具

工具**按实际界面与角色状态分层展开**。新世界的初始固定说明只包含当前已开放的能力；之后每次成功压缩时，再同步当时可感知、可用的工具与原生声明快照。期间的增删与参数变化通过事件追加，立即更新实际允许列表。原生声明尚未包含的新能力可使用正文 JSON 调用，不通过逐轮重写固定块更新工具。

- **core 基础能力**：世界/身体动作、收藏夹、设备入口等；仍会按当前状态过滤；
- **chat 层**（`open_app` 打开聊天应用后）：消息列表、好友/群列表、账号设置等；
- **channel 层**（`select_channel` 进入频道页后）：发消息、撤回、贴表情等；允许省略 `id` 的操作使用当前频道，
  `send` 每次都必须明确目标 `id`，需要时由程序完成真实的前置导航；
- **group 层**（进入的频道是群聊时追加）：群信息与全部群管理操作。

默认模式下拿取手机是稳定的能力，重复拿取已在手中的正常手机不产生新的恢复事务；严格模式只在手机已放下且可达时开放。已放下时不会提供再次放下；没有打开应用、电脑或转发记录时，不提供对应关闭/退出操作。没有未提交任务时不提供 `cancel`，在本世界时不提供 `go_home`；旅行也需要有已配置、允许自主访问且当前可前往的目标。设备断线后相关操作退出实际允许集，Bot 只在能感知变化时收到对应能力事件。

`bot.thinkEnabled` 默认开启，与模型自身推理输出的开关独立。清醒时 `think` 不受连续次数或重复工具临时禁用影响；可用正文简写 `think("思考内容")`，原生工具调用仍使用 `{"thought":"思考内容"}`。连续独白仅触发可被新事件打断的短暂生成退避，不假造休息、经历或时间流逝。配置变化追加到上下文，固定工具说明在正常压缩时更新，保护前缀缓存。

### core 基础工具（按状态开放）

| 工具 | 说明 |
|---|---|
| `help(tool?)` | 查看当前能力简表，或按名称读取已知工具的完整用法；不执行操作或赋予权限 |
| `wait(n)` | 等待 n 个 TU，可被重要通知唤醒；返回实际可感知观测，不补造等待期间的经历 |
| `act(description, target?, speech?, repeat?)` | 用自然语言提出行动、可选目标与原话，提交后返回经过与结果；needs_input 停在新决定点，下一次 act 继续；相同动作尚未结束时阻止重复受理，明确要再次执行才使用 repeat |
| `rest(duration?)` | 角色主动休息，可被事件打断；记忆维护独立处理 |
| `think(thought)` | 记录角色的内心独白、打算或猜测；不产生外界事实或额外模型请求 |
| `observe_device(device)` | 只读查看可及手机/电脑的当前界面并开始关注，不拿起手机或建立设备连接 |
| `reflect(...)` / `recall_growth(scope?, event_ids?, ...)` | 引用亲历事件整理认识；按 claims / evidence / all 检索认识、原始证据或两者 |
| `check_gallery(category?)` / `check_media(n?, type?)` | 浏览收藏夹（分类总览 / 打开某一类）/ 只读翻看媒体缓存 |
| `view_media(media[])` | 发图前细看：原生识图附原图，否则解释器详述 |
| `gallery_save(media_id, category, description, name?)` | 收藏进分类（表情包 / meme / 截图 / 照片），描述必填 |
| `gallery_move(name, category, description?)` / `gallery_remove(name)` | 整理归类（「未整理」→ 分类，无描述时必须先看图补描述）/ 移出收藏夹 |
| `open_app(name)` | 打开应用：聊天应用 → 消息列表 + 解锁 chat 层；MCP/内置应用 → 展开其工具 |
| `close_app()` | 关闭当前打开的应用（其操作失效） |
| `open_computer()` / `close_computer()` | 打开/关闭 Bot 自己的电脑（与手机平级的另一台设备，Docker 终端/远程桌面，见「Bot 的个人电脑」） |
| `put_down_phone()` | 放下手机、关闭应用并清除关注；不编造放置地点，不更改通知模式或频道免打扰 |
| `pick_up_phone()` | 默认拿到可正常使用的手机；关闭 `unrestrictedPhone` 时受物理状态限制，不自动打开应用 |
| `phone_notifications(action?, id?)` | 通知中心：查看、标记已读、清除卡片；通知权限在手机设置 App 内管理 |
| `travel(world)` | 穿越到另一个世界作客（需 `crossing.worlds` 配置了可去世界）：行动由对方 World-LLM 裁定，手机/聊天照常可用，`go_home` 返回 |
| `go_home()` | 从异世界返回自己的世界 |
| `cancel(id)` | 取消尚未提交的工具调用，不能撤销已产生的副作用；已提交调用的真实回执仍会送达 |

旧 `check_status`、`check_time`、`recall` 和公开的 `observe` 工具已移除；世界中的主动查看通过 `act` 表达，使用 `recall_growth` 检索亲历与认识。`facts.jsonl` 中的旧资料仍保留供管理与审计，不自动作为角色成长的证据。

### chat / channel / group 层（节选）

| 工具 | 层 | 说明 |
|---|---|---|
| `check_msg(n)` | chat | 刷新消息列表：最近活跃的 n 个频道及最新一条消息 |
| `select_channel(id)` / `read_channel(n)` | chat / channel | 进入会话；在当前会话刷新或读取更多消息 |
| `send(msg, id, media?)` | channel | 发消息，每次必须明确填写目标频道 id，需要时自动进入；超长与冷频道刷屏会被拦下要求确认（`confirm_long` / `insist`） |
| `pick_media(media)` | channel | 确认媒体引用，不发送；在有通知的消息列表页也可按当前能力提供 |
| `channel_notify(allow?, id?, mute_seconds?)` | chat | 聊天内的频道通知与限时免打扰（自主修改需 `botManagedNotifyChannels`；按世界秒计时，持久化） |
| `view_forward(id)` / `exit_forward()` | channel | 像真人一样点开合并转发的聊天记录（`<forward id="…"/>`，支持嵌套逐层深入）、看完退出返回聊天窗口 |
| 其余 | chat/channel/group | 见下文平台扩展操作，按层展开（群管理只在群频道页可见） |

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
- **内置浏览器应用**（`apps.browserEnabled`，默认开启）：打开后显示探索门户或上次页面。
  - **现实世界设定**：安装 Puppeteer 后使用隔离的真实网页会话，支持 `search(query, provider?)`、
    `open_url`、DOM 元素点击/填写/按键/滚动、后退/前进/刷新。操作使用当前 `revision` 和元素引用，
    原生图片模型还可基于原始视口截图用 `click_point` 操作。未安装时退回文字/链接模式。
    默认搜索为 Bing，可配置备用搜索源；验证码不假装通过，可正常人工处理或换源。
  - `view_image` 查看封面等实际图片，`save_image` 保存图片；得到的 `media:N` 或图库引用
    可以通过 `send` 的内联媒体标签发送。视频页不等于看完视频；直接视频文件才可尝试 `view_video`。
  - **虚构世界设定**：只根据世界已有可见页面信息呈现 HTML，不访问真实互联网，不补造事实。
  - **历史、书签与恢复**：Bot 工具和 WebUI 均支持搜索浏览记录、打开历史页、添加/重命名/删除书签。
    页面、导航位置与可恢复的网站会话保存在本世界的 `phone-browser.json`；切换 App、暂停世界和重启后可继续浏览，随世界存档、回档和重置。
    真实网页恢复地址、滚动、Cookies 及 localStorage/sessionStorage，只加载当前页，不重放表单提交；网站登录失效或 IndexedDB 等未覆盖的页面状态仍需重新操作。
    虚拟页面保留已读内容与来源，恢复不重新生成剧情。会话凭据不会通过 WebUI 原始文件查看或 Bot 反馈泄露。
  - **截图**：真实 GUI `screenshot` 提供原始视口，不自动收藏；`save_screenshot` 合成当前页面与已保存的手机外壳，
    明确保存到「截图」分类。虚构页面截图继续使用同一份 HTML 与持久外壳。所有截图都需要 Puppeteer。
- **时钟 / 相机 / 问答助手**：时钟默认启用，其他两项配置后开启；异步任务、独立模型与场景边界见
  [手机应用说明](phone-apps.md)。
- **内置新闻应用**（`apps.newsEnabled`，默认开启）：读取存档中的新闻记录（`News.jsonl`）。
  `headlines(n?)` 看已有头条，`search_news(keyword, n?)` 按关键词搜索，
  `search_news_time(since?, until?, n?)` 按 T（时间单位）范围回看，`open_news(n)` 按列表编号展开详情。
  **现实世界设定**下，关键词搜索还会查询 `apps.newsFeeds` 中的真实 RSS，保留来源和发布时间；
  点开 RSS 条目时读取原始网页正文。当前自然语言世界心跳不再自动摘编 RSS 写入新闻日志。
  **虚构世界设定**只读已有世界新闻，不访问真实 RSS；没有记录时如实显示为空。
  RSS 源可自行配置，留空使用内置默认源；不可达时可换成运行主机能够访问的来源。
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
