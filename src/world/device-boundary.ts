/**
 * A conservative, deterministic boundary for the domains owned by device tools.
 * This detects explicit claims, not every possible meaning of unrestricted prose.
 * A World observation is never evidence of a platform message or an IO receipt.
 */
export interface DeviceBoundaryViolation {
  code: "WORLD_DEVICE_BOUNDARY";
  kind: "chat" | "software";
  message: string;
  excerpt: string;
}

export const DEVICE_TOOL_GUIDANCE = "消息、通知、软件界面及设备读写由专用工具提供实际结果。请用 observe_device 查看设备，按当前工具用 open_app、select_channel/read_channel 读取真实聊天，用 send 等工具发送。act 只能裁定身体与物理环境；混合请求尚未执行，不能把消息内容、已读或发送成功当作世界行动结果。";

export const WORLD_DEVICE_AUTHORITY = "代码限定的事实归属：普通任务只裁定物理世界。真实聊天平台在现实或虚构世界中都由外部服务独占；本次没有提供其消息原文、收发回执或设备运行状态。不得新建、续写、转述或确认平台消息、通知、未读/已读、聊天对象、发信结果、应用页面和开关状态，也不得依据旧世界叙述中的这类内容继续创作。初始化、演化、观察、离场和所有状态字段同样受限。手机等物品的位置、外观及身体拿放可裁定，软件与消息须由设备工具提供。“刷手机”“玩手机”“翻消息”和拿起手机后“随便刷点什么”同样是设备操作，不能作为物理行动建议，也不能写成已经划屏浏览了多久的经历；行动建议的标题、意图和分组文字都遵守此边界。摸一下手机不能确认手机闹钟是否已设好、设置时间或开关状态；手机闹钟与计时器的核对、设置须用实际应用工具。独立的机械/实体闹钟仍可按物理环境裁定，不因同名就当成手机软件。只有明确的内部app_observe/app_action可按读写协议处理虚构软件，仍无真实平台权限。既有虚构文件原文仅供相应内部应用读取，普通裁定只能原样保留，不能作为普通角色感知。缺少设备事实时省略它们，不猜测有或没有。创世也不要描述屏幕亮暗、熄屏、锁定、电量或是否有通知：暗屏不是安全替代说法，仍在断言未知设备状态。可写“手机平放在床头柜上，机身留有握持余温”，不要加“屏幕暗着”。";

