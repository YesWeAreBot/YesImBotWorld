# WebUI 设备接口

设备页共享 Bot 当前手机、电脑和应用状态。管理员操作通过 Bot 的实际工具分发与调度器执行，不会为每个浏览器另建一台设备。界面默认使用“偷偷操作”，也可明确点击“强制接管”。

## 两种操作语义

`POST /api/device/tool` 支持 `mode:"stealth"|"takeover"`，省略时使用 `takeover` 以兼容原客户端。

- **偷偷操作**：不暂停 Bot，也不取消它的等待、行动或尚未完成的发送意图。人和 Bot 的实际设备操作共享单次执行队列；每次动作结束即释放设备，不锁住模型推理。双方可以在操作之间切换应用或开关电脑，排队调用在真正执行前会重新校验工具与应用，界面已改变时返回失败，不能把旧操作错发到新应用。
- **强制接管**：先通过 control 暂停自主生成并等待已提交操作；随后以 takeover 调工具。交还也必须得到 control 的真实响应。本地切换表单模式不会改变 Bot 的暂停状态。

偷偷调用的原始工具参数、开始确认和完整回执仅返回管理员，不伪装成 Bot 自己发出的调用。Bot 的注意力依据它实际执行的设备工具，使用某台设备后保留该设备的关注；世界行动、明确观察周围、休息或穿越会移开关注。查时间、查状态或观察自身保留原关注。这是操作级注意力记录，不推测角色心理或世界中的视线几何。

Bot 可以用核心只读工具 `observe_device(device:"phone"|"computer")` 主动查看当前界面并恢复该设备的可用工具认知，不需要先开关应用。它不会拿起手机、启动电脑、连接 VNC 或执行应用工具；电脑关闭时只返回关闭状态。手机放下后默认不看屏幕，但明确调用此工具可看放在身边的屏幕，`phone.down` 与通知规则不变。当前设备没有空间位置或遮挡绑定，这个入口限于角色当前可及的随身/在用设备，不证明远处或被遮挡屏幕可见。设备页不能通过偷偷调用此工具强行改变 Bot 的关注。

只有 Bot 当时关注的设备发生变化，才投递中性的当前界面变化与可见内容；真实远程桌面可补充一帧当前图像。事件不指认操作者，不替角色写疑惑、恐惧或因果解释。未关注时，不注入偷偷操作事件，也不通过模型工具声明提前透露新开的应用；既有消息通知与手机振动继续走原来的感知规则。Bot 下一次主动查看设备时会同步它实际看到的状态。

偷偷模式可在手机已放下时操作应用，但不能代理角色的 `pick_up_phone/put_down_phone` 身体动作。发送必须明确确认，并在 `send` 中提供完整 `msg` 和可选 `media`；图文混排使用 `<media ref="media:12"/>` 指定插入位置。`pick_media` 只解析媒体引用，不保存待发草稿，也不自动发送。强制接管保留当前可用的工具能力。

## 角色接管时的设备语义

管理员从「走进世界」接管常驻角色后，`control.residentMode` 为 `puppet` 或 `avatar`。设备调用自动继承该角色模式，客户端传入的 `mode` 不能覆盖它；`POST /api/device/control` 会拒绝单独暂停或恢复，需从角色驾驶舱归还控制。puppet 的设备操作作为非自主身体经历交付，Bot 意识继续运行；avatar 的操作作为角色自己的意图与实际经历保存。

此时允许随身体控制拿起/放下手机；界面按 `busy` 等待在途操作，不要求 puppet 的 `paused` 为 true。回执保留真实副作用与媒体内容。角色连接跨 WebUI 路由维持，进入设备页不会触发离场计时；真正失联则由服务端收尾。

## 权限与接管

`/api/device/*` 仅管理员可用，使用现有 WebUI `Authorization: Bearer <token>` 鉴权。若部署没有设置 `webui.token`，遵循现有无令牌管理员模式。普通查看者与玩家不能操作设备；拥有 `devices` 查看权限的访客可读取旧的 `/api/devices` 摘要和已连接电脑的 `/api/computer/screen`，不能获取完整设备会话、消息和工具列表。

