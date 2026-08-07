/**
 * Bot 的个人电脑（与手机平级的设备）的远程桌面实现（VNC / GUI Agent）：
 * 不看命令行，而是**看屏幕**——用 screen 截屏观察界面，用 mouse / keyboard 操作，再 screen 看结果，如此循环。
 *
 * 前提（在 service 层把关）：
 * - 用户在配置里把 apps.computer.mode 选成了 remote_desktop，并填了地址与登录凭据；
 * - Bot-LLM 开启了图片多模态（bot.modalities.image），否则截屏注入不了，模式不可用。
 *
 * KV cache 说明：每次 screen 的截图都作为**新的事件**追加在工作窗口末尾（原生附件），
 * 之前的内容（置顶区 + 历史）逐字节不变——前缀缓存持续命中；旧截图随媒体预算
 * 锚点批量淘汰（水位降到一半，缓存重算被摊薄到每 N/2 张新图一次）。这里绝不改写历史。
 */

import type { Logger } from "koishi";
import type { RemoteDesktopConfig } from "../config.js";
import type { MediaStore } from "../media/store.js";
import type { MediaRef, RichText } from "../types.js";
import { charKey, namedKey } from "../remote/keysyms.js";
import { MOUSE, RfbSession } from "../remote/rfb.js";
import type { AppRawTool, WorldApp } from "./app.js";

const HINT = "\n----\n（这是远程桌面屏幕上的画面。继续操作请调用 mouse / keyboard / screen 工具。）";

export class RemoteDesktopApp implements WorldApp {
  readonly id = "remote_desktop";
  readonly name = "远程桌面";
  readonly description = "连到另一台电脑（VNC 远程桌面）的屏幕：看画面、动鼠标键盘";

  private session: RfbSession | null = null;

  constructor(
    private cfg: RemoteDesktopConfig,
    private media: MediaStore,
    private logger: Logger,
  ) {}