const platform = /(?:\b(?:qq|wechat|weixin|telegram|discord|slack|whatsapp|messenger|email|e-mail|sms|imessage)\b|微信|钉钉|飞书|私聊|群聊|私信|短信|电子邮件|聊天(?:记录|窗口|界面|列表|频道|软件|应用|平台)|社交平台)/i;
const digital = /(?:手机|电脑|平板|屏幕|显示器|终端|浏览器|软件|应用|网页|网站|网络|互联网|邮箱|收件箱|通知栏|状态栏|\b(?:phone|computer|screen|desktop|terminal|browser|app|inbox|online)\b)/i;
const message = /(?:消息|通知|邮件|私信|短信|未读|已读|\b(?:messages?|notifications?|emails?|inbox|DMs?)\b)/i;
const readWrite = /(?:查看|看一眼|看看|看下|阅读|读取|读一读|翻看|翻阅|浏览|查阅|检查|刷新|获取|查询|搜索|打开|点开|进入|切换|发送|发给|发条|发一条|发消息|回复|回消息|回信|转发|收发|上传|下载|保存|写入|编辑|删除|输入|点击|运行|执行|解锁|锁屏|开机|关机|重启|\b(?:read|check|view|open|send|reply|forward|refresh|browse|search|write|save|upload|download|run|execute|type|click|unlock)\b)/i;
const paper = /(?:纸质|纸上|纸条|纸张|信纸|书信|纸信|信封|手写信|信使|口信|告示牌|公告栏|公告牌|黑板|布告|菜单|书本|书页|书上|书中|目录页|当面|面对面|\b(?:paper|handwritten|envelope|face.to.face)\b)/i;
const physicalDetail = /(?:背面|外壳|壳上|划痕|裂纹|裂痕|重量|材质|温度|烫不烫|\b(?:back cover|scratch|weight)\b)/i;
const softwareTarget = /(?:屏幕|界面|浏览器|网页|网站|网址|软件|应用|程序|终端|命令|文件(?!柜|袋|盒|架|箱)|目录|服务器|Docker|联网|网络连接|天气预报|实时天气|\b(?:screen|desktop|browser|website|url|app|program|terminal|command|file|folder|directory|server|docker|forecast)\b)/i;
const casualDeviceUse = /(?:刷|玩|翻)(?:了|着|过)?(?:一会儿?|会儿?|一阵子?|一下|几下|两下|一?点(?:儿)?|一些|几(?:条|个)|两(?:条|个)|一(?:条|个)|[零一二两三四五六七八九十百几数半\d]+(?:[～~—–-][零一二两三四五六七八九十百几数半\d]+)?(?:秒钟?|分钟|个?小时))?(?:(?:手机|平板|电脑)(?!(?:的|上(?:的)?)?(?:壳|模型|背面|外壳|划痕|裂纹|裂痕|重量|材质|温度))|微信|QQ|朋友圈|微博|抖音|小红书|B站|短视频|视频|信息流|聊天记录|消息|通知|私信|邮件|网页|软件|应用)|(?:滑屏|划屏)|(?:滑动|划动|滑过|划过|滑着|划着|划拉).{0,8}(?:屏幕|触屏|触摸屏)|(?:屏幕|触屏|触摸屏).{0,14}(?:滑动|划动|滑了|划了|滑着|划着|划拉|来回滑|来回划)/i;
// A preceding clause can supply the device: “拿起手机，随便刷点什么”. Require
// an unspecified object or a complete duration, so “刷牙/刷点油漆/翻纸书” stay physical.
const contextualBrowsing = /(?:刷|翻|玩)(?:了|着|过)?(?:点(?:儿)?什么|(?:一?点|一些)(?:内容|东西)|一会儿?|一阵子?|一下|几下|两下|[零一二两三四五六七八九十百几数半\d]+(?:[～~—–-][零一二两三四五六七八九十百几数半\d]+)?(?:秒钟?|分钟|个?小时))(?=$|[\s的啊吧呢了着]|就|后|再|到|直至|直到|才)/;

/** A device named earlier can own an omitted alarm object: “拿起手机，确认闹钟已设好”.
 * An explicitly separate physical clock, or its casing, is not a software setting.
 */
function deviceClockOperation(text: string, deviceContext: boolean): boolean {
  if (!deviceContext || !/(?:闹钟|闹铃|计时器|定时器|倒计时|\b(?:alarm|timer)\b)/i.test(text)) return false;
  const explicitSoftware = /(?:手机|平板|电脑)(?:的|上(?:的)?|里(?:的)?|中(?:的)?|内(?:的)?|自带的|内置的)?(?:时钟(?:应用)?(?:里|中|内)?的?)?(?:闹钟|闹铃|计时器|定时器|倒计时)|(?:闹钟|闹铃|计时器|定时器)(?:应用|软件|界面|列表)|\b(?:phone|app)\s+(?:alarm|timer)\b/i.test(text);
  const physical = /(?:机械|发条|指针式|双铃|独立(?:的)?|实体|物理|老式|床头(?:柜上)?(?:的)?|桌(?:上|边)(?:的)?|手机(?:旁|边)(?:的)?)(?:(?:机械|电子|数字)(?:式)?|小)?(?:闹钟|闹铃|计时器|定时器)|(?:闹钟|闹铃|计时器|定时器)(?:的)?(?:外壳|背面|指针|发条|拨盘|铃铛|电池仓)|(?:闹钟|计时器)(?:的)?(?:图案|贴纸|模型)/.test(text);
  if (physical && !explicitSoftware) return false;
  return /(?:确认|核对|检查|查看|看一眼|看看|看下|设置|设定|设好|设为|调好|调到|调成|定好|定在|取消|删除|开启|启用|停用|关闭|打开|开关|已经|已设|已定|仍是|仍为|响起|响了|会响|将响|\b(?:confirm|verify|check|view|set|enable|disable|cancel|delete|enabled|disabled|scheduled)\b)/i.test(text) ||
    (explicitSoftware && /(?:[：:]|(?:是|为)[零一二两三四五六七八九十\d]+(?:点|时|分))/.test(text));
}

