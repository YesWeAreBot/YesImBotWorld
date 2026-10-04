# 源码开发与验证

[文档目录](README.md) · [项目首页](../README.md)

本地构建、链接 Koishi、隔离预览与回归检查。

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

完整 `koishi.yml` 示例已移至[配置文档](configuration.md)。

## WebUI 源码与隔离预览

前端源码按功能放在 `src/webui/client/`，`src/webui/index.html` 负责组合。`npm run build` 和 `npm test` 会自动内联生成 `src/webui/page.ts`，发布时仍只有一个内嵌页面，无静态资源部署步骤。构建完成后需重新加载 Koishi 插件才能让已有服务使用新版页面。

本地开发可使用完全隔离的内存样本世界：

```bash
npm run preview:webui
# 默认 http://127.0.0.1:18131，可通过 STUDIO_PREVIEW_PORT 修改
npm run test:webui
# 需要 Node.js 22 和 Chromium；可通过 CHROMIUM_PATH 指定浏览器
```

预览页会明确标记样本数据。它不读取现有世界，不调用 LLM、聊天平台、Docker 或 VNC；消息和笔记只写入内存。浏览器测试自行启动临时预览服务，检查三种屏宽和主要交互，完成后清理服务与浏览器。设置 `STUDIO_SCREENSHOT_DIR` 可保存截图。真实 VNC 的连接与画面仍需在目标环境中验证。

## 离线回归测试

运行 `npm run check` 与 `npm test`。测试仅使用临时目录和桩，不连接当前世界、真实模型、聊天平台或 Docker；`npm run build` 生成发布产物。`npm run test:webui` 在隔离预览中用 Chromium 验证多端布局、流式原文、设备/入世界操作及图表的触摸、鼠标和键盘交互。