  async open(): Promise<{ tools: AppRawTool[]; opening?: string }> {
    const session = new RfbSession(
      { host: this.cfg.host, port: this.cfg.port, password: this.cfg.password, connectTimeoutMs: this.cfg.connectTimeoutMs },
      this.logger,
    );
    try {
      await session.connect();
      this.session = session;
      const { width, height } = session.screenSize;
      return {
        tools: TOOLS,
        opening:
          `你走到桌前，打开了自己的电脑——屏幕闪烁了几下，` +
          `连上了 ${this.cfg.host}:${this.cfg.port} 的那台电脑（屏幕 ${width}x${height}）。` +
          `先 screen 看一眼桌面再动手。`,
      };
    } catch (err) {
      this.session = null;
      return {
        tools: TOOLS,
        opening: `你走到桌前想打开电脑，但连不上远程桌面 ${this.cfg.host}:${this.cfg.port}（${(err as Error).message ?? err}）。`,
      };
    }
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string | RichText> {
    const notConnected = await this.requireSession();
    if (notConnected) return notConnected;
    switch (tool) {
      case "screen":
        return this.screen();
      case "mouse":
        return this.mouse(args);
      case "keyboard":
        return this.keyboard(args);
      default:
        throw new Error(`远程桌面没有 ${tool} 这个操作`);
    }
  }

  async close(): Promise<void> {
    this.session?.disconnect();
    this.session = null;
  }

  /**
   * WebUI「设备」页的实时窥屏：截一帧当前画面（不入 Bot 的工作窗口，纯运维观察）。
   * 优先复用 Bot 打开着的会话；没开时临时连一次截完即断，不干扰 Bot 侧状态。
   * 连不上时抛错，由调用方转成提示。
   */
  async peek(maxWidth?: number): Promise<{ png: Buffer; width: number; height: number }> {
    const width = maxWidth ?? this.cfg.maxWidth;
    if (this.session?.connected) {
      const shot = await this.session.snapshot(width);
      if (shot.png.length) return shot;
    }
    const temp = new RfbSession(
      { host: this.cfg.host, port: this.cfg.port, password: this.cfg.password, connectTimeoutMs: this.cfg.connectTimeoutMs },
      this.logger,
    );
    try {
      await temp.connect();
      const shot = await temp.snapshot(width);
      if (!shot.png.length) throw new Error("截到的画面是空的");
      return shot;
    } finally {
      temp.disconnect();
    }
  }

  /** 确保已有连接；连接断开/从未连上时尝试重连。返回 null 表示就绪，否则返回给 Bot 的提示 */
  private async requireSession(): Promise<string | null> {
    if (this.session?.connected) return null;
    const session = new RfbSession(
      { host: this.cfg.host, port: this.cfg.port, password: this.cfg.password, connectTimeoutMs: this.cfg.connectTimeoutMs },
      this.logger,
    );
    try {
      await session.connect();
      this.session = session;
      this.logger.info("远程桌面重连成功：%s:%s", this.cfg.host, this.cfg.port);
      return null;
    } catch (err) {
      return (
        `（远程桌面当前没有连接：${(err as Error).message ?? err}。` +
        `这通常是网络不通或那台电脑上的 VNC 没开。重新打开电脑（open_computer）再试。）`
      );
    }
  }

  // ---------- 工具实现 ----------

  /** 截屏观察界面：原生图片附件注入（多模态），Bot 直接看到屏幕 */
  private async screen(): Promise<string | RichText> {
    const session = this.session!;
    const shot = await session.snapshot(this.cfg.maxWidth);
    if (!shot.png.length) {
      return "（你抬头看向屏幕，但画面已经断了——重新打开电脑（open_computer）试试。）" + HINT;
    }
    const id = await this.media.ingest(`data:image/png;base64,${shot.png.toString("base64")}`, "image");
    if (id === null) return "（你抬头看向屏幕，但截图保存不下来。）" + HINT;
    const row = await this.media.get(id);
    if (!row) return "（你抬头看向屏幕，但截图保存不下来。）" + HINT;
    const ref: MediaRef = row.ref;
    return {
      text:
        `你抬头看了看远程桌面的屏幕（${shot.width}x${shot.height}），画面见附件。` +
        `看清界面后决定下一步，操作完再 screen 看变化。` +
        HINT,
      attachments: [ref],
    };
  }

  private async mouse(args: Record<string, unknown>): Promise<string> {
    const session = this.session!;
    const action = String(args.action ?? args.a ?? "").trim();
    if (!action) return "（mouse 需要 action 参数：move / click / double_click / right_click / middle_click / press / release / drag / scroll。）";
    const x = num(args.x);
    const y = num(args.y);
    const hasPos = x !== null && y !== null;
    const { width, height } = session.screenSize;
    if ((hasPos || action === "drag") && (x === null || y === null || (action === "drag" && (num(args.x2) === null || num(args.y2) === null)))) {
      return action === "drag"
        ? "（drag 需要 x、y（起点）和 x2、y2（终点）四个坐标。）"
        : "（这个操作需要 x、y 坐标。）";
    }

    const buttonMask = buttonOf(String(args.button ?? args.b ?? "left"));
    const cur = hasPos ? { x: x!, y: y! } : session.lastPointer;

    switch (action) {
      case "move":
        if (!hasPos) return "（move 需要 x、y 坐标。）";
        session.pointer(cur.x, cur.y, 0);
        return `你把鼠标移到了屏幕的 (${cur.x}, ${cur.y}) 处。`;
      case "click":
        session.pointer(cur.x, cur.y, buttonMask);
        await sleep(50);
        session.pointer(cur.x, cur.y, 0);
        return `你点了${buttonName(buttonMask)}（${cur.x}, ${cur.y}）。`;
      case "double_click": {
        session.pointer(cur.x, cur.y, buttonMask);
        await sleep(40);
        session.pointer(cur.x, cur.y, 0);
        await sleep(90);
        session.pointer(cur.x, cur.y, buttonMask);
        await sleep(40);
        session.pointer(cur.x, cur.y, 0);
        return `你双击了${buttonName(buttonMask)}（${cur.x}, ${cur.y}）。`;
      }
      case "right_click":
      case "middle_click": {
        const mask = action === "right_click" ? MOUSE.RIGHT : MOUSE.MIDDLE;
        session.pointer(cur.x, cur.y, mask);
        await sleep(50);
        session.pointer(cur.x, cur.y, 0);
        return `你点了${buttonName(mask)}（${cur.x}, ${cur.y}）。`;
      }
      case "press":
        session.pointer(cur.x, cur.y, buttonMask);
        return `你按住了${buttonName(buttonMask)}（${cur.x}, ${cur.y}）没松手——需要移动/拖动就先调 move，要松开就用 mouse action: release。`;
      case "release":
        session.pointer(cur.x, cur.y, 0);
        return `你松开了鼠标按钮（${cur.x}, ${cur.y}）。`;
      case "drag": {
        const x2 = num(args.x2)!;
        const y2 = num(args.y2)!;
        session.pointer(cur.x, cur.y, MOUSE.LEFT);
        await sleep(60);
        // 分步移动，让远程应用识别出"拖动"
        const steps = 6;
        for (let i = 1; i <= steps; i++) {
          session.pointer(cur.x + ((x2 - cur.x) * i) / steps, cur.y + ((y2 - cur.y) * i) / steps, MOUSE.LEFT);
          await sleep(30);
        }
        await sleep(40);
        session.pointer(x2, y2, 0);
        return `你按住鼠标左键，从 (${cur.x}, ${cur.y}) 拖到了 (${x2}, ${y2}) 才松开。`;
      }
      case "scroll": {
        const dir = String(args.direction ?? args.dir ?? "down");
        const times = clampInt(num(args.times) ?? 1, 1, 20);
        const mask = scrollMask(dir);
        if (mask === null) return "（scroll 的 direction 只能是 up / down / left / right。）";
        for (let i = 0; i < times; i++) {
          session.pointer(cur.x, cur.y, mask);
          await sleep(30);
          session.pointer(cur.x, cur.y, 0);
          await sleep(30);
        }
        return `你在 (${cur.x}, ${cur.y}) 处滚动滚轮${dir === "up" ? "向上" : dir === "down" ? "向下" : dir === "left" ? "向左" : "向右"} ${times} 格。`;
      }
      default:
        return `（不认识的动作 ${action}：可用 move / click / double_click / right_click / middle_click / press / release / drag / scroll。）`;
    }
  }

  private async keyboard(args: Record<string, unknown>): Promise<string> {
    const session = this.session!;
    const action = String(args.action ?? args.a ?? "").trim();
    if (!action) return "（keyboard 需要 action 参数：type / key / combo / press / release。）";
    switch (action) {
      case "type": {
        const text = String(args.text ?? args.t ?? "");
        if (!text) return "（type 需要 text 参数：要输入的文本。中文等会通过剪贴板粘贴输入。）";
        await session.typeText(text);
        return `你在键盘上敲下了：${text}`;
      }
      case "key": {
        const key = String(args.key ?? args.k ?? "");
        const ks = resolveKey(key);
        if (ks === null) return `（不认识的键：${key}。可用 enter/tab/backspace/esc/箭头键/delete/home/end/f1-f12 等，或单个字符。）`;
        await session.tapKey(ks.keysym, ks.shift);
        return `你按了一下${keyLabel(key)}。`;
      }
      case "combo": {
        const raw = args.keys ?? args.combo ?? args.k;
        const keys = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[+\s]+/).filter(Boolean);
        if (!keys.length) return "（combo 需要 keys 参数：键名列表，如 [\"ctrl\",\"c\"] 表示 Ctrl+C。）";
        await session.keyCombo(keys);
        return `你按了组合键 ${keys.join(" + ")}。`;
      }
      case "press":
      case "release": {
        const key = String(args.key ?? args.k ?? "");
        const ks = resolveKey(key);
        if (ks === null) return `（不认识的键：${key}。）`;
        await session.keyHold(ks.keysym, action === "press", ks.shift);
        return action === "press" ? `你按住了 ${keyLabel(key)} 没松手。` : `你松开了 ${keyLabel(key)}。`;
      }
      default:
        return "（不认识的动作，可用 type / key / combo / press / release。）";
    }
  }
}