function casualDeviceKind(text: string, deviceContext: boolean): DeviceBoundaryViolation["kind"] | null {
  const use = casualDeviceUse.exec(text);
  if (use && !physicalDetail.test(use[0])) return platform.test(use[0]) || message.test(use[0]) ? "chat" : "software";
  if (deviceContext && contextualBrowsing.test(text) && !paper.test(text) && !/(?:刷牙|刷墙|刷漆|刷鞋|油漆|涂料|洗刷)/.test(text)) return "software";
  return null;
}

function normalized(text: string): string { return text.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ""); }
function clauses(text: string): string[] {
  // A paper/face-to-face clause cannot authorize an adjacent device operation. Newlines
  // may separate intent from target, so keep those together instead of losing the target.
  return text.replace(/\n+/g, " ").split(/[，,。；;！？!?]|(?:然后|接着|并且|同时|顺便)|并(?=给|向|收|查|发|看|读|打)/).filter(part => part.trim());
}
function violation(kind: DeviceBoundaryViolation["kind"], text: string): DeviceBoundaryViolation {
  const screenState = kind === "software" && /(?:屏幕|显示器|screen|display).{0,55}(?:亮|暗|黑|熄|锁|关闭|off|dark|lit|locked)/i.test(text);
  return { code: "WORLD_DEVICE_BOUNDARY", kind, message: kind === "chat"
    ? "World 没有平台消息或收发回执的事实权限。删除虚构的消息、界面和收发结果，通过真实聊天工具取得；不要改写成‘没有消息’。"
    : screenState
      ? "屏幕亮暗、熄屏或锁定同样是未知设备状态，不能由 World 设定。删除这部分子句，不要换成另一种屏幕状态；只保留物理描述，例如‘手机平放在床头柜上，机身留有握持余温’。实际屏幕由 observe_device 等专用设备工具提供。"
      : "World 没有软件界面、通知或设备读写结果的事实权限。删除这些断言，只保留物品的位置、外壳等物理处境；实际结果由专用设备工具提供。", excerpt: text.slice(0, 180) };
}