| 请求 | 用途 |
| --- | --- |
| `GET /api/device/session` | 读取状态、已安装应用、当前可用工具及 JSON Schema、缓存应用回执、当前频道本地消息 |
| `POST /api/device/control`，`{"paused":true}` | 暂停 Bot 自主生成，取消尚未提交的调度工作，申请设备控制 |
| `POST /api/device/control`，`{"paused":false}` | 当前工作结束后释放按住的键鼠，恢复 Bot 自主生成 |
| `POST /api/device/tool` | 执行当前开放的一个设备工具 |

接管响应为 `{ok, paused, busy, text}`。`paused:true,busy:true,ok:false` 表示自主生成已暂停，但既有操作正在提交；必须等待真实回执，并重新读取 session，直到 `paused:true,busy:false` 才能操作。Bot 忙碌时仍允许申请接管。交还遇到 busy 会保持暂停，不能把失败响应显示成已恢复。控制是服务级共享状态，多个管理员浏览器使用同一输入队列，不具备独立控制租约。

GET 不打开应用、不连接 VNC、不调用模型、不刷新 Bot 观测或发送消息。会话中的聊天记录来自本地消息库；读取它不会要求平台拉取新消息。管理员 POST、底层应用打开和工具执行可能访问真实平台或模型。

## 会话与调用格式

会话结构的关键字段如下，字段值只是格式示例：

```json
{
  "running": true,
  "control": {"paused": false, "residentMode": null, "busy": true, "deviceBusy": false, "attention": "phone"},
  "devices": {
    "computer": {"mode": "remote_desktop", "effectiveMode": "remote_desktop", "on": "电脑", "docker": null, "remote": {"host": "configured-host", "port": 5900, "connected": true}},
    "phone": {"down": false, "appOpen": "聊天", "chatOpen": true, "channelKey": "onebot@account:channel", "channelIsGroup": false, "chatAppName": "聊天", "resolution": {"width": 390, "height": 844}}
  },
  "apps": [{"id": "chat", "name": "聊天", "kind": "chat", "description": "聊天应用", "active": true}],
  "tools": [{"name": "send", "device": "phone", "effect": "send", "description": "发送消息", "inputSchema": {"type": "object", "properties": {"msg": {"type": "string"}}}}],
  "appView": null,
  "computerView": null,
  "chat": {"channelKey": "onebot@account:channel", "channels": [], "messages": []}
}
```

`apps` 是实际安装目录。聊天应用的 `id` 以服务器返回值为准。`appView` 是当前应用的 `{id,name,opening?,lastTool?,result?}`；`computerView` 为 `{lastTool?,result?}`。这些是已有回执缓存，GET 不会再次调用应用。频道 key 包含可选的 Bot 账号 `selfId`，前端应原样传回，不得截掉账号自行拼频道号。

`control.busy` 包含等待回执等全部在途工作；`deviceBusy` 仅表示设备执行或管理员请求队列有工作。`attention` 为 `phone|computer|null`，用于解释当前感知边界，读取不会让 Bot 转移注意力。偷偷模式不因自主工作 busy 而禁用；接管模式必须同时检查 `paused:true,busy:false`。

工具只有当前可用时才列在 `tools`，仍受 Bot 配置、当前应用、频道及临时工具禁用约束。打开/关闭应用或设备后应重新读取 session。MCP 的嵌套 `inputSchema` 会原样保留；按服务提供的工具定义填写参数，不要仅从显示签名推断复杂数组或对象。遇到同名工具，服务器可能返回 `terminal.run_command` 等前缀名称；前端应先按 `device` 找对应工具，再把完整 `name` 发回。

```json
{"name":"open_app","args":{"name":"实际应用 ID 或名称"},"mode":"stealth"}
```

```json
{"name":"send","args":{"msg":"用户写下的消息"},"mode":"stealth","confirmSend":true}
```

可选 `duration` 是有限非负的世界时间单位 TU，和 Bot 工具相同；不是毫秒或世界秒。真实桌面输入通常省略它。响应为 `{ok,text,content?}`，`content` 可包含 RichText 图片/音频附件。通过 `/api/media/file?id=...` 访问已保存附件；不要把附件本地文件路径当作浏览器 URL，不要执行返回文本或 HTML。

