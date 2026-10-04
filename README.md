# YesImBot World

**让角色拥有自己的生活，再带着经历与你相遇。**

一个面向自主角色与长期角色扮演的 **Koishi 插件**。你写下角色与世界的设定，它便能在持续演化的环境里行动、与人交往、使用设备，并从亲历中积累记忆与认识。

<p align="center">
  <img src="https://raw.githubusercontent.com/YesWeAreBot/YesImBotWorld/main/src/webui/assets/unfolding-worlds.svg" width="640" alt="开放世界主题插画：不同地貌由地平线连接，路径向远处延伸">
</p>

[快速上手](#快速上手) · [完整文档](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/README.md) · [npm](https://www.npmjs.com/package/koishi-plugin-yesimbot-world) · [反馈与建议](https://github.com/YesWeAreBot/YesImBotWorld/issues)

## 一个有生活的角色

- **世界持续演化**：环境、天气、NPC 与未完的事情随世界时间推进。角色的行动得到可读的剧情与后续选择。
- **经历进入交流**：角色能回想发生过的事情，与 Koishi 聊天平台中的真人交流；群聊与私聊保留真实消息来源。
- **记忆与成长**：保存亲历，逐步整理关系、承诺、偏好、习惯与性格倾向，并保留认识的依据与修订历史。
- **手机与电脑**：聊天、浏览网页、写笔记、读新闻、设闹钟；还可配置相机、问答助手、MCP 应用、Docker 电脑或远程桌面。
- **你也能走进世界**：创建自己的角色参与剧情，或接管常驻角色；在网页里直接操作它的手机与电脑。
- **看得见它在工作**：WebUI 展示世界实况、角色成长、流式模型输出和调用记录，适配桌面与手机，支持深浅主题。

## 它如何运转

**Bot-LLM 决定做什么，World-LLM 描写发生了什么。**

Bot 持续选择行动、思考、使用设备或聊天。World 根据最新的自然语言世界状态裁定行动、推进环境与 NPC，并交付角色能够感知的结果。聊天消息和真实设备操作由程序直接处理，以实际平台回执为准。

这是一种受 VLA「感知—决策—行动」思路启发的应用层探索。角色与世界使用独立模型配置，也可以连接同一个模型服务；已支持 **OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages**。

## 快速上手

准备好 **Node.js ≥ 22.19.0**、**Koishi 4.18.11 或兼容版本**、数据库插件，以及可用的模型服务。

### 1. 安装并配置

在 Koishi 插件市场搜索 `yesimbot-world`，或在 **Koishi 实例目录**安装：

```bash
yarn add koishi-plugin-yesimbot-world
```

推荐先在控制台开启 `webui.enabled` 并启用插件，打开 WebUI 的「新手引导」：依次完成模型连接、角色与世界设定、用量和访问权限，再创世、启动。高级配置可以稍后再做。也可在控制台直接填写 **Bot** 与 **World** 的 API 协议、地址、模型名称和密钥；两者可以使用相同连接。

### 2. 写下角色和世界

首次启用会在 Koishi 实例下的 `data/yesimbot-world/` 生成定义模板：

| 文件 | 写些什么 |
| --- | --- |
| `Bot_Definition.md` | 角色是谁、背景、说话风格与最初的生活状态 |
| `World_Definition.md` | 世界背景、规则、地点与人物 |

填写内容并替换「（尚未编写）」占位符。也可直接在 WebUI 的「世界设定」中编辑；若修改了 `basePath`，请使用对应目录。

### 3. 创世，再启动

使用 Koishi 权限 **3** 或以上的账号，依次执行以下指令；等创世完成后再启动：

```text
world.init
world.start
```

也可以在 WebUI 总览点击「更多 → 创世」，完成后点击启动。角色随即开始自主行动。

### 4. 观察并参与

启用 WebUI 后，本机默认访问 **http://127.0.0.1:18111/**，也可用 `world.webui` 查看地址。从世界实况开始，再去设备工作台操作手机，或在「走进世界」里参与剧情。

`world.status` 查看状态，`world.stop` 暂停运行。开放给其他设备前，请设置适当的监听地址和 `webui.token`。

> 项目仍在持续迭代。Bot 会持续推理，长期运行可能消耗较多 token；模型能力、生成速度与设定都会影响体验，建议先短时体验再常驻运行。

## 继续探索

| 你想了解 | 文档 |
| --- | --- |
| 安装、日常管理与完整配置 | [上手指南](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/getting-started.md) · [配置示例](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/configuration.md) |
| 切换模型、API 与提示词 | [模型接口](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/model-apis.md) |
| 网页操作、入世界与联机 | [WebUI](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/webui.md) · [玩家与访客](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/players.md) |
| 聊天、媒体、应用与电脑 | [聊天与多模态](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/messaging-and-media.md) · [工具与应用](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/tools-and-apps.md) |
| 运行原理、记忆与源码开发 | [架构](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/architecture.md) · [记忆与成长](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/memory-and-storage.md) · [开发指南](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/development.md) |

欢迎分享角色设定、运行体验和可复现的问题，也欢迎参与开发。完整专题索引见[文档目录](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/docs/README.md)。

[MIT License](https://github.com/YesWeAreBot/YesImBotWorld/blob/main/LICENSE)
