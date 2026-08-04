/**
 * VNC（RFB）会话封装：连接、帧缓冲画布、截屏、鼠标与键盘输入。
 *
 * 协议握手/认证/消息解析由 rfb2 负责；这里负责：
 * - 维护一整块"屏幕画布"（RGBA8），把服务器推送的矩形更新解码并画上去；
 * - 截屏：请求一次全量刷新，等画布刷新完整后下采样并编码成 PNG；
 * - 输入：pointer（按钮掩码）/ key（keysym）/ 剪贴板粘贴，串行化避免事件交错。
 *
 * 像素格式按服务器 ServerInit 声明解码（bpp/endian/掩码/移位），
 * 只请求 raw 编码，保证收到的矩形都是可直接解码的原始像素。
 */

import net from "node:net";
import type { Logger } from "koishi";
import * as rfb2 from "rfb2";
import { encodePng } from "./png.js";
import { charKey, namedKey, X11 } from "./keysyms.js";

/** 鼠标按钮掩码（RFB 标准） */
export const MOUSE = {
  LEFT: 1,
  MIDDLE: 2,
  RIGHT: 4,
  WHEEL_UP: 8,
  WHEEL_DOWN: 16,
  WHEEL_LEFT: 32,
  WHEEL_RIGHT: 64,
} as const;

export interface RfbOptions {
  host: string;
  port: number;
  password?: string;
  /** 连接超时（毫秒） */
  connectTimeoutMs?: number;
}

interface PixelFormat {
  bpp: number;
  bigEndian: boolean;
  trueColor: boolean;
  redMax: number;
  greenMax: number;
  blueMax: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
  redMask: number;
  greenMask: number;
  blueMask: number;
}

interface RfbRect {
  x: number;
  y: number;
  width: number;
  height: number;
  encoding: number;
  data?: Buffer;
  src?: { x: number; y: number };
}

/** rfb2 暴露的运行时字段与方法的宽松类型（其自带 d.ts 不完整） */
interface RfbClientHandle {
  width: number;
  height: number;
  bpp: number;
  depth: number;
  isBigEndian: number;
  isTrueColor: number;
  redMax: number;
  greenMax: number;
  blueMax: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
  requestUpdate(incremental: boolean, x: number, y: number, w: number, h: number): void;
  on(event: string, cb: (...args: any[]) => void): void;
  removeAllListeners(): void;
}

export interface ScreenShot {
  width: number;
  height: number;
  png: Buffer;
}

export class RfbSession {
  private client: RfbClientHandle | null = null;
  private socket: net.Socket | null = null;
  private fmt: PixelFormat | null = null;
  private fbWidth = 0;
  private fbHeight = 0;
  /** RGBA8 屏幕画布 */
  private canvas: Uint8Array = new Uint8Array(0);
  private connPromise: Promise<void> | null = null;
  private snapWaiter: { remaining: number; resolve: (shot: ScreenShot) => void } | null = null;
  private snapMaxWidth = 1024;
  private snapLock: Promise<void> = Promise.resolve();
  private inputLock: Promise<void> = Promise.resolve();
  private closed = false;
  /** 最近一次指针位置（press/release/scroll 缺省用这里） */
  private pointerPos = { x: -1, y: -1 };

  constructor(
    private opts: RfbOptions,
    private logger: Logger,
  ) {}

  /** 已连接且就绪 */
  get connected(): boolean {
    return this.client !== null && !this.closed;
  }

  /** 远程屏幕尺寸 */
  get screenSize(): { width: number; height: number } {
    return { width: this.fbWidth, height: this.fbHeight };
  }

  get width(): number {
    return this.fbWidth;
  }

  get height(): number {
    return this.fbHeight;
  }