设备 API 不开放 `act`、世界管理或任意记忆工具。已知聊天发送工具要求 `confirmSend:true`，前端仅在用户明确点击发送时传入；刷新、应用导航、键盘 Enter 不自动发送聊天。`effect` 为 `read|action|send`，这是设备表单提示与已知发送校验，不是第三方 MCP 的安全沙箱：任意 MCP 工具仍可能有外部副作用，必须由用户明确执行，并展示实际工具说明与参数。

`/api/player/tool` 是持有效常驻角色接管 token 的 Bot 工具入口；设备前端不要用它绕过设备白名单或发送确认。

## 电脑实际模式

`computer.mode` 保留 `apps.computer.mode` 配置，`effectiveMode` 表示当前世界实际使用的实现。新界面应优先看 `effectiveMode`，老响应可回退到 `mode`。

| `effectiveMode` | 实际能力 | 限制 |
| --- | --- | --- |
| `off` | 真实世界未启用电脑 | `open_computer` 返回不可用 |
| `docker` | 配置的 Docker 终端与文件工具 | 没有图形桌面或 PNG 截图；按实际开放工具执行 |
| `remote_desktop` | 连接配置的 VNC，截屏、鼠标、键盘和滚轮 | 需要开启 Bot 图片模态及可连接的 VNC；不提供 Docker 终端 |
| `virtual` | 虚构世界由 World 模型模拟终端和文件操作 | 没有真实容器或桌面，不能管理 Docker，工具执行会产生模型裁定 |

虚构世界优先使用 `virtual`，即使配置中 `mode` 为 `off`、`docker` 或 `remote_desktop`。只读摘要在此模式下不会探查真实 Docker，`docker` 和 `remote` 都为 null。

优先用实际工具 `open_computer`、`close_computer`、`run_command`、`screen`、`mouse`、`keyboard`。保留的 `POST /api/computer/action {action:"start"|"stop"|"restart"}` 仅用于真实 Docker 管理，也要求接管及空闲。`POST /api/computer/exec {command}` 复用当前已打开的终端工具，支持 Docker 或虚拟终端，返回 `{code:null,output}`；文本工具回执没有可靠退出码，不能把 null 显示为成功退出 0。

### VNC 坐标与输入

`GET /api/computer/screen?w=1200` 只截取已经连接的会话，不临时建立连接，也不把画面加入 Bot 上下文。未开机、未连接或不支持屏幕时返回 503。显式调用 `screen` 工具会生成媒体回执；偷偷模式仅在 Bot 正关注电脑时补充其可见画面，完整调用回执仍只给管理员。

PNG 可能缩小：`x-screen-width` / `x-screen-height` 是返回图片尺寸；`x-desktop-width` / `x-desktop-height` 是真实远端桌面尺寸。鼠标参数必须使用远端原始像素坐标，左上角为 `(0,0)`。若图像在页面显示矩形为 `(left,top,width,height)`，转换为：

```text
x = (clientX - left) / width  * desktopWidth
y = (clientY - top)  / height * desktopHeight
```

后端会将指针限制在远端桌面边界。不要把缩略图尺寸或 CSS 像素直接作为桌面坐标。鼠标 `action` 支持 `move/click/double_click/right_click/middle_click/press/release/drag/scroll`；拖动支持 `button:left|middle|right`；滚轮方向支持 `up/down/left/right`。键盘支持 `type/key/combo/press/release`，详细参数以当前工具 schema 为准。输入明确指定偷偷或接管模式；接管模式要求真实暂停成功。两种模式均在同一前端队列逐条等待，页面失效或切换操作模式时丢弃尚未发送的输入。

交还会释放保持状态的键鼠；关闭电脑或停止世界会断开远端连接并停止剩余排队输入。已经写给远端或外部平台的输入不会回滚；网络错误不构成安全重放的依据。

## 玩家任务与离场

玩家 crossing 动作使用 `/api/player/task` 的 `taskId`，取消使用 `POST /api/player/cancel {token,taskId}`。取消返回的 `status` 与 `result` 原样来自 crossing；`too_late` 表示已提交或已有结果，不能显示为已撤销。断线后不能自动重发动作，原请求可能尚未到达服务器。

常驻角色入场使用 `/api/player/arrive` 的 `mode:"avatar"|"puppet"`，名字必须匹配常驻 Bot，权限必须是管理员，不创建副本。返回的 `token` 用于以下能力：

