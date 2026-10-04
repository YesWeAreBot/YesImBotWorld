# YesImBot World 文档

[返回项目首页](../README.md)

从安装、创世到长期运行；实现细节与专题排查也集中在这里。

## 开始使用

| 文档 | 内容 |
| --- | --- |
| [安装、创世与世界管理](getting-started.md) | 运行要求、模型准备、首次创世、网页入口与管理指令 |
| [完整配置示例](configuration.md) | Koishi 配置、模型、通知、应用与可选电脑能力 |
| [模型 API、工具调用与提示词](model-apis.md) | Chat Completions / Responses / Anthropic、工具输出与提示词覆盖 |
| [WebUI 使用指南](webui.md) | 世界实况、设备工作台、流式调用、图表与手机外壳 |
| [玩家、访客与联机世界](players.md) | 分级访问、独立角色、身体操纵、完全入替与跨世界作客 |
| [工具、手机与电脑](tools-and-apps.md) | 工具目录、平台扩展、浏览器、MCP、Docker 与远程桌面 |
| [聊天平台与多模态](messaging-and-media.md) | 消息身份、引用、表情包、图文混排、媒体发送与外部账号消息 |

## 理解与开发

| 文档 | 内容 |
| --- | --- |
| [架构与世界运行](architecture.md) | 模型分工、世界时间、行动裁定、提交与当前限制 |
| [角色记忆、成长与存档](memory-and-storage.md) | 数据文件、追加式上下文、成长证据、压缩与防循环 |
| [源码开发与验证](development.md) | 构建、开发链接、隔离预览与回归检查 |
| [SVG 美术资源](../src/webui/assets/README.md) | 世界主题插图、源码及导出方式 |

## 专题说明

- [世界生命周期](world-lifecycle.md)：启停、重置、重新创世与正在执行的任务。
- [世界心跳与角色行动边界](world-evolution.md)：世界自身的演化、行动阶段与局部修复。
- [世界裁定成本与交互调度](world-performance.md)：输入与输出职责、维护让路、聊天窗口及分阶段耗时。
- [世界与设备事实边界](world-device-boundary.md)：虚构剧情与真实消息、设备状态的权限分界。
- [聊天身份与世界时间](chat-identity-and-time.md)：账号、群昵称、消息来源与时钟权威。
- [聊天因果与休息语义修复](chat-causality-repair.md)：消息顺序、感知来源、`wait` 与 `rest`。
- [设备工作台与玩家接口](webui-devices.md)：共享设备、偷偷操作、强制接管与角色控制。
- [手机应用实现](phone-apps.md)：浏览器、时钟、相机、助手及应用生命周期。

## 历史与迁移

- [消息排序问题的引入历史](message-ordering-history.md)：相关提交、根因与修复依据。
- [旧结构化世界设计](structured-world.md)：旧档导入与历史协议资料；当前运行方式以[自然语言世界架构](architecture.md)为准。