  get lastPointer(): { x: number; y: number } {
    return { ...this.pointerPos };
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.closed = false;
    this.connPromise ??= new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        client?.removeAllListeners();
        socket?.removeAllListeners();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        this.connPromise = null;
        this.client = null;
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Error(`连接超时（${this.opts.host}:${this.opts.port}）`)),
        this.opts.connectTimeoutMs ?? 10000,
      );
      const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
      let client: RfbClientHandle;
      try {
        client = rfb2.createConnection({
          stream: socket,
          password: this.opts.password,
          encodings: [rfb2.encodings.raw],
        } as unknown as Parameters<typeof rfb2.createConnection>[0]) as unknown as RfbClientHandle;
      } catch (err) {
        socket.destroy();
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      socket.on("error", (err) => fail(err));
      client.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
      client.on("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.client = client;
        this.socket = socket;
        this.fmt = {
          bpp: client.bpp,
          bigEndian: client.isBigEndian === 1,
          trueColor: client.isTrueColor === 1,
          redMax: client.redMax,
          greenMax: client.greenMax,
          blueMax: client.blueMax,
          redShift: client.redShift,
          greenShift: client.greenShift,
          blueShift: client.blueShift,
          redMask: client.redMax << client.redShift,
          greenMask: client.greenMax << client.greenShift,
          blueMask: client.blueMax << client.blueShift,
        };
        this.fbWidth = client.width;
        this.fbHeight = client.height;
        this.canvas = new Uint8Array(this.fbWidth * this.fbHeight * 4);
        this.logger.info(
          "远程桌面已连接：%s:%s（%dx%d，bpp=%d）",
          this.opts.host,
          this.opts.port,
          this.fbWidth,
          this.fbHeight,
          this.fmt.bpp,
        );
        resolve();
      });
      client.on("rect", (rect) => this.onRect(rect));
      client.on("resize", (rect) => this.onResize(rect.width, rect.height));
      socket.on("close", () => {
        this.closed = true;
        this.client = null;
        this.socket = null;
        this.connPromise = null;
        this.failPendingSnapshot();
      });
    });
    return this.connPromise;
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.client = null;
    this.closed = true;
    this.connPromise = null;
    this.failPendingSnapshot();
    try {
      socket?.destroy();
    } catch {
      /* 已断开 */
    }
  }

  // ---------- 截屏 ----------

  /**
   * 截取当前屏幕：请求一次全量刷新，等画布被刷新完整后下采样（最大宽度 maxWidth）
   * 并编码为 PNG。串行化（同一时间只有一个截屏在进行）。
   */
  async snapshot(maxWidth: number): Promise<ScreenShot> {
    const run = this.snapLock.then(async () => {
      await this.connect();
      if (!this.client || this.closed) throw new Error("远程桌面连接已断开");
      const { width, height } = this.screenSize;
      if (!width || !height) throw new Error("远程桌面还没有收到画面");
      const shot = await new Promise<ScreenShot>((resolve) => {
        this.snapMaxWidth = maxWidth;
        this.snapWaiter = { remaining: width * height, resolve };
        this.client!.requestUpdate(false, 0, 0, width, height);
        const waiter = this.snapWaiter;
        // 兜底：某些服务器全量刷新不完整或迟迟不响应
        setTimeout(() => {
          if (this.snapWaiter === waiter) this.finishSnapshot();
        }, 1200);
      });
      return shot;
    });
    this.snapLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private finishSnapshot(): void {
    const w = this.snapWaiter;
    if (!w) return;
    this.snapWaiter = null;
    const { width, height } = this.screenSize;
    const targetWidth = Math.max(64, Math.floor(this.snapMaxWidth));
    let img = this.canvas;
    let outW = width;
    let outH = height;
    if (width > targetWidth) {
      outW = targetWidth;
      outH = Math.max(64, Math.round((height * targetWidth) / width));
      img = downscaleRgba(this.canvas, width, height, outW, outH);
    }
    try {
      const png = encodePng(outW, outH, img, 4);
      w.resolve({ width: outW, height: outH, png });
    } catch (err) {
      this.logger.warn("远程桌面截屏编码失败: %s", err);
      w.resolve({ width: 0, height: 0, png: Buffer.alloc(0) });
    }
  }

  private failPendingSnapshot(): void {
    const w = this.snapWaiter;
    if (!w) return;
    this.snapWaiter = null;
    w.resolve({ width: 0, height: 0, png: Buffer.alloc(0) });
  }

  // ---------- 输入 ----------

  /**
   * 指针事件：按钮掩码 0=移动；1/2/4=左/中/右按下；8/16/32/64=滚轮。
   * 注：rfb2 的 pointerEvent() 把 clientMsgTypes.pointerEvent/keyEvent 的常量写反了
   * （按 RFB 规范 PointerEvent=4、KeyEvent=5），直接写给真实 VNC 服务器会被误解，
   * 所以这里自行按规范字节序构造消息。
   */
  pointer(x: number, y: number, buttons: number): void {
    if (!this.client) return;
    const pos = clampPointer({ x, y }, this.fbWidth, this.fbHeight);
    this.pointerPos = pos;
    const msg = Buffer.alloc(6);
    msg[0] = 4; // PointerEvent
    msg[1] = buttons;
    msg.writeUInt16BE(pos.x, 2);
    msg.writeUInt16BE(pos.y, 4);
    this.socket?.write(msg);
  }

  /** 键盘事件：按下/松开一个 keysym（KeyEvent=5，同上面指针的规范修正） */
  key(keysym: number, down: boolean): void {
    if (!this.client) return;
    const msg = Buffer.alloc(8);
    msg[0] = 5; // KeyEvent
    msg[1] = down ? 1 : 0;
    msg.writeUInt32BE(keysym, 4);
    this.socket?.write(msg);
  }

  /** 输入一段文本：ASCII 按键输入，非 ASCII（中文等）走剪贴板 + Ctrl+V */
  typeText(text: string): Promise<void> {
    return this.queued(async () => {
      let i = 0;
      while (i < text.length) {
        const ks = charKey(text[i]!);
        if (ks) {
          await this.tapKey(ks.keysym, ks.shift);
          i++;
        } else {
          let j = i;
          while (j < text.length && !charKey(text[j]!)) j++;
          await this.pasteText(text.slice(i, j));
          i = j;
        }
      }
    });
  }

  /** 按下并松开一个键（可选 Shift） */
  async tapKey(keysym: number, shift = false): Promise<void> {
    if (shift) this.key(X11.shift, true);
    this.key(keysym, true);
    await sleep(30);
    this.key(keysym, false);
    if (shift) this.key(X11.shift, false);
    await sleep(15);
  }

  /** 按住/松开一个键（组合键、或游戏里持续按住；shift 表示该字符需要 Shift） */
  keyHold(keysym: number, down: boolean, shift = false): Promise<void> {
    return this.queued(async () => {
      if (down && shift) this.key(X11.shift, true);
      this.key(keysym, down);
      if (!down && shift) this.key(X11.shift, false);
      await sleep(30);
    });
  }

  /** 按一组键（如 ["ctrl","c"]：按顺序按下、逆序松开）。键名支持特殊键或单个字符 */
  keyCombo(names: string[]): Promise<void> {
    return this.queued(async () => {
      const keysyms: number[] = [];
      for (const n of names) {
        const ks = namedKeyOf(n) ?? (n.length === 1 ? charKey(n) : null);
        if (ks === null) throw new Error(`不认识的键名：${n}`);
        if (ks.shift) keysyms.push(X11.shift, ks.keysym);
        else keysyms.push(ks.keysym);
      }
      for (const k of keysyms) this.key(k, true);
      await sleep(60);
      for (const k of [...keysyms].reverse()) this.key(k, false);
      await sleep(30);
    });
  }

  /**
   * 把文本放进远程剪贴板并 Ctrl+V 粘贴（ClientCutText=6）。
   * 注意：只在 typeText（已串行化）内部调用，自身不再加锁，否则会与调用方互相等待死锁。
   */
  private async pasteText(text: string): Promise<void> {
    const t = Buffer.from(text, "utf8");
    const msg = Buffer.alloc(8 + t.length);
    msg[0] = 6; // ClientCutText
    msg.writeUInt32BE(t.length, 4);
    t.copy(msg, 8);
    this.socket?.write(msg);
    await sleep(150);
    this.key(X11.ctrl, true);
    this.key(0x76, true); // 'v'
    await sleep(40);
    this.key(0x76, false);
    this.key(X11.ctrl, false);
    await sleep(100);
  }

  // ---------- 内部 ----------

  private queued(fn: () => Promise<void>): Promise<void> {
    const run = this.inputLock.then(fn, fn);
    this.inputLock = run.catch(() => {});
    return run;
  }

  private onRect(rect: RfbRect): void {
    if (!this.fmt || !this.client) return;
    if (rect.encoding === rfb2.encodings.copyRect && rect.src) {
      this.blitCopy(rect, rect.src.x, rect.src.y);
      return;
    }
    if (rect.encoding !== rfb2.encodings.raw) return;
    this.blitRaw(rect);
  }

  private blitRaw(rect: RfbRect): void {
    const fmt = this.fmt!;
    const { width, height } = this;
    const data = rect.data;
    if (!data) return;
    const x0 = clampInt(rect.x, 0, width);
    const y0 = clampInt(rect.y, 0, height);
    const x1 = clampInt(rect.x + rect.width, 0, width);
    const y1 = clampInt(rect.y + rect.height, 0, height);
    const bpp = fmt.bpp >> 3;
    if (bpp < 1) return;
    const rowBytes = rect.width * bpp;
    for (let y = y0; y < y1; y++) {
      const srcRow = (y - rect.y) * rowBytes;
      const dstBase = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++) {
        const off = srcRow + (x - rect.x) * bpp;
        const v = readPixel(data, off, bpp, fmt.bigEndian);
        const o = dstBase + (x - x0) * 4;
        this.canvas[o] = scaleCh(v & fmt.redMask, fmt.redShift, fmt.redMax);
        this.canvas[o + 1] = scaleCh(v & fmt.greenMask, fmt.greenShift, fmt.greenMax);
        this.canvas[o + 2] = scaleCh(v & fmt.blueMask, fmt.blueShift, fmt.blueMax);
        this.canvas[o + 3] = 255;
      }
    }
    this.trackCoverage((x1 - x0) * (y1 - y0));
  }

  private blitCopy(rect: RfbRect, sx: number, sy: number): void {
    const { width, height } = this;
    const x0 = clampInt(rect.x, 0, width);
    const y0 = clampInt(rect.y, 0, height);
    const x1 = clampInt(rect.x + rect.width, 0, width);
    const y1 = clampInt(rect.y + rect.height, 0, height);
    const sw = x1 - x0;
    for (let y = y0; y < y1; y++) {
      const dstBase = (y * width + x0) * 4;
      const srcY = sy + (y - y0);
      if (srcY < 0 || srcY >= height) continue;
      const srcBase = (srcY * width + sx) * 4;
      this.canvas.set(this.canvas.subarray(srcBase, srcBase + sw * 4), dstBase);
    }
    this.trackCoverage(sw * (y1 - y0));
  }

  private trackCoverage(area: number): void {
    const w = this.snapWaiter;
    if (!w) return;
    w.remaining -= area;
    if (w.remaining <= 0) this.finishSnapshot();
  }

  private onResize(width: number, height: number): void {
    if (!width || !height || (width === this.fbWidth && height === this.fbHeight)) return;
    this.fbWidth = width;
    this.fbHeight = height;
    this.canvas = new Uint8Array(width * height * 4);
    this.logger.info("远程桌面分辨率变化：%dx%d", width, height);
  }
}