// ---------- 工具定义 ----------

const MOUSE_ACTIONS = ["move", "click", "double_click", "right_click", "middle_click", "press", "release", "drag", "scroll"];
const KEY_ACTIONS = ["type", "key", "combo", "press", "release"];

const TOOLS: AppRawTool[] = [
  {
    name: "screen",
    description:
      "截取远程桌面当前屏幕，以图片附件形式给你看到画面（就像抬头看一眼屏幕）。" +
      "这是你操作界面的主要依据：先 screen 看清界面，再用 mouse / keyboard 操作，之后随时 screen 看结果。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mouse",
    description:
      "操作远程桌面的鼠标。坐标以像素计，(0,0) 在屏幕左上角。action：" +
      "move 移动；click 单击（button 可指定 left/right/middle，默认左键）；double_click 双击；" +
      "right_click / middle_click 右击/中击；press 按住按钮不松开；release 松开；" +
      "drag 按住左键从 (x,y) 拖到 (x2,y2) 再松开；scroll 滚动滚轮（direction: up/down/left/right，times 滚几格）。" +
      "操作后记得 screen 看结果。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: MOUSE_ACTIONS },
        x: { type: "number", description: "x 坐标（像素）" },
        y: { type: "number", description: "y 坐标（像素）" },
        x2: { type: "number", description: "drag 的终点 x" },
        y2: { type: "number", description: "drag 的终点 y" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "按键，默认 left" },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "scroll 方向" },
        times: { type: "number", description: "scroll 滚动的格数，默认 1" },
      },
      required: ["action"],
    },
  },
  {
    name: "keyboard",
    description:
      "在远程桌面输入。action：type 输入一段文本（英文按键输入，中文等自动通过剪贴板粘贴）；" +
      "key 按单个键（enter/tab/backspace/esc/up/down/left/right/delete/home/end/pageup/pagedown/f1-f12/capslock 等，或单个字符）；" +
      "combo 组合键（keys 为键名列表，如 [\"ctrl\",\"c\"]）；press 按住一个键；release 松开。" +
      "操作后记得 screen 看结果。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: KEY_ACTIONS },
        text: { type: "string", description: "type 时要输入的文本" },
        key: { type: "string", description: "key / press / release 的键名或字符" },
        keys: { type: "array", items: { type: "string" }, description: "combo 的键名列表" },
      },
      required: ["action"],
    },
  },
];

// ---------- 工具函数 ----------

/** 按键名/单字符 → keysym + shift。不认识返回 null */
function resolveKey(key: string): { keysym: number; shift: boolean } | null {
  const k = String(key ?? "").trim();
  if (!k) return null;
  const named = namedKey(k);
  if (named !== null) return { keysym: named, shift: false };
  if (k.length === 1) return charKey(k);
  return null;
}

function buttonOf(b: string): number {
  if (b === "right") return MOUSE.RIGHT;
  if (b === "middle") return MOUSE.MIDDLE;
  return MOUSE.LEFT;
}

function buttonName(mask: number): string {
  if (mask === MOUSE.RIGHT) return "鼠标右键";
  if (mask === MOUSE.MIDDLE) return "鼠标中键";
  return "鼠标左键";
}

function scrollMask(dir: string): number | null {
  switch (String(dir ?? "").toLowerCase()) {
    case "up":
      return MOUSE.WHEEL_UP;
    case "down":
      return MOUSE.WHEEL_DOWN;
    case "left":
      return MOUSE.WHEEL_LEFT;
    case "right":
      return MOUSE.WHEEL_RIGHT;
    default:
      return null;
  }
}

function keyLabel(key: string): string {
  return `「${key}」键`;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
