/**
 * 内置记事本 App。
 *
 * Bot 的私人笔记：备忘、值得注意的事、对群友的印象、日记……
 * 与压缩沉淀的长期记忆互补——记事本是 Bot **主动**写下、随时可翻的持久记录，
 * 不受上下文压缩影响。
 *
 * 存储：世界数据目录的 Notes/ 文件夹，一篇笔记一个 Markdown 文件，**文件名即标题**。
 * 用户可以直接打开文件夹翻看/编辑，也可以自己丢 .md 进去（Bot 同样能看到）。
 * 世界时间戳记录在文件头部的 frontmatter 里；创世重置时整个文件夹随其他状态归档。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import type { WorldFiles } from "../files.js";
import type { AppRawTool, WorldApp } from "./app.js";

/** 单条笔记的内容上限（防止 Bot 无限往一条日记里追加，最终撑爆上下文） */
const MAX_NOTE_CHARS = 20_000;
const PREVIEW_CHARS = 40;
/** 文件名（标题）长度上限 */
const MAX_TITLE_CHARS = 60;

interface NoteMeta {
  created?: string;
  updated?: string;
  /** 用于排序的世界时刻（从 frontmatter 的 T=xx 解析；没有则退回文件 mtime 的负数区分） */
  sortKey: number;
}

interface NoteFile {
  title: string;
  file: string;
  meta: NoteMeta;
  content: string;
}

export class NotesApp implements WorldApp {
  readonly id = "notes";
  readonly name = "记事本";
  readonly description = "你的私人笔记：备忘、值得注意的事、对人的印象、日记，随时翻看";

  constructor(
    private files: WorldFiles,
    private clock: WorldClock,
    private logger: Logger,
  ) {}