| 请求 | 用途 |
| --- | --- |
| `GET /api/player/cockpit?ctoken=...` | 当前 mode、control、完整 tools Schema、pending 与 time 单位，以及完全入替时可选择的证据和认识；只读，不消费观测 |
| `GET /api/player/events?ctoken=...&lastEventId=...` | 角色事件 SSE；常驻接管会话镜像 Bot 已持久交付的感知，按稳定事件 ID 恢复最近回放 |
| `POST /api/player/tool {token,name,arguments,duration?,confirmSend?}` | 通过真实 Bot 调用路径执行；来源由有效会话推导 |
| `POST /api/player/tool/cancel {token,callId}` | 取消本会话尚未提交的调用；callId 从 pending 的 id 获取 |
| `POST /api/player/leave {token}` | 等待工作完成后归还角色控制 |

`/api/player/tool` 必须带有效接管 token，仅有管理员身份或同名字符串不足以代理角色。返回 `{ok,text,content?,callId?}`，发送工具的 `requiresSendConfirmation` 为 true 时需明确确认。`duration` 为 TU；wait 传 `arguments.n`，rest 传 `arguments.duration`，不要另给冲突的外层估时。puppet 不开放代替意识的 reflect/recall_growth/wait/rest 等操作。

驾驶舱与独立玩家页面保留固定、可收起的操作台。状态流更新不重建当前输入节点；应用、会话、消息与媒体按名称或摘要点选。世界动作和观察目标直接填写自然语言，不要求实体 ID 或观测句柄，也不发送 `observationId`。旧观测中的实体按钮会以名字带入目标，已保存的旧句柄草稿在能够识别时转换为名称。下方的行动组按最新在前排列，直接展示意图、World 生成的自然语言经过与结果；复杂参数、旧逐项经历和完整回执可以展开。有权限时同时展示两个 LLM 的实时输出。

常驻角色的主动观察走 `observe(intent?, target?, modality?)` 工具，确保它看到的结果进入自身经历；观察意图直接显示在驾驶舱主输入区。独立玩家可使用“按上面的描述仔细观察”，将输入作为观察意图提交。`GET` 目录与页面刷新不会额外调用 World 或制造观察经历。`/api/player/task` 仅用于独立玩家，常驻角色的请求会被拒绝。

常驻驾驶舱的事件来自同一个 Bot 实例已持久交付的感知流，服务端持续校验控制会话、角色模式与世界生命周期；不会为浏览器额外 `observe`，也不把全局世界日志直接交给角色。镜像仅从本次授权接管开始，保留 puppet 回执的非自主语义。会话 SSE 保留最近 256 条镜像用于重连，通过 `Last-Event-ID` 或 `lastEventId` 恢复，服务端和前端按稳定事件 ID 去重。该回放缓冲是内存中的有界窗口，不保证跨服务重启或补齐超出窗口的全部历史；断线恢复事件不会重新执行工具。自然语言世界经历本身的持久记录保存在 `world-narrative.jsonl`；Bot 已交付的事件同时进入它自己的持久上下文与既有成长证据账本。

### 自然语言世界与观察

World-LLM 不保留跨任务的完整对话历史。每次任务读取最新的自然语言世界情境与角色处境，再根据本次意图裁定结果。状态不仅记录位置、物品和身体情况，也需要保留未结束的交谈、NPC 当前打算、未完成的过程与仍然有影响的过往事实。

World 返回的自然语言状态、动作结果和按角色区分的感知，在 `world-narrative.jsonl` 中同笔保存，成功后才交付。下一次裁定直接读取最新提交，不等待后台状态同步。程序只保留身份、控制权限、时间、执行生命周期、版本、事件 ID 与来源等必要结构；不后台维护另一份完整实体图。旧 `world-transactions.jsonl` 与 Markdown 状态用于迁移，原资料保留；旧实体内核不再驱动新世界任务。

新的观测保持协议外壳，以 `mode:"narrative"` 标识，`narrative` 是角色实际收到的自然语言感知，`scene.text` 直接展示同一份已保存的场景正文。`observationId` 仍可用于标识回包，但不是动作的前置凭据；`entities` 可以为空。稳定的 `eventId`、`worldSequence`、`worldTime`、动作关联和 `sourceEventIds` 用于排序、去重和追溯，不能把重放同一场景算作新证据。新场景不由 `scene.ts` 拼接属性，也没有额外的模型润色步骤。旧 `experiences`、逐项状态变化和原话仍可在历史回执中阅读，不伪造缺失记录。