/** Call on the user's tool intent/target, not on arbitrary file contents or quoted history. */
export function detectDeviceRequest(input: string): DeviceBoundaryViolation | null {
  const deviceContext = digital.test(normalized(input)) || platform.test(normalized(input));
  for (const part of clauses(input)) { const found = requestClause(part, deviceContext); if (found) return found; }
  return null;
}
function requestClause(input: string, deviceContext: boolean): DeviceBoundaryViolation | null {
  const text = normalized(input);
  if (!text.trim()) return null;
  const transport = /(?:查看|看看|读取|阅读|翻看|发送|发|回|回复).{0,45}(?:消息|私信|短信|邮件)/i.exec(text);
  if (transport && !paper.test(transport[0])) return violation("chat", input);
  const explicitDigital = platform.test(text) || digital.test(text);
  const casual = casualDeviceKind(text, deviceContext);
  if (casual) return violation(casual, input);
  if (deviceClockOperation(text, deviceContext)) return violation("software", input);
  if (paper.test(text) && !explicitDigital) return null;
  if (/\b(?:read_channel|select_channel|open_app|observe_device|send_voice|send_file|run_command|open_url)\b/i.test(text)) return violation("software", input);
  if ((platform.test(text) || message.test(text) || (digital.test(text) && /信息/.test(text))) && readWrite.test(text)) return violation("chat", input);
  if (/(?:打开|进入|点开|刷新).{0,15}(?:聊天|\bchat\b)|\b(?:open|refresh)\s+(?:the )?chat\b/i.test(text)) return violation("chat", input);
  if (/(?:看看|查看|读|检查).{0,24}(?:他|她|对方|网友|朋友).{0,12}(?:发了什么|发来|回复)|(?:给|向).{1,40}(?:发消息|发信息|发送|回复)|(?:回|发)(?:一条|条)?(?:消息|私信|短信)|\b(?:text|message)\s+(?:him|her|them)\b/i.test(text)) return violation("chat", input);
  if (readWrite.test(text) && (softwareTarget.test(text) || platform.test(text))) {
    if (physicalDetail.test(text) && !message.test(text) && !/(?:界面|软件|应用|程序|终端|命令|文件|网页|网站|开机|关机|解锁|锁屏|\b(?:app|command|file|website|unlock)\b)/i.test(text)) return null;
    return violation("software", input);
  }
  if (/(?:开机|关机|解锁|锁屏|重启)|\b(?:unlock|shutdown|reboot)\b/i.test(text) && digital.test(text)) return violation("software", input);
  if (/(?:查看|看一眼|看看|看下|检查|\b(?:check|view)\b)/i.test(text) && /(?:手机|电脑|平板|\b(?:phone|computer)\b)/i.test(text) && !physicalDetail.test(text)) return violation("software", input);
  return null;
}

