import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "koishi";
import type { AppRawTool, WorldApp } from "./app.js";

const MAX_LIST_ITEMS = 200;
const DEFAULT_SHOW_LINES = 200;
const MAX_SHOW_LINES = 1000;
const MAX_TEXT_CHARS = 20_000;
const MAX_WRITE_CHARS = 8000;
const MAX_PATCH_CHARS = 8000;
const READ_ONLY_HINT =
  "\n----\n（这是只读文件内容。接下来若要补全/修改，请调用 write 或 patch 工具，不要直接输出正文。）";

const TOOLS: AppRawTool[] = [
  {
    name: "list",
    description: "列出文件应用工作目录（或指定子目录）里的文件和文件夹。这是只读结果，看完后继续输出 JSON 工具调用。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对于工作目录的路径；省略为工作目录根" },
      },
    },
  },
  {
    name: "show",
    description:
      "显示一个文本文件的内容并带行号。默认从第 1 行开始最多 200 行；修改文件前先用它确认当前内容。看到内容后不要复述，继续用 write 或 patch 修改时仍然只输出 JSON 工具调用。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要查看的文件路径" },
        start: { type: "number", description: "起始行号，默认 1" },
        max_lines: { type: "number", description: "最多显示多少行，默认 200，上限 1000" },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description:
      "写入或覆盖一个文本文件；父目录不存在时会自动创建。content 参数就是文件正文，但你的输出仍然是 JSON 工具调用。单次别塞太长；超过约 8000 字符就先 write 创建/写开头，再用 append: true 分块追加。append: true 表示追加。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要写入的文件路径" },
        content: { type: "string", description: "完整文件内容" },
        append: { type: "boolean", description: "true 时追加到文件末尾，默认 false" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "patch",
    description:
      "用 apply_patch 块或 unified diff 精确修改文件，支持新增、修改、删除文件。patch 参数传补丁文本；调用本身仍然是 JSON 工具调用，不要直接把补丁或代码作为正文输出。只 patch 当前要改的局部，不要一次塞整个长文件；超过约 8000 字符就分多次。修改前先 show 确认上下文。",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string", description: "patch 内容" },
      },
      required: ["patch"],
    },
  },
  {
    name: "mkdir",
    description: "创建目录，可以递归创建多级目录。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要创建的目录路径" },
      },
      required: ["path"],
    },
  },
  {
    name: "delete",
    description: "删除文件或目录。目录需要 recursive: true 才会整棵删除，请谨慎使用。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的文件或目录路径" },
        recursive: { type: "boolean", description: "删除目录树时设为 true" },
      },
      required: ["path"],
    },
  },
];

type PatchOp =
  | { type: "add"; path: string; lines: string[] }
  | { type: "update"; path: string; lines: string[] }
  | { type: "delete"; path: string; lines: string[] };

interface PatchHunk {
  oldLines: string[];
  newLines: string[];
}

interface PreparedPatch {
  op: PatchOp;
  target: string;
  content?: string;
}

/** 内置文件 App：把本地文件操作拆成独立工具，避免 Bot 只能用 run_command 拼 shell 改文件。 */
export class FilesApp implements WorldApp {
  readonly id = "files";
  readonly name = "文件";
  readonly description = "查看和编辑本地工作目录中的文件，支持 list/show/write/patch/mkdir/delete";

  constructor(
    private baseDir: string,
    private cwd: string,
    private logger: Logger,
  ) {}