// ---------- 工具函数 ----------

function namedKeyOf(name: string): { keysym: number; shift: boolean } | null {
  const named = namedKey(name);
  if (named !== null) return { keysym: named, shift: false };
  if (name.length === 1) return charKey(name);
  return null;
}

function clampInt(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function clampPointer(p: { x: number; y: number }, w: number, h: number): { x: number; y: number } {
  return { x: clampInt(p.x, 0, Math.max(0, w - 1)), y: clampInt(p.y, 0, Math.max(0, h - 1)) };
}

function readPixel(buf: Buffer, off: number, bpp: number, be: boolean): number {
  switch (bpp) {
    case 1:
      return buf[off]!;
    case 2:
      return be ? buf.readUInt16BE(off) : buf.readUInt16LE(off);
    case 3:
      return be
        ? (buf[off]! << 16) | (buf[off + 1]! << 8) | buf[off + 2]!
        : buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16);
    default:
      return be ? buf.readUInt32BE(off) : buf.readUInt32LE(off);
  }
}

/** 通道值按掩码/移位取出后缩放到 0-255（非真彩色时直接取高位） */
function scaleCh(v: number, shift: number, max: number): number {
  const raw = (v >>> shift) & 0xff;
  if (max >= 255 || max <= 0) return raw;
  return Math.min(255, Math.round((raw * 255) / Math.min(max, 255)));
}

/** 下采样（盒式平均），保持宽高比 */
function downscaleRgba(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  const out = new Uint8Array(dstW * dstH * 4);
  const sy = srcH / dstH;
  const sx = srcW / dstW;
  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * sy);
    const y1 = Math.max(y0 + 1, Math.min(srcH, Math.ceil((dy + 1) * sy)));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * sx);
      const x1 = Math.max(x0 + 1, Math.min(srcW, Math.ceil((dx + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * srcW + x) * 4;
          r += src[o]!;
          g += src[o + 1]!;
          b += src[o + 2]!;
          n++;
        }
      }
      const o = (dy * dstW + dx) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