/** Explicit output claims. virtualApp authorizes simulated software, never platform chat. */
export function detectDeviceClaim(input: string, options: { virtualApp?: boolean } = {}): DeviceBoundaryViolation | null {
  const deviceContext = digital.test(normalized(input)) || platform.test(normalized(input));
  for (const part of clauses(input)) { const found = claimClause(part, options, deviceContext); if (found) return found; }
  return null;
}
function claimClause(input: string, options: { virtualApp?: boolean }, deviceContext: boolean): DeviceBoundaryViolation | null {
  const text = normalized(input);
  const transport = /(?:收到|接到|发来|发出|发送|回复|读到|看完).{0,45}(?:消息|私信|短信|邮件)/i.exec(text);
  if (transport && !paper.test(transport[0])) return violation("chat", input);
  const casual = casualDeviceKind(text, deviceContext);
  if (casual && (casual === "chat" || !options.virtualApp)) return violation(casual, input);
  if (!options.virtualApp && deviceClockOperation(text, deviceContext)) return violation("software", input);
  // Physical correspondence and face-to-face dialogue remain ordinary world content.
  if (paper.test(text) && !platform.test(text) && !digital.test(text)) return null;
  if (platform.test(text) && (message.test(text) || readWrite.test(text) || /(?:发来|收到|说|写|显示|亮|弹|登入|登录|在线|离线|[「“"：:]|\b(?:received|sent|says|display|logged)\b)/i.test(text))) return violation("chat", input);
  if (/(?:发来|发来了|收到|收到了|接到|推送|发出|发给|发送|回复|回了|读到|看完|看过|已读|未读|提醒).{0,45}(?:消息|私信|短信|邮件|聊天)|(?:消息|私信|短信|邮件).{0,45}(?:发来|发出|发送|来自|写着|内容|显示|已读|未读|已发|收到|送达|回复|发送成功)|(?:发送|发信|投递|转发)(?:已|已经)?(?:成功|完成)|\b(?:received|sent|unread|delivered)\s+(?:a |the |new )?(?:message|email|notification)|\b(?:message|email)\s+(?:from|sent|delivered|reads|says)\b/i.test(text)) return violation("chat", input);
  if (digital.test(text) && /(?:通知|未读|已读|红点|消息|私信|聊天|邮件|来电|铃声|震动|振动|提示音|\b(?:notification|unread|message|inbox|ringtone|vibrat)\w*)/i.test(text)) return violation("chat", input);
  if (options.virtualApp) return null;
  // A narrowly shaped surface-defect statement is physical appearance, not a
  // display state. Do not exempt a whole clause merely because it mentions glass.
  if (/^(?:(?:手机|电脑|平板)(?:的)?|这块|这台|它的)?(?:屏幕|显示器)(?:的)?(?:玻璃|玻璃表面|表面|外层玻璃|边框)?(?:上)?(?:有|留有|带有|沾着)[^。；\n]{0,48}(?:划痕|裂纹|裂痕|指纹|灰尘)$/.test(text.trim()) &&
    !/(?:界面|按钮|图标|窗口|文字|菜单|应用|软件|程序|网页|显示|亮起|亮着|暗着|黑屏|熄|锁|登录|打开|关闭|运行)/.test(text)) return null;
  if (/(?:屏幕|界面|显示器|浏览器|网页|网站|应用|软件|终端|\b(?:screen|desktop|browser|app|terminal)\b).{0,55}(?:显示|亮|熄|黑|暗|打开|关闭|停留|停在|切换|锁|运行|加载|呈现|内容|页面|写着|读出|可见|[「“"：:]|\b(?:show|display|open|closed|locked|running|loaded|reads)\w*)|(?:打开|关闭|进入|切换|解锁|锁住|启动|运行).{0,24}(?:应用|软件|浏览器|终端|聊天|界面)|(?:手机|电脑|平板).{0,30}(?:开机|关机|锁屏|解锁|电量|联网|断网)|(?:文件(?!柜|袋|盒|架|箱)|目录).{0,30}(?:写入|删除|保存|创建|读取|下载|上传|原文|内容如下)|(?:写入|保存|下载|上传|删除|命令执行).{0,20}(?:成功|完成)|\b(?:file|command)\s+.{0,25}\b(?:written|saved|deleted|executed|succeeded)\b/i.test(text)) return violation("software", input);
  if (/(?:电脑|系统|Windows)桌面.{0,35}(?:显示|打开|亮|图标|窗口)|桌面(?:上)?(?:显示|出现|打开).{0,25}(?:应用|程序|窗口|图标)/i.test(text)) return violation("software", input);
  if (softwareTarget.test(text) && /(?:已|已经|正在|成功).{0,15}(?:打开|关闭|进入|切换|搜索|刷新|登录|写入|读取|执行|下载|上传)|(?:打开|关闭|进入|切换|登录|读取|执行).{0,20}(?:成功|完成)/i.test(text)) return violation("software", input);
  return null;
}

/** Keep unknown virtual file bodies verbatim: they are data, not claims by the narrator. */
export function splitVirtualFileBody(text: string): { prose: string; body: string } {
  const marker = /(?:^|\n)[^\n]*(?:文件|\bfile\b)[^\n]*(?:原文(?:如下)?|内容如下|\b(?:verbatim|contents?\s*:)\b)[^\n]*(?:\n|$)/i.exec(text);
  if (!marker) return { prose: text, body: "" };
  return { prose: text.slice(0, marker.index), body: text.slice(marker.index) };
}

/** Paragraphs preserve exact bytes so existing simulated app records can be frozen. */
export function deviceParagraphs(text: string): string[] { return text.split(/\n\s*\n/).filter(part => part.trim()); }

/** A read-time projection only. Never use it to rewrite historical journals or file bodies. */
export function projectWorldDeviceContext(text: string, options: { virtualApp?: boolean } = {}): string {
  const { prose, body } = options.virtualApp ? splitVirtualFileBody(text) : { prose: text, body: "" };
  let omitted = false;
  const safe = deviceParagraphs(prose).filter(part => {
    if (detectDeviceClaim(part, options)) { omitted = true; return false; }
    // A detached transcript immediately following a rejected device paragraph is also suspect.
    if (omitted && /^\s*(?:[-*]\s*)?(?:[\w\p{L} .-]{1,64}[：:]|[「“"])/u.test(part)) return false;
    omitted = false; return true;
  });
  return safe.join("\n\n") + body;
}
