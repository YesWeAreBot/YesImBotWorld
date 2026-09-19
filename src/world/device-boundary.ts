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

export const WORLD_DEVICE_AUTHORITY = "代码限定的事实归属：普通任务只裁定物理世界。真实聊天平台在现实或虚构世界中都由外部服务独占；本次没有提供其消息原文、收发回执或设备运行状态。不得新建、续写、转述或确认平台消息、通知、未读/已读、聊天对象、发信结果、应用页面和开关状态，也不得依据旧世界叙述中的这类内容继续创作。初始化、演化、观察、离场和所有状态字段同样受限。手机等物品的位置、外观及身体拿放可裁定，软件与消息须由设备工具提供。只有明确的内部app_observe/app_action可按读写协议处理虚构软件，仍无真实平台权限。既有虚构文件原文仅供相应内部应用读取，普通裁定只能原样保留，不能作为普通角色感知。缺少设备事实时省略它们，不猜测有或没有。";

const platform = /(?:\b(?:qq|wechat|weixin|telegram|discord|slack|whatsapp|messenger|email|e-mail|sms|imessage)\b|微信|钉钉|飞书|私聊|群聊|私信|短信|电子邮件|聊天(?:记录|窗口|界面|列表|频道|软件|应用|平台)|社交平台)/i;
const digital = /(?:手机|电脑|平板|屏幕|显示器|终端|浏览器|软件|应用|网页|网站|网络|互联网|邮箱|收件箱|通知栏|状态栏|\b(?:phone|computer|screen|desktop|terminal|browser|app|inbox|online)\b)/i;
const message = /(?:消息|通知|邮件|私信|短信|未读|已读|\b(?:messages?|notifications?|emails?|inbox|DMs?)\b)/i;
const readWrite = /(?:查看|看一眼|看看|看下|阅读|读取|读一读|翻看|翻阅|浏览|查阅|检查|刷新|获取|查询|搜索|打开|点开|进入|切换|发送|发给|发条|发一条|发消息|回复|回消息|回信|转发|收发|上传|下载|保存|写入|编辑|删除|输入|点击|运行|执行|解锁|锁屏|开机|关机|重启|\b(?:read|check|view|open|send|reply|forward|refresh|browse|search|write|save|upload|download|run|execute|type|click|unlock)\b)/i;
const paper = /(?:纸质|纸上|纸条|纸张|信纸|书信|纸信|信封|手写信|信使|口信|告示牌|公告栏|公告牌|黑板|布告|菜单|书本|书页|书上|书中|目录页|当面|面对面|\b(?:paper|handwritten|envelope|face.to.face)\b)/i;
const physicalDetail = /(?:背面|外壳|壳上|划痕|裂纹|裂痕|重量|材质|温度|烫不烫|\b(?:back cover|scratch|weight)\b)/i;
const softwareTarget = /(?:屏幕|界面|浏览器|网页|网站|网址|软件|应用|程序|终端|命令|文件(?!柜|袋|盒|架|箱)|目录|服务器|Docker|联网|网络连接|天气预报|实时天气|\b(?:screen|desktop|browser|website|url|app|program|terminal|command|file|folder|directory|server|docker|forecast)\b)/i;

function normalized(text: string): string { return text.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ""); }
function clauses(text: string): string[] {
  // A paper/face-to-face clause cannot authorize an adjacent device operation. Newlines
  // may separate intent from target, so keep those together instead of losing the target.
  return text.replace(/\n+/g, " ").split(/[，,。；;！？!?]|(?:然后|接着|并且|同时|顺便)|并(?=给|向|收|查|发|看|读|打)/).filter(part => part.trim());
}
function violation(kind: DeviceBoundaryViolation["kind"], text: string): DeviceBoundaryViolation {
  return { code: "WORLD_DEVICE_BOUNDARY", kind, message: kind === "chat" ? "World 没有平台消息或收发回执的事实权限，请通过真实聊天工具操作。" : "World 没有软件界面、通知或设备读写结果的事实权限，请通过专用设备工具操作。", excerpt: text.slice(0, 180) };
}

/** Call on the user's tool intent/target, not on arbitrary file contents or quoted history. */
export function detectDeviceRequest(input: string): DeviceBoundaryViolation | null {
  for (const part of clauses(input)) { const found = requestClause(part); if (found) return found; }
  return null;
}
function requestClause(input: string): DeviceBoundaryViolation | null {
  const text = normalized(input);
  if (!text.trim()) return null;
  const transport = /(?:查看|看看|读取|阅读|翻看|发送|发|回|回复).{0,45}(?:消息|私信|短信|邮件)/i.exec(text);
  if (transport && !paper.test(transport[0])) return violation("chat", input);
  const explicitDigital = platform.test(text) || digital.test(text);
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
  for (const part of clauses(input)) { const found = claimClause(part, options); if (found) return found; }
  return null;
}
function claimClause(input: string, options: { virtualApp?: boolean }): DeviceBoundaryViolation | null {
  const text = normalized(input);
  const transport = /(?:收到|接到|发来|发出|发送|回复|读到|看完).{0,45}(?:消息|私信|短信|邮件)/i.exec(text);
  if (transport && !paper.test(transport[0])) return violation("chat", input);
  // Physical correspondence and face-to-face dialogue remain ordinary world content.
  if (paper.test(text) && !platform.test(text) && !digital.test(text)) return null;
  if (platform.test(text) && (message.test(text) || readWrite.test(text) || /(?:发来|收到|说|写|显示|亮|弹|登入|登录|在线|离线|[「“"：:]|\b(?:received|sent|says|display|logged)\b)/i.test(text))) return violation("chat", input);
  if (/(?:发来|发来了|收到|收到了|接到|推送|发出|发给|发送|回复|回了|读到|看完|看过|已读|未读|提醒).{0,45}(?:消息|私信|短信|邮件|聊天)|(?:消息|私信|短信|邮件).{0,45}(?:发来|发出|发送|来自|写着|内容|显示|已读|未读|已发|收到|送达|回复|发送成功)|(?:发送|发信|投递|转发)(?:已|已经)?(?:成功|完成)|\b(?:received|sent|unread|delivered)\s+(?:a |the |new )?(?:message|email|notification)|\b(?:message|email)\s+(?:from|sent|delivered|reads|says)\b/i.test(text)) return violation("chat", input);
  if (digital.test(text) && /(?:通知|未读|已读|红点|消息|私信|聊天|邮件|来电|铃声|震动|振动|提示音|\b(?:notification|unread|message|inbox|ringtone|vibrat)\w*)/i.test(text)) return violation("chat", input);
  if (options.virtualApp) return null;
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
