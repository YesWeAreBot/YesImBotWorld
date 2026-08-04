/**
 * 字符 → X11 keysym 的映射（VNC 键盘事件用）。
 *
 * RFB 的 KeyEvent 消息携带 keysym。真实键盘是"基础键 + Shift"产生一个字符，
 * 这里按美式键盘布局把每个可打印字符映射为 { 基础键 keysym, 是否需要 Shift }：
 * 输入时先按下 Shift（若需要），再按下/松开基础键，再松开 Shift——
 * 对应用（如需要识别 Ctrl+Shift 组合、大写锁定状态的应用）表现最接近真人。
 *
 * 非 ASCII（中文等）没有对应单键 keysym，返回 null，
 * 由上层走"写入剪贴板 + Ctrl+V"的方式输入。
 */

/** 一个字符的按键描述：基础键的 keysym 与是否需要 Shift */
export interface KeyStroke {
  keysym: number;
  shift: boolean;
}

// ---------- 特殊键 keysym（X11 命名，0xff00 段） ----------

export const X11 = {
  return: 0xff0d,
  enter: 0xff0d,
  tab: 0xff09,
  backspace: 0xff08,
  escape: 0xff1b,
  delete: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  pageUp: 0xff55,
  pageDown: 0xff56,
  up: 0xff52,
  down: 0xff54,
  left: 0xff51,
  right: 0xff53,
  space: 0x20,
  capsLock: 0xffe5,
  numLock: 0xff7f,
  scrollLock: 0xff14,
  printScreen: 0xff61,
  pause: 0xff13,
  menu: 0xff67,
  ctrl: 0xffe3,
  shift: 0xffe1,
  alt: 0xffe9,
  meta: 0xffe7,
  super: 0xffeb,
  win: 0xffeb,
  f1: 0xffbe,
  f2: 0xffbf,
  f3: 0xffc0,
  f4: 0xffc1,
  f5: 0xffc2,
  f6: 0xffc3,
  f7: 0xffc4,
  f8: 0xffc5,
  f9: 0xffc6,
  f10: 0xffc7,
  f11: 0xffc8,
  f12: 0xffc9,
} as const;

/** 常见组合键名称 → keysym（小写匹配） */
const NAMED: Record<string, number> = Object.fromEntries(
  Object.entries(X11).map(([name, keysym]) => [name.toLowerCase(), keysym]),
);

/** 需要 Shift 才能打出来的字符（美式布局）：基础键 → 对应字符 */
const SHIFTED: Record<string, string> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

/**
 * 单个可打印字符的按键描述。ASCII 之外（中文等）返回 null（走剪贴板粘贴）。
 */
export function charKey(ch: string): KeyStroke | null {
  const code = ch.charCodeAt(0);
  if (code === 0x20) return { keysym: 0x20, shift: false };
  if (code >= 0x21 && code <= 0x7e) {
    const base = SHIFTED[ch];
    if (base) return { keysym: base.charCodeAt(0), shift: true };
    if (ch >= "A" && ch <= "Z") return { keysym: code + 0x20, shift: true }; // 大写字母 = 小写键 + Shift
    return { keysym: code, shift: false };
  }
  if (code < 0x100) return { keysym: code, shift: false }; // Latin-1 直接映射
  return null;
}

/**
 * 特殊键名称 → keysym（enter/esc/f5/ctrl/…）。找不到返回 null。
 */
export function namedKey(name: string): number | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const hit = NAMED[key];
  if (hit !== undefined) return hit;
  // 兼容 "Ctrl"、"WIN"、"Delete" 等常见大小写写法
  if (/^ctrl(?:l)?$/.test(key)) return X11.ctrl;
  if (/^shift$/.test(key)) return X11.shift;
  if (/^alt$/.test(key)) return X11.alt;
  if (/^(super|win|windows)$/.test(key)) return X11.super;
  if (/^(enter|return)$/.test(key)) return X11.return;
  if (/^(esc)$/.test(key)) return X11.escape;
  if (/^(del|delete)$/.test(key)) return X11.delete;
  if (/^(ins|insert)$/.test(key)) return X11.insert;
  if (/^(pgup|pageup)$/.test(key)) return X11.pageUp;
  if (/^(pgdn|pagedown)$/.test(key)) return X11.pageDown;
  const f = /^f([1-9]|1[0-2])$/i.exec(key);
  if (f) return X11[`f${f[1]}` as keyof typeof X11] as number;
  return null;
}
