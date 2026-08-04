/**
 * 内置资源管理器 App：Bot 的个人电脑上的文件管理器（对应真实电脑的“文件资源管理器”）。
 *
 * 双模式（创世时判定的世界性质，meta.json）：
 * - 现实世界：文件真的存在这台电脑（Docker 容器）里，操作通过容器执行，与主机隔离；
 * - 虚构世界：World-LLM 扮演这台电脑，直接生成符合世界观的目录/文件内容与操作结果。
 *
 * 与终端共用同一台电脑、同一个主目录：写出来的文件在终端里也能看到。
 */

import path from "node:path";
import type { Logger } from "koishi";
import type { BotComputer } from "../computer.js";
import type { WorldClock } from "../clock.js";
import type { AppsConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import type { WorldAgent } from "../world/agent.js";
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
    description: "列出资源管理器当前目录（或指定子目录）里的文件和文件夹。这是只读结果，看完后继续输出 JSON 工具调用。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对于当前目录的路径；省略为当前目录" },
      },
    },
  },
  {
    name: "show",
    description:
      "打开一个文本文件查看内容并带行号。默认从第 1 行开始最多 200 行；修改文件前先用它确认当前内容。看到内容后不要复述，继续用 write 或 patch 修改时仍然只输出 JSON 工具调用。",
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

interface FsResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * 内置资源管理器：操作 Bot 个人电脑里的文件。
 * 现实模式所有操作都执行在 Docker 容器里（BotComputer），与主机隔离。
 */
export class FileManagerApp implements WorldApp {
  readonly id = "files";
  readonly name = "资源管理器";
  readonly description = "这台电脑里的文件管理器：查看和编辑文件";

  constructor(
    private computer: BotComputer,
    private world: WorldAgent,
    private files: WorldFiles,
    private clock: WorldClock,
    private cfg: AppsConfig,
    private logger: Logger,
  ) {}

  async open(): Promise<{ tools: AppRawTool[]; opening?: string }> {
    const real = await this.isRealWorld();
    if (real) {
      const ready = await this.computer.ensureReady();
      if (ready.ok) {
        return {
          tools: TOOLS,
          opening: `你坐到电脑前，点开了文件资源管理器，窗口里是这台电脑 ${this.displayPath(".") === "." ? "主目录" : `的 ${this.displayPath(".")} 目录`} 的文件。`,
        };
      }
      return {
        tools: TOOLS,
        opening: `你坐到电脑前想打开文件资源管理器，但电脑没有开机（${ready.error}）。`,
      };
    }
    return {
      tools: TOOLS,
      opening: "你坐到电脑前，点开了文件资源管理器，窗口里是这台电脑的文件。",
    };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const real = await this.isRealWorld();
    switch (tool) {
      case "list":
        return real ? this.list(args) : this.virtualList(args);
      case "show":
        return real ? this.show(args) : this.virtualShow(args);
      case "write":
        return real ? this.write(args) : this.virtualWrite(args, "write");
      case "patch":
        return real ? this.patch(args) : this.virtualWrite(args, "patch");
      case "mkdir":
        return real ? this.mkdir(args) : this.virtualWrite(args, "mkdir");
      case "delete":
        return real ? this.remove(args) : this.virtualWrite(args, "delete");
      default:
        throw new Error(`资源管理器没有 ${tool} 这个操作`);
    }
  }

  async close(): Promise<void> {
    /* 本地资源管理器没有连接需要释放 */
  }

  // ---------- 路径安全（现实模式） ----------

  private rootPath(): string {
    return path.resolve(this.computer.homeDir, this.cfg.filesCwd || ".");
  }

  private displayPath(target: string): string {
    const rel = path.relative(this.rootPath(), target);
    if (!rel) return ".";
    return rel.split(path.sep).join("/");
  }

  private resolveLexical(raw: unknown): string {
    const root = this.rootPath();
    const input = raw == null ? "." : String(raw).trim();
    const target = path.resolve(root, input || ".");
    if (!isInside(root, target)) {
      throw new Error(`路径超出资源管理器所在目录：${this.displayPath(target)}`);
    }
    return target;
  }

  /** 确认路径存在且（经符号链接解析后）仍在工作目录内 */
  private async resolveExisting(raw: unknown): Promise<string> {
    const target = this.resolveLexical(raw);
    const root = this.rootPath();
    const ex = await this.nodeOp("exists", { YR_P: target });
    if (!ex.ok) throw new Error(`文件系统操作失败：${ex.error}`);
    if (!ex.data) throw new Error(`文件不存在：${this.displayPath(target)}`);
    const rp = await this.nodeOp("realpath", { YR_P: target });
    if (!rp.ok) throw new Error(`文件系统操作失败：${rp.error}`);
    if (!isInside(root, rp.data as string)) {
      throw new Error(`路径指向资源管理器所在目录外：${this.displayPath(target)}`);
    }
    return target;
  }

  /** 确认路径可写（父目录可建、目标及父目录解析后都在工作目录内） */
  private async resolveWritable(raw: unknown): Promise<string> {
    const target = this.resolveLexical(raw);
    const root = this.rootPath();
    const parent = path.dirname(target);
    const mk = await this.nodeOp("mkdir", { YR_P: parent });
    if (!mk.ok) throw new Error(`无法创建父目录：${mk.error}`);
    const rpDir = await this.nodeOp("realpath", { YR_P: parent });
    if (!rpDir.ok) throw new Error(`文件系统操作失败：${rpDir.error}`);
    if (!isInside(root, rpDir.data as string)) {
      throw new Error(`路径指向资源管理器所在目录外：${this.displayPath(target)}`);
    }
    const ex = await this.nodeOp("exists", { YR_P: target });
    if (ex.ok && ex.data) {
      const rpT = await this.nodeOp("realpath", { YR_P: target });
      if (rpT.ok && !isInside(root, rpT.data as string)) {
        throw new Error(`路径指向资源管理器所在目录外：${this.displayPath(target)}`);
      }
    }
    return target;
  }

  // ---------- 工具实现（现实模式：执行在这台电脑里） ----------

  private async list(args: Record<string, unknown>): Promise<string> {
    const target = await this.resolveExisting(args.path);
    const res = await this.nodeOp("list", { YR_P: target });
    if (!res.ok) return `（读取失败：${res.error}）`;
    const entries = (res.data as [string, string, string][]).map(([name, kind, detail]) => ({ name, kind, detail }));
    const rows: { name: string; kind: "dir" | "file" | "link"; detail: string }[] = [];
    for (const e of entries) {
      if (e.kind === "dir") rows.push({ name: `${e.name}/`, kind: "dir", detail: "" });
      else if (e.kind === "link") rows.push({ name: `${e.name} ->`, kind: "link", detail: e.detail });
      else rows.push({ name: e.name, kind: "file", detail: e.detail ? formatSize(Number(e.detail)) : "" });
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
    const st = await this.nodeOp("stat", { YR_P: target });
    if (!st.ok) return `（读取失败：${st.error}）`;
    if ((st.data as { dir?: boolean } | undefined)?.dir) return `（${this.displayPath(target)} 是目录，请用 list 查看。）`;
    const start = clampInt(args.start, 1, Number.MAX_SAFE_INTEGER, 1);
    const maxLines = clampInt(
      args.max_lines ?? args.maxLines,
      1,
      MAX_SHOW_LINES,
      DEFAULT_SHOW_LINES,
    );
    const res = await this.nodeOp("read-lines", {
      YR_P: target,
      YR_START: String(start),
      YR_MAX: String(maxLines),
    });
    if (!res.ok) return `（读取失败：${res.error}）`;
    const { total, window } = res.data as { total: number; window: string[] };
    const end = Math.min(total, start - 1 + maxLines);
    const width = String(end).length;
    const bodyLines: string[] = [];
    for (let i = 0; i < window.length; i++) {
      bodyLines.push(`${String(start + i).padStart(width)}| ${window[i] ?? ""}`);
    }
    const fullBody = bodyLines.join("\n");
    const body =
      fullBody.length > MAX_TEXT_CHARS
        ? `${fullBody.slice(0, MAX_TEXT_CHARS)}\n…（已截断，剩余 ${fullBody.length - MAX_TEXT_CHARS} 字符）`
        : fullBody;
    const remaining =
      total > end ? `\n----\n（还有 ${total - end} 行；可用 start/max_lines 继续查看）` : "";
    return `${this.displayPath(target)} (${total} 行)\n----\n${body}${remaining}${READ_ONLY_HINT}`;
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
    const res = await this.nodeOp("write", {
      YR_P: target,
      YR_DATA: content,
      YR_APPEND: isTruthy(args.append) ? "1" : "0",
    });
    if (!res.ok) return `（写入失败：${res.error}）`;
    return `已写入 ${this.displayPath(target)}（${content.length} 字符）。`;
  }

  private async mkdir(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path ?? args.dir;
    if (rawPath == null || !String(rawPath).trim()) return "（mkdir 需要 path 参数。）";
    const target = await this.resolveWritable(rawPath);
    const res = await this.nodeOp("mkdir", { YR_P: target });
    if (!res.ok) return `（创建失败：${res.error}）`;
    return `已创建目录 ${this.displayPath(target)}。`;
  }

  private async remove(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path ?? args.file;
    if (rawPath == null || !String(rawPath).trim()) return "（delete 需要 path 参数。）";
    const target = await this.resolveExisting(rawPath);
    if (isRootPath(this.rootPath(), target)) {
      return "（不能删除资源管理器所在目录本身。）";
    }
    const recursive = isTruthy(args.recursive);
    const res = await this.nodeOp("delete", { YR_P: target, YR_REC: recursive ? "1" : "0" });
    if (!res.ok) return `（删除失败：${res.error}）`;
    if ((res.data as { needRecursive?: boolean } | undefined)?.needRecursive) {
      return `（${this.displayPath(target)} 是目录；如确认删除整棵树，请传 recursive: true。）`;
    }
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
          const ex = await this.nodeOp("exists", { YR_P: target });
          if (ex.ok && ex.data) {
            throw new Error(`Add File 目标已存在：${this.displayPath(target)}，请改用 Update File`);
          }
          prepared.push({ op, target, content: addFileLines(op.lines).join("\n") });
          break;
        }
        case "update": {
          const target = await this.resolveExisting(op.path);
          const read = await this.nodeOp("read-raw", { YR_P: target });
          if (!read.ok) throw new Error(`读取 ${this.displayPath(target)} 失败：${read.error}`);
          const before = read.data as string;
          const hadBom = before.startsWith("\uFEFF");
          const after = applyPatchHunks(before.replace(/^\uFEFF/, ""), parseUpdateHunks(op.lines));
          prepared.push({ op, target, content: hadBom ? `\uFEFF${after}` : after });
          break;
        }
        case "delete": {
          const target = await this.resolveExisting(op.path);
          if (isRootPath(this.rootPath(), target)) {
            throw new Error("Delete File 不能删除资源管理器所在目录本身");
          }
          const st = await this.nodeOp("stat", { YR_P: target });
          if (st.ok && (st.data as { dir?: boolean } | undefined)?.dir) {
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
        case "update": {
          const res = await this.nodeOp("write", {
            YR_P: item.target,
            YR_DATA: item.content ?? "",
            YR_APPEND: "0",
          });
          if (!res.ok) throw new Error(`写入 ${label} 失败：${res.error}`);
          applied.push(`${item.op.type === "add" ? "新增" : "更新"} ${label}`);
          break;
        }
        case "delete": {
          const res = await this.nodeOp("delete", { YR_P: item.target, YR_REC: "0" });
          if (!res.ok) throw new Error(`删除 ${label} 失败：${res.error}`);
          applied.push(`删除 ${label}`);
          break;
        }
      }
    }
    return `已应用 patch：\n- ${applied.join("\n- ")}`;
  }

  // ---------- 电脑文件系统操作（docker exec node -e） ----------

  private async nodeOp(op: string, vars: Record<string, string>): Promise<FsResult> {
    // 脚本经环境变量传入（YR_SCRIPT），避免把代码嵌入 shell 命令造成引号/转义问题
    const res = await this.computer.exec('node -e "$YR_SCRIPT" 2>/dev/null', {
      timeoutMs: this.cfg.computer.commandTimeoutMs,
      maxOutputChars: 1_000_000,
      cwd: undefined,
      env: { YR_SCRIPT: NODE_FS_SCRIPT, YR_OP: op, ...vars },
    });
    const text = res.output.trim();
    try {
      const parsed = JSON.parse(text) as { ok?: boolean; d?: unknown; error?: string };
      if (parsed.ok) return { ok: true, data: parsed.d };
      return { ok: false, error: parsed.error || "未知错误" };
    } catch {
      return { ok: false, error: text || "电脑没有响应" };
    }
  }

  // ---------- 虚构模式：World-LLM 扮演这台电脑 ----------

  private async virtualList(args: Record<string, unknown>): Promise<string> {
    const where = args.path != null && String(args.path).trim() ? `目录 ${String(args.path).trim()}` : "当前目录";
    const task =
      `Bot 打开了自己电脑上的文件资源管理器，查看${where}（当前 ${this.clock.timeLine()}）。\n` +
      `请扮演这台电脑，输出资源管理器窗口里显示的目录内容：\n` +
      `1. check world_status（必要时也看 bot_status）：这台电脑符合世界观；如果这个世界没有电脑，或该路径不存在，就如实显示空白或对应的报错/空目录；\n` +
      `2. 一行一个条目，目录以 / 结尾，文件可附大小；最多列 ${MAX_LIST_ITEMS} 条；与世界状态中已有的设定保持一致，不要凭空出现这个世界不该有的文件；\n` +
      `3. 只输出资源管理器屏幕上的内容，不要任何解释、旁白或代码围栏。`;
    try {
      return await this.world.query(task);
    } catch (err) {
      this.logger.warn("虚构资源管理器目录生成失败: %s", err);
      return "（资源管理器好像卡住了，窗口里什么都没有。）";
    }
  }

  private async virtualShow(args: Record<string, unknown>): Promise<string> {
    const file = String(args.path ?? args.file ?? "");
    if (!file.trim()) return "（show 需要 path 参数。）";
    const task =
      `Bot 在自己电脑上的资源管理器里打开了文件 ${file.trim()}（当前 ${this.clock.timeLine()}）。\n` +
      `请扮演这台电脑，输出文件在屏幕上显示的内容：\n` +
      `1. check world_status：文件内容必须符合世界观；文件不存在或不是文本时，如实输出对应的画面（文件不存在/打不开）；\n` +
      `2. 这是只读查看，内容会显示行号；输出文件内容本身（带行号），不要太长；\n` +
      `3. 只输出屏幕上显示的内容，不要解释或旁白。`;
    try {
      return (await this.world.query(task)) + READ_ONLY_HINT;
    } catch (err) {
      this.logger.warn("虚构资源管理器文件内容生成失败: %s", err);
      return "（文件打不开，窗口里什么都没有。）" + READ_ONLY_HINT;
    }
  }

  private async virtualWrite(args: Record<string, unknown>, action: string): Promise<string> {
    const rawPath = args.path ?? args.file ?? args.patch;
    const what = String(rawPath ?? "").trim() || "目标文件";
    const actText =
      action === "write"
        ? `写入/修改文件 ${what}`
        : action === "patch"
          ? `对文件 ${what} 应用补丁`
          : action === "mkdir"
            ? `新建目录 ${what}`
            : `删除 ${what}`;
    const task =
      `Bot 在自己电脑上的资源管理器里执行了「${actText}」（当前 ${this.clock.timeLine()}）。\n` +
      `请扮演这台电脑，用一两句符合世界观的话描述屏幕上反馈的结果（成功/失败/权限不足等）：\n` +
      `1. check world_status 保持设定一致（这个世界有没有电脑、这个目录/文件是否应该存在、Bot 有没有权限）；\n` +
      `2. 只输出屏幕上显示的内容，不要解释或旁白。`;
    try {
      return await this.world.query(task);
    } catch (err) {
      this.logger.warn("虚构资源管理器操作结果生成失败: %s", err);
      return "（资源管理器好像没有反应。）";
    }
  }

  private async isRealWorld(): Promise<boolean> {
    const meta = await this.files.readMeta();
    return meta.realWorld ?? this.clock.syncRealTime;
  }
}

/** 电脑内执行的文件系统操作（node -e 运行的固定脚本，路径/内容经环境变量传入避免转义） */
const NODE_FS_SCRIPT = `
const fs=require('fs'),path=require('path');
const op=process.env.YR_OP||'';
const P=process.env.YR_P||'';
const send=(d)=>console.log(JSON.stringify({ok:true,d}));
try{
  if(op==='list'){
    const es=fs.readdirSync(P,{withFileTypes:true});
    const rows=[];
    for(const e of es){
      let kind='file',detail='';
      try{
        const s=fs.lstatSync(path.join(P,e.name));
        if(s.isDirectory())kind='dir';
        else if(s.isSymbolicLink()){kind='link';detail='符号链接';}
        else detail=String(s.size);
      }catch(_){kind='link';detail='符号链接';}
      rows.push([e.name,kind,detail]);
    }
    send(rows);
  } else if(op==='read-lines'){
    const s=fs.readFileSync(P,'utf8');
    const lines=s.replace(/^\\uFEFF/,'').split(/\\r?\\n/);
    const start=Number(process.env.YR_START||1),max=Number(process.env.YR_MAX||1000000);
    send({total:lines.length,window:lines.slice(start-1,start-1+max)});
  } else if(op==='read-raw'){
    send(fs.readFileSync(P,'utf8'));
  } else if(op==='stat'){
    const s=fs.lstatSync(P);
    send({dir:s.isDirectory(),size:s.size});
  } else if(op==='exists'){
    fs.accessSync(P);
    send(true);
  } else if(op==='realpath'){
    send(fs.realpathSync(P));
  } else if(op==='write'){
    const data=process.env.YR_DATA||'';
    fs.mkdirSync(path.dirname(P),{recursive:true});
    if(process.env.YR_APPEND==='1')fs.appendFileSync(P,data);else fs.writeFileSync(P,data);
    send(true);
  } else if(op==='mkdir'){
    fs.mkdirSync(P,{recursive:true});
    send(true);
  } else if(op==='delete'){
    const s=fs.lstatSync(P);
    if(s.isDirectory()&&process.env.YR_REC!=='1'){send({needRecursive:true});}
    else{fs.rmSync(P,{recursive:process.env.YR_REC==='1',force:false});send(true);}
  } else {
    send({error:"unknown op "+op});
  }
}catch(e){console.log(JSON.stringify({ok:false,error:(e&&e.message)?e.message:String(e)}));}
`;

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