  async open(): Promise<{ tools: AppRawTool[] }> {
    await this.ensureRoot();
    return { tools: TOOLS };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case "list":
        return this.list(args);
      case "show":
        return this.show(args);
      case "write":
        return this.write(args);
      case "patch":
        return this.patch(args);
      case "mkdir":
        return this.mkdir(args);
      case "delete":
        return this.remove(args);
      default:
        throw new Error(`文件应用没有 ${tool} 这个操作`);
    }
  }

  async close(): Promise<void> {
    /* 本地文件 App 没有连接需要释放 */
  }

  // ---------- 路径安全 ----------

  private rootPath(): string {
    return path.resolve(this.baseDir, this.cwd || ".");
  }

  private async ensureRoot(): Promise<string> {
    await fs.mkdir(this.rootPath(), { recursive: true });
    return fs.realpath(this.rootPath());
  }

  private resolveLexical(raw: unknown): string {
    const root = this.rootPath();
    const input = raw == null ? "." : String(raw).trim();
    const target = path.resolve(root, input || ".");
    if (!isInside(root, target)) {
      throw new Error(`路径超出文件应用工作目录：${this.displayPath(target)}`);
    }
    return target;
  }

  private async resolveExisting(raw: unknown): Promise<string> {
    const target = this.resolveLexical(raw);
    const root = await this.ensureRoot();
    if (!(await exists(target))) {
      throw new Error(`文件不存在：${this.displayPath(target)}`);
    }
    const real = await fs.realpath(target);
    if (!isInside(root, real)) {
      throw new Error(`路径指向文件应用工作目录外：${this.displayPath(target)}`);
    }
    return target;
  }

  private async resolveWritable(raw: unknown): Promise<string> {
    const target = this.resolveLexical(raw);
    const root = await this.ensureRoot();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const realDir = await fs.realpath(path.dirname(target));
    if (!isInside(root, realDir)) {
      throw new Error(`路径指向文件应用工作目录外：${this.displayPath(target)}`);
    }
    if (await exists(target)) {
      const realTarget = await fs.realpath(target);
      if (!isInside(root, realTarget)) {
        throw new Error(`路径指向文件应用工作目录外：${this.displayPath(target)}`);
      }
    }
    return target;
  }

  private displayPath(target: string): string {
    const rel = path.relative(this.rootPath(), target);
    if (!rel) return ".";
    return rel.split(path.sep).join("/");
  }

  // ---------- 工具实现 ----------

  private async list(args: Record<string, unknown>): Promise<string> {
    const target = await this.resolveExisting(args.path);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const rows: { name: string; kind: "dir" | "file" | "link"; detail: string }[] = [];
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) {
        rows.push({ name: `${entry.name}/`, kind: "dir", detail: "" });
      } else if (entry.isFile()) {
        const st = await fs.stat(full);
        rows.push({ name: entry.name, kind: "file", detail: formatSize(st.size) });
      } else if (entry.isSymbolicLink()) {
        rows.push({ name: `${entry.name} ->`, kind: "link", detail: "符号链接" });
      } else {
        rows.push({ name: entry.name, kind: "file", detail: "其他" });
      }
    }
    rows.sort(
      (a, b) =>
        Number(b.kind === "dir") - Number(a.kind === "dir") ||
        a.name.localeCompare(b.name, "zh-CN"),
    );
    const limited = rows.slice(0, MAX_LIST_ITEMS);
    const lines = limited.map(
      (row) =>
        `[${row.kind === "dir" ? "dir" : row.kind === "link" ? "link" : "file"}] ${row.name}` +
        (row.detail ? ` (${row.detail})` : ""),
    );
    const more = rows.length > limited.length ? `\n----\n（还有 ${rows.length - limited.length} 项未列出）` : "";
    return `文件 · ${this.displayPath(target)}\n----\n${lines.join("\n") || "（空目录）"}${more}`;
  }

  private async show(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path ?? args.file;
    if (rawPath == null || !String(rawPath).trim()) return "（show 需要 path 参数。）";
    const target = await this.resolveExisting(rawPath);
    const st = await fs.stat(target);
    if (st.isDirectory()) return `（${this.displayPath(target)} 是目录，请用 list 查看。）`;
    const content = (await fs.readFile(target, "utf8")).replace(/^\uFEFF/, "");
    if (content.includes("\0")) return `（${this.displayPath(target)} 看起来不是文本文件。）`;
    const lines = content.split(/\r?\n/);
    const start = clampInt(args.start, 1, Math.max(1, lines.length), 1);
    const maxLines = clampInt(
      args.max_lines ?? args.maxLines,
      1,
      MAX_SHOW_LINES,
      DEFAULT_SHOW_LINES,
    );
    const end = Math.min(lines.length, start - 1 + maxLines);
    const width = String(end).length;
    const bodyLines: string[] = [];
    for (let i = start - 1; i < end; i++) {
      bodyLines.push(`${String(i + 1).padStart(width)}| ${lines[i] ?? ""}`);
    }
    const fullBody = bodyLines.join("\n");
    const body =
      fullBody.length > MAX_TEXT_CHARS
        ? `${fullBody.slice(0, MAX_TEXT_CHARS)}\n…（已截断，剩余 ${fullBody.length - MAX_TEXT_CHARS} 字符）`
        : fullBody;
    const remaining =
      lines.length > end ? `\n----\n（还有 ${lines.length - end} 行；可用 start/max_lines 继续查看）` : "";
    return `${this.displayPath(target)} (${lines.length} 行)\n----\n${body}${remaining}${READ_ONLY_HINT}`;
  }

  private async write(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path ?? args.file;
    const content = String(args.content ?? "");
    if (rawPath == null || !String(rawPath).trim()) {
      return "（write 需要 path 和 content 参数。）";
    }
    if (content.length > MAX_WRITE_CHARS) {
      return `（write 内容过长：${content.length} 字符。单次 JSON 容易截断，请先 write 创建/写开头，再用 append: true 分块追加。）`;
    }
    const target = await this.resolveWritable(rawPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (isTruthy(args.append)) {
      await fs.appendFile(target, content, "utf8");
    } else {
      await atomicWrite(target, content);
    }
    return `已写入 ${this.displayPath(target)}（${content.length} 字符）。`;
  }

  private async mkdir(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path ?? args.dir;
    if (rawPath == null || !String(rawPath).trim()) return "（mkdir 需要 path 参数。）";
    const target = await this.resolveWritable(rawPath);
    await fs.mkdir(target, { recursive: true });
    return `已创建目录 ${this.displayPath(target)}。`;
  }

  private async remove(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path ?? args.file;
    if (rawPath == null || !String(rawPath).trim()) return "（delete 需要 path 参数。）";
    const target = await this.resolveExisting(rawPath);
    if (isRootPath(this.rootPath(), target)) {
      return "（不能删除文件应用工作目录本身。）";
    }
    const st = await fs.lstat(target);
    const recursive = isTruthy(args.recursive);
    if (st.isDirectory() && !recursive) {
      return `（${this.displayPath(target)} 是目录；如确认删除整棵树，请传 recursive: true。）`;
    }
    await fs.rm(target, { recursive, force: false });
    return `已删除 ${this.displayPath(target)}。`;
  }

  private async patch(args: Record<string, unknown>): Promise<string> {
    const raw = String(args.patch ?? args.diff ?? "");
    if (!raw.trim()) return "（patch 需要 patch 参数。）";
    if (raw.length > MAX_PATCH_CHARS) {
      return `（patch 内容过长：${raw.length} 字符。请只 patch 当前要改的局部，或分成多次调用。）`;
    }
    const ops = parsePatch(raw);
    if (!ops.length) return "（patch 里没有文件操作。）";
    const prepared: PreparedPatch[] = [];
    for (const op of ops) {
      switch (op.type) {
        case "add": {
          const target = await this.resolveWritable(op.path);
          if (await exists(target)) {
            throw new Error(`Add File 目标已存在：${this.displayPath(target)}，请改用 Update File`);
          }
          prepared.push({ op, target, content: addFileLines(op.lines).join("\n") });
          break;
        }
        case "update": {
          const target = await this.resolveExisting(op.path);
          const before = await fs.readFile(target, "utf8");
          const hadBom = before.startsWith("\uFEFF");
          const after = applyPatchHunks(before.replace(/^\uFEFF/, ""), parseUpdateHunks(op.lines));
          prepared.push({ op, target, content: hadBom ? `\uFEFF${after}` : after });
          break;
        }
        case "delete": {
          const target = await this.resolveExisting(op.path);
          if (isRootPath(this.rootPath(), target)) {
            throw new Error("Delete File 不能删除文件应用工作目录本身");
          }
          const st = await fs.lstat(target);
          if (st.isDirectory()) {
            throw new Error("Delete File 只能删除文件；目录请用 delete 工具");
          }
          prepared.push({ op, target });
          break;
        }
      }
    }
    const applied: string[] = [];
    for (const item of prepared) {
      const label = this.displayPath(item.target);
      switch (item.op.type) {
        case "add":
          await fs.mkdir(path.dirname(item.target), { recursive: true });
          await atomicWrite(item.target, item.content ?? "");
          applied.push(`新增 ${label}`);
          break;
        case "update":
          await atomicWrite(item.target, item.content ?? "");
          applied.push(`更新 ${label}`);
          break;
        case "delete":
          await fs.rm(item.target, { recursive: false, force: false });
          applied.push(`删除 ${label}`);
          break;
      }
    }
    return `已应用 patch：\n- ${applied.join("\n- ")}`;
  }
}