`act` 可自然推进完成意图所需的过程并产生 NPC 回应；例如“去吃饭”推进到餐厅，店员询问吃什么，再等角色选择。`needs_input` 表示已经到达新的决定点，本次动作停止，界面显示“等你决定”；它不代表整体目标完成，也不是仍在后台续行的任务。用户选择下一步后再提交新的 `act`。说话由 Bot 或用户填写 `speech` 原文，World 不能代写受控角色的台词、意图或心理；旧的 `outcome.speechAfter` 实体操作索引不用于新协议。

主动 `observe` 可以确定此前未描写的细节：例如查看菜单时确定菜品，并把菜品与当前交谈一并保留在状态中，供下一次操作承接。普通行动已带来足够的被动感知时，无需反复主动观察。感知范围、遮挡与是否能够知道某件事由 World 根据自然语言情境判断，程序验证收件人身份；这里不再提供实体内核级的空间和属性可见性保证。世界完整状态只在管理员视图展示，不能直接当成角色的眼前所见。

真实设备继续通过程序读取与执行。`observe_device` 显示实际手机或电脑状态，聊天记录和发送结果来自真实存储、平台或设备回执，不由 World 编造。世界观察与设备观察的语义不同；偷偷操作、强制接管和角色的 puppet/avatar 模式仍遵循本文件前述规则。

虚构应用另走 `app_observe` / `app_action` 内部任务：读取已确立的设备记录不写入世界感知；写入将设备变化与私有操作回执一同保存，也不直接修改角色处境或向角色广播。回执经过设备流程原有的关注与接管判定后才可能成为 Bot 的经历。这个边界避免用户偷偷查看或编辑文件时，操作内容提前出现在 Bot 的世界感知中。

总览以“世界此刻”与常驻角色处境展示自然语言状态；“世界实况”页提供完整情境、各角色处境、行动进度与最近事件，长文可以展开，空实体集合不会阻止使用。旧结构回包仍可展示实体关系图，新正文不会自动转成图节点。角色与成长继续使用既有证据账本，本轮不重写其记录，也未新增后台关系抽取系统。

入场响应中的 `control.busy` 表示需等待已有回执。取消不会回滚已提交的变化，网络异常也不会自动重放。已有操作未完时 `/api/player/leave` 返回 409 并保留会话；普通独立角色离场不会释放设备页控制。关闭页面或长期失联会取消未提交调用，并在已提交回执交付后恢复自主能力。控制来源另存于 `control-audit.jsonl`，不把接管凭据写入审计。

## 隔离样本与验证

`node scripts/preview-webui.mjs` 在 `127.0.0.1:18131` 提供生成后的页面与固定样本 API，`STUDIO_PREVIEW_PORT` 可选择其他本地端口。其设备、聊天、天气、新闻、MCP 与玩家回执由内存 fixture 提供；操作只改变样本内存，重启即恢复。它不连接运行中的 `18111`、真实平台、模型、Docker 或 VNC，页面应始终标明开发样本。

预览可验证布局与交互，不证明真实外部设备已连通。`scripts/test-device-api.ts` 使用真实服务/工具分发逻辑和本地 stub 验证鉴权、工具状态、发送确认、互斥队列、接管/关闭、原始坐标尺寸、取消回执及有效电脑模式。`scripts/test-device-stealth.ts` 验证自主与人为竞争、旧工具执行前重新校验、不取消 Bot 意图、关注与未关注的感知边界、秘密调用回执隔离。运行 `npm test` 执行隔离套件；测试不需要线上实例或真实凭据。

`scripts/webui-smoke-narrative.mjs` 覆盖自然语言总览/世界页、无实体时的 cross/puppet/avatar 操作、主动观察、场景结果与输入法节点保留；旧结构图表与历史经历的浏览器回归仍保留。`scripts/test-resident-perceptions.ts` 验证授权感知镜像、重连去重和会话隔离。世界运行时与日志测试使用隔离模型回包和临时数据目录，不能代替实际模型的剧情质量评估。
