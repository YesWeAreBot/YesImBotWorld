# 安装、创世与世界管理

[文档目录](README.md) · [项目首页](../README.md)

从首次配置到日常启停；管理指令与网页操作共用同一套运行逻辑。

## 安装与准备

运行环境需要 Node.js 22.19.0 或更新版本、Koishi 4.18.11 或兼容版本，并启用数据库服务。在 Koishi 插件市场搜索 `yesimbot-world`，安装后分别填写 Bot 与 World 的 API 协议、地址、模型名称及所需密钥；两者可以使用同一个模型服务。

也可以在 Koishi 实例目录安装包，再通过控制台启用：

```bash
yarn add koishi-plugin-yesimbot-world
```

初次运行不需要配置 Docker 或 VNC。Puppeteer 用于完整网页操作、截图等扩展能力，可在需要时安装。源码开发部署见[开发指南](development.md)，完整可选配置见[配置示例](configuration.md)。

## 推理开销与模型选择

Bot 持续推理，World 按操作与心跳调用，因此长时间运行可能消耗较多 token。模型的指令遵循、上下文理解与生成速度都会影响角色表现及交互延迟，可先短时运行再决定常驻配置。

起步选型的经验参考为稠密模型约 27B 以上、MoE 总参数约 32B 以上、生成速度约 40 tokens/s。这些是体验建议，不是程序校验的最低门槛，也不保证特定模型的效果。

## 使用步骤

运行 Koishi 的主机需要 Node.js 22.19.0 或更新版本，与插件的 HTTP 客户端依赖要求一致。

1. 配置插件（两个模型的 API 地址）并启用；
2. 编辑 `Bot_Definition.md` 与 `World_Definition.md`（首次启用后自动生成模板）；
3. 执行指令 `world.init` —— World-LLM 写下初始情境、角色处境和感知，保存到 `world-narrative.jsonl`；
4. 执行 `world.start` —— 世界时钟开始流动，Bot-LLM 进入持续推理。

## 使用网页完成首次启动

开启 `webui.enabled` 后，默认本机地址为 `http://127.0.0.1:18111/`。WebUI 在创世前就能使用：在「世界设定」填写并保存角色与世界定义，在总览「更多 → 创世」完成初始化，然后点击启动。

首次启用生成的定义模板包含「（尚未编写）」占位符，必须替换为实际设定。默认 `data/yesimbot-world/` 相对 **Koishi 实例目录**解析；修改过 `basePath` 时以配置值为准。创世完成与启动运行是两个独立步骤。

默认只监听本机且令牌为空。需要其他设备访问时，设置适当的 `webui.host`，并配置 `webui.token`；令牌为空时，能连接到服务的访问者可获得管理员权限。通过 `world.webui` 查看当前配置地址，该指令不会回显令牌。界面与权限分别见[WebUI 指南](webui.md)和[玩家与访客](players.md)。

## 管理指令

| 指令 | 权限 | 说明 |
|---|---|---|
| `world.init [-f]` | 3 | 创世（`-f` 归档并重新创世）。创世会**清空聊天消息记录**（全新的开始） |
| `world.start` / `world.stop` | 3 | 启动 / 暂停运行；独立时间线暂停计时，现实同步模式仍跟随现实时间 |
| `world.status` | 1 | 世界与 Bot 运行状态 |
| `world.reload` | 3 | 修改定义文件后重载：World-LLM 调整状态，并以世界观内方式告知 Bot |
| `world.inject <text>` | 3 | 注入一条系统事件（调试用，会唤醒等待中的 Bot） |
| `world.travel <世界名\|home>` | 3 | 穿越：把 Bot 强制送往指定异世界（填 `home` 送回自己的世界）；不填列出可去世界 |
| `world.webui` | 1 | 查看运维 WebUI 的访问地址（需已启用 `webui.enabled`） |
| `world.clearmsg` | 4 | 只清空 Bot 的聊天消息记录（不影响世界状态与定义） |
| `world.reset` | 4 | 归档并清空全部运行时状态（保留定义文件与固定的小事记） |