// ---------- patch 解析与应用 ----------

function parsePatch(raw: string): PatchOp[] {
  if (/^\s*\*\*\* Begin Patch/m.test(raw)) return parseApplyPatch(raw);
  const unified = parseUnifiedDiff(raw);
  if (unified.length) return unified;
  throw new Error("patch 需要以 *** Begin Patch 开头，或使用 unified diff 格式");
}

function parseApplyPatch(raw: string): PatchOp[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  if (start < 0) throw new Error("patch 缺少 *** Begin Patch");
  const ops: PatchOp[] = [];
  let current: PatchOp | null = null;
  let ended = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "*** End Patch") {
      if (current) ops.push(current);
      ended = true;
      break;
    }
    if (trimmed === "*** End of File") continue;
    if (/^\*\*\*\s+Move to:/i.test(trimmed)) {
      throw new Error("patch 暂不支持 Move to，请用 Add File + Delete File");
    }
    const header = /^\*\*\*\s+(Add File|Delete File|Update File):\s+(.+)$/i.exec(trimmed);
    if (header) {
      if (current) ops.push(current);
      const kind = header[1]!.toLowerCase();
      const file = header[2]!.trim();
      if (kind === "add file") {
        current = { type: "add", path: file, lines: [] };
      } else if (kind === "delete file") {
        current = { type: "delete", path: file, lines: [] };
      } else {
        current = { type: "update", path: file, lines: [] };
      }
      continue;
    }
    if (!current) throw new Error(`patch 在文件头之前出现了内容：${line.slice(0, 80)}`);
    current.lines.push(line);
  }
  if (!ended) throw new Error("patch 缺少 *** End Patch");
  return ops;
}

