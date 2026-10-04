# 完整配置示例

[文档目录](README.md) · [项目首页](../README.md)

用于按需查找配置项；首次安装建议先阅读[快速上手](getting-started.md)，无需一次启用全部功能。

`koishi.yml` 配置示例（本地 OpenAI Chat Completions 兼容服务）：

```yaml
plugins:
  yesimbot-world:
    basePath: data/yesimbot-world
    autoStart: false
    bot:
      apiType: chat-completions
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
      modalities: # 按模型原生输入能力开启；未支持的模态回退到外挂解释器
        image: false
        audio: false
        video: false
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
      tingleMode: fixed # fixed = 固定间隔；auto = 安静时放慢，真实变化时采用 World 的 nextIntervalTU 建议
      tingleMinUnits: 300 # auto 模式下间隔下限（同步模式即 5 分钟）
      tingleMaxUnits: 14400 # auto 模式下间隔上限（同步模式即 4 小时）
      offlineNarrateMinUnits: 600 # 离线达此 TU 数（同步模式即 10 分钟）时由 World-LLM 补叙离线期间的世界（0 禁用补叙）
    messaging:
      notifyChannels: ["onebot:123456789"]
      notifyPolicy: channel
      botManagedNotifyChannels: false # 允许 Bot 在聊天 App 内管理频道通知和限时免打扰；notifyChannels 仅初始化/重置使用
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
    apps: # 手机应用（Apps / MCP）：open_app 打开后工具才展开，一次只开一个
      chatAppName: QQ # 聊天平台在 Bot 手机里的应用名
      botManagedNotifications: false # 允许 Bot 在内置设置 App 管全局/各 App 通知与限时免打扰；与频道权限独立
      weatherEnabled: true # 内置天气应用（现实设定查 Open-Meteo，虚构设定由 World-LLM 生成）
      weatherDefaultCity: "" # 真实天气默认城市（留空则要求 Bot 自己给出）
      browserEnabled: true # 内置浏览器（现实设定上真互联网；虚构设定由 World-LLM 生成网页；截图需 koishi-plugin-puppeteer）
      browserHomeURL: portal # 搜索/Bilibili/新闻探索门户，也可填写网址
      browserSearchURL: https://www.bing.com/search?q=%s # 默认搜索源，可配置备用源/自建SearxNG
      browserAutoScreenshot: true # 实际页面截图；原生图片模型可用GUI，否则使用DOM元素
      clockEnabled: true # 世界时钟、后台闹钟、计时器、秒表
      camera:
        enabled: false # 启用后须配置兼容 /images/generations 的服务
        baseURL: https://api.openai.com/v1
        apiKey: ""
        model: ""
        size: 1024x1024
      assistant:
        enabled: false
        name: 小助手 # 可自定义应用名
        mode: inherit # inherit借用World；independent使用独立baseURL/apiKey/model等
      browserProxy: "" # 代理 URL，如 http://127.0.0.1:7890；留空读取 HTTPS_PROXY / HTTP_PROXY
      newsEnabled: true # 内置新闻应用：翻阅世界最近大事（News.jsonl），看头条/关键词搜索/按时间回看；现实模式下关键词搜索还会检索配置的真实 RSS 来源
      newsFeeds: [] # 现实世界新闻 RSS 源列表（留空用内置默认源；可自行配置为服务器可直连的地址）
      filesEnabled: false # 内置资源管理器：Bot 打开电脑后可查看/修改这台电脑里的文件（docker 实现或虚构世界）；默认关闭
      filesCwd: . # 资源管理器打开的工作目录，相对电脑主目录；例如 work
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