  async open(): Promise<{ tools: AppRawTool[]; opening: string }> {
    const notes = await this.loadAll();
    const recent = notes
      .slice(0, 5)
      .map((n) => `- 「${n.title}」${n.meta.updated ? `（更新于 ${n.meta.updated}）` : ""}`);
    const opening = notes.length
      ? `你打开了记事本，里面有 ${notes.length} 篇笔记。最近更新：\n${recent.join("\n")}`
      : "你打开了记事本，里面还是空的。值得记住的事、备忘、对人的印象、日记，都可以随手记下来。";
    return {
      tools: [
        {
          name: "list_notes",
          description: "列出记事本里的全部笔记（标题、更新时间与开头预览）",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "view_note",
          description: "翻开一篇笔记查看全文",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string", description: "笔记标题" } },
            required: ["title"],
          },
        },
        {
          name: "write_note",
          description:
            "写一篇新笔记。title 是标题（也是它的名字，如「群友印象」「8月6日 日记」），content 是正文（Markdown）",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "标题" },
              content: { type: "string", description: "正文" },
            },
            required: ["title", "content"],
          },
        },
        {
          name: "edit_note",
          description:
            "修改一篇笔记：给 content 时默认整体覆盖正文；append: true 表示把 content 追加到末尾（适合日记连载/补充印象）；给 new_title 时重命名",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "要修改的笔记标题" },
              content: { type: "string", description: "新正文（或要追加的内容）" },
              append: { type: "boolean", description: "true = 追加到末尾而不是覆盖" },
              new_title: { type: "string", description: "新标题（重命名）" },
            },
            required: ["title"],
          },
        },
        {
          name: "delete_note",
          description: "撕掉一篇不再需要的笔记（不可恢复）",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string", description: "笔记标题" } },
            required: ["title"],
          },
        },
      ],
      opening,
    };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case "list_notes":
        return this.listNotes();
      case "view_note":
        return this.viewNote(args);
      case "write_note":
        return this.writeNote(args);
      case "edit_note":
        return this.editNote(args);
      case "delete_note":
        return this.deleteNote(args);
      default:
        throw new Error(`记事本没有 ${tool} 这个操作`);
    }
  }

  async close(): Promise<void> {
    /* 无连接可释放 */
  }

  // ---------- 操作 ----------

  private async listNotes(): Promise<string> {
    const notes = await this.loadAll();
    if (!notes.length) {
      return "记事本还是空的。（用 write_note 记下第一篇吧）";
    }
    const lines = notes.map(
      (n) =>
        `「${n.title}」${n.meta.updated ? ` [更新于 ${n.meta.updated}]` : ""} ${preview(n.content)}`,
    );
    return `你的笔记（${notes.length} 篇，按最近更新排序）：\n${lines.join("\n")}`;
  }

  private async viewNote(args: Record<string, unknown>): Promise<string> {
    const note = await this.find(args.title);
    if (!note) return this.notFound(args.title);
    const when =
      note.meta.created || note.meta.updated
        ? `（${[
            note.meta.created ? `写于 ${note.meta.created}` : "",
            note.meta.updated && note.meta.updated !== note.meta.created
              ? `最后更新于 ${note.meta.updated}`
              : "",
          ]
            .filter(Boolean)
            .join("，")}）\n`
        : "";
    return `「${note.title}」\n${when}\n${note.content}`;
  }

  private async writeNote(args: Record<string, unknown>): Promise<string> {
    const title = sanitizeTitle(String(args.title ?? ""));
    if (!title) return "（标题不能为空，也不能全是特殊字符。）";
    const content = String(args.content ?? "").trim();
    if (!content) return "（正文是空的，没有记下。）";
    if (content.length > MAX_NOTE_CHARS) {
      return `（这篇笔记太长了（${content.length} 字符，上限 ${MAX_NOTE_CHARS}），精简一下再记。）`;
    }
    const file = this.fileOf(title);
    if (await exists(file)) {
      return `（已经有一篇叫「${title}」的笔记了。换个标题，或者用 edit_note 修改它。）`;
    }
    const now = this.stamp();
    await this.save(file, { created: now, updated: now }, content);
    return `已记下「${title}」。`;
  }

  private async editNote(args: Record<string, unknown>): Promise<string> {
    const note = await this.find(args.title);
    if (!note) return this.notFound(args.title);

    const newTitle = args.new_title != null ? sanitizeTitle(String(args.new_title)) : "";
    const content = args.content != null ? String(args.content) : "";
    const append = args.append === true || args.append === "true";
    if (!newTitle && !content.trim()) {
      return "（没有给出要修改的内容：content 改正文（append: true 为追加），new_title 重命名。）";
    }

    const changes: string[] = [];
    let body = note.content;
    if (content.trim()) {
      body = append ? `${note.content}\n\n${content.trim()}` : content.trim();
      if (body.length > MAX_NOTE_CHARS) {
        return `（改完会有 ${body.length} 字符，超过单篇上限 ${MAX_NOTE_CHARS}。删减些旧内容，或另起一篇新笔记。）`;
      }
      changes.push(append ? "正文（已追加）" : "正文（已覆盖）");
    }

    let file = note.file;
    let title = note.title;
    if (newTitle && newTitle !== note.title) {
      const dest = this.fileOf(newTitle);
      if (await exists(dest)) {
        return `（已经有一篇叫「${newTitle}」的笔记了，不能重名。）`;
      }
      await fs.rename(note.file, dest);
      file = dest;
      title = newTitle;
      changes.push(`标题（原「${note.title}」）`);
    }

    await this.save(file, { created: note.meta.created, updated: this.stamp() }, body);
    return `「${title}」已更新：${changes.join("、")}。`;
  }

  private async deleteNote(args: Record<string, unknown>): Promise<string> {
    const note = await this.find(args.title);
    if (!note) return this.notFound(args.title);
    await fs.rm(note.file, { force: true });
    return `「${note.title}」已删除。`;
  }

  // ---------- 存取 ----------

  private fileOf(title: string): string {
    return path.join(this.files.notesDir, `${title}.md`);
  }

  private stamp(): string {
    const t = this.clock.now();
    return `${this.clock.clockString(t)}（T=${t.toFixed(1)}）`;
  }

  /** 读取全部笔记，按最近更新排序（frontmatter 的 T 优先，用户手动放入的文件退回 mtime） */
  private async loadAll(): Promise<NoteFile[]> {
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(this.files.notesDir)).filter((f) => f.toLowerCase().endsWith(".md"));
    } catch {
      return [];
    }
    const notes: NoteFile[] = [];
    for (const name of entries) {
      const file = path.join(this.files.notesDir, name);
      try {
        const raw = await fs.readFile(file, "utf8");
        const { meta, content } = parseNote(raw);
        if (meta.sortKey < 0) {
          // frontmatter 里没有世界时刻（用户手动放入的文件）：用 mtime 排序，但排在有 T 的笔记之后
          const stat = await fs.stat(file).catch(() => null);
          meta.sortKey = stat ? -1 / Math.max(1, stat.mtimeMs) : -1;
        }
        notes.push({ title: name.replace(/\.md$/i, ""), file, meta, content });
      } catch (err) {
        this.logger.warn("笔记读取失败（%s）: %s", name, err);
      }
    }
    return notes.sort((a, b) => b.meta.sortKey - a.meta.sortKey);
  }

  /** 按标题找笔记（精确匹配优先，容忍大小写与首尾空白差异） */
  private async find(rawTitle: unknown): Promise<NoteFile | null> {
    const title = String(rawTitle ?? "").trim();
    if (!title) return null;
    const notes = await this.loadAll();
    return (
      notes.find((n) => n.title === title) ??
      notes.find((n) => n.title.toLowerCase() === title.toLowerCase()) ??
      null
    );
  }

  private async save(file: string, meta: { created?: string; updated?: string }, content: string): Promise<void> {
    const fm =
      `---\n` +
      (meta.created ? `created: ${meta.created}\n` : "") +
      (meta.updated ? `updated: ${meta.updated}\n` : "") +
      `---\n\n`;
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, fm + content + "\n");
    await fs.rename(tmp, file);
  }

  private async notFound(rawTitle: unknown): Promise<string> {
    const notes = await this.loadAll();
    const hint = notes.length
      ? `现有的笔记：${notes.map((n) => `「${n.title}」`).join("、")}`
      : "记事本还是空的";
    return `（记事本里没有叫「${String(rawTitle ?? "?")}」的笔记。${hint}。）`;
  }
}

/** 标题 → 安全的文件名：去掉路径分隔与文件系统非法字符，限长 */
function sanitizeTitle(raw: string): string {
  return raw
    .trim()
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_TITLE_CHARS)
    .replace(/^[\s.]+/, "") // 最后去前导点/空白：防止隐藏文件与相对路径伪装
    .trim();
}

/** 解析笔记文件：frontmatter（可选）→ 元数据 + 正文 */
function parseNote(raw: string): { meta: NoteMeta; content: string } {
  const meta: NoteMeta = { sortKey: -1 };
  let content = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    content = raw.slice(m[0].length);
    for (const line of m[1]!.split("\n")) {
      const kv = line.match(/^(created|updated):\s*(.+)$/);
      if (kv) meta[kv[1] as "created" | "updated"] = kv[2]!.trim();
    }
    const t = meta.updated?.match(/T=([\d.]+)/) ?? meta.created?.match(/T=([\d.]+)/);
    if (t) meta.sortKey = Number(t[1]);
  }
  return { meta, content: content.trim() };
}

function preview(content: string): string {
  const single = content.replace(/\s+/g, " ").trim();
  return single.length > PREVIEW_CHARS ? single.slice(0, PREVIEW_CHARS) + "…" : single;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