function parseUnifiedDiff(raw: string): PatchOp[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (!lines.some((line) => line.startsWith("--- "))) return [];
  const ops: PatchOp[] = [];
  let oldPath: string | null = null;
  let current: PatchOp | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git")) continue;
    if (line.startsWith("--- ")) {
      if (current) ops.push(current);
      current = null;
      oldPath = diffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (current) ops.push(current);
      const newPath = diffPath(line.slice(4));
      if (!oldPath && newPath) {
        current = { type: "add", path: newPath, lines: [] };
      } else if (oldPath && !newPath) {
        current = { type: "delete", path: oldPath, lines: [] };
      } else {
        current = { type: "update", path: newPath || oldPath || "", lines: [] };
      }
      oldPath = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      current.lines.push(line);
    } else if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      current.lines.push(line);
    } else if (line.startsWith("\\")) {
      continue;
    } else if (line.trim()) {
      // 非 diff 说明文字直接忽略，避免把 git 输出混进 hunk
      continue;
    }
  }
  if (current) ops.push(current);
  return ops;
}

function diffPath(raw: string): string {
  let value = raw.trim().replace(/^"|"$/g, "");
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  if (value === "/dev/null") return "";
  return value;
}

function addFileLines(lines: string[]): string[] {
  if (lines.length && lines.every((line) => line.startsWith("+"))) {
    return lines.map((line) => line.slice(1));
  }
  return lines;
}

function parseUpdateHunks(lines: string[]): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "*** End of File") break;
    if (trimmed.startsWith("@@")) {
      if (current) hunks.push(current);
      current = { oldLines: [], newLines: [] };
      continue;
    }
    if (
      !line.startsWith("+") &&
      !line.startsWith("-") &&
      !line.startsWith(" ") &&
      line.trim() !== ""
    ) {
      throw new Error(`patch 内容行必须以 +、-、空格或 @@ 开头：${line.slice(0, 80)}`);
    }
    current ??= { oldLines: [], newLines: [] };
    if (line.startsWith("-")) {
      current.oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      current.newLines.push(line.slice(1));
    } else {
      const text = line.slice(1);
      current.oldLines.push(text);
      current.newLines.push(text);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function applyPatchHunks(source: string, hunks: PatchHunk[]): string {
  let lines = source.split(/\r?\n/);
  for (const hunk of hunks) {
    if (!hunk.oldLines.length) {
      lines = [...lines, ...hunk.newLines];
      continue;
    }
    const idx = findSequence(lines, hunk.oldLines);
    if (idx < 0) {
      const sample = hunk.oldLines.slice(0, 3).join("⏎") || "（空）";
      throw new Error(`找不到匹配的上下文：${sample}`);
    }
    const next = lines.slice();
    next.splice(idx, hunk.oldLines.length, ...hunk.newLines);
    lines = next;
  }
  return lines.join("\n");
}

function findSequence(lines: string[], seq: string[]): number {
  outer: for (let i = 0; i <= lines.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (lines[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ---------- 小工具 ----------

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isRootPath(root: string, target: string): boolean {
  return path.resolve(root) === path.resolve(target);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isTruthy(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === "1" || raw === "true";
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
