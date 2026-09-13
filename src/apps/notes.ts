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
import { compareNotes, noteStamp, noteTimeText, readNoteFile, sanitizeNoteTitle, saveNoteFile, type NoteDocument } from "../notes.js";

/** 单条笔记的内容上限（防止 Bot 无限往一条日记里追加，最终撑爆上下文） */
const MAX_NOTE_CHARS = 20_000;
const PREVIEW_CHARS = 40;

interface NoteFile extends NoteDocument {
  title: string;
  file: string;
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
      .map((n) => `- 「${n.title}」（更新于 ${noteTimeText(n.updated)}）`);
    const opening = notes.length
      ? `你打开了记事本，里面有 ${notes.length} 篇笔记。最近更新：\n${recent.join("\n")}`
      : "你打开了记事本，里面还是空的。值得记住的事、备忘、对人的印象、日记，都可以随手记下来。";
    return {
      tools: [
        {
          name: "list_notes",
          description: "列出笔记的标题、创建时间、最近编辑时间与开头预览。sort 可选 updated（最近编辑倒序，默认）或 created（创建倒序）；世界时间与仅有文件时间的笔记分别排序，不混用 TU 和现实时间。",
          inputSchema: { type: "object", properties: { sort: { type: "string", enum: ["updated", "created"], default: "updated" } } },
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
        return this.listNotes(args);
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

  private async listNotes(args: Record<string, unknown>): Promise<string> {
    if (args.sort != null && args.sort !== "updated" && args.sort !== "created") throw new Error("sort 须为 updated 或 created");
    const order = args.sort === "created" ? "created" : "updated";
    const notes = (await this.loadAll()).sort((a, b) => compareNotes(a, b, order));
    if (!notes.length) {
      return "记事本还是空的。（用 write_note 记下第一篇吧）";
    }
    const lines = notes.map(
      (n) =>
        `「${n.title}」[创建 ${noteTimeText(n.created)}；最近编辑 ${noteTimeText(n.updated)}] ${preview(n.content)}`,
    );
    return `你的笔记（${notes.length} 篇，按${order === "created" ? "创建" : "最近编辑"}时间倒序；世界时间优先，文件/现实时间另组排序）：\n${lines.join("\n")}`;
  }

  private async viewNote(args: Record<string, unknown>): Promise<string> {
    const note = await this.find(args.title);
    if (!note) return this.notFound(args.title);
    const when = `（创建 ${noteTimeText(note.created)}；最近编辑 ${noteTimeText(note.updated)}）\n`;
    return `「${note.title}」\n${when}\n${note.content}`;
  }

  private async writeNote(args: Record<string, unknown>): Promise<string> {
    const title = sanitizeNoteTitle(String(args.title ?? ""));
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
    const now = noteStamp(this.clock);
    await saveNoteFile(file, content, now, now);
    return `已记下「${title}」。`;
  }

  private async editNote(args: Record<string, unknown>): Promise<string> {
    const note = await this.find(args.title);
    if (!note) return this.notFound(args.title);

    const newTitle = args.new_title != null ? sanitizeNoteTitle(String(args.new_title)) : "";
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

    await saveNoteFile(file, body, note.created, noteStamp(this.clock));
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

  /** Share timestamp handling with the WebUI; never sort world TU against Unix milliseconds. */
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
        notes.push({ title: name.replace(/\.md$/i, ""), file, ...await readNoteFile(file) });
      } catch (err) {
        this.logger.warn("笔记读取失败（%s）: %s", name, err);
      }
    }
    return notes.sort(compareNotes);
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

  private async notFound(rawTitle: unknown): Promise<string> {
    const notes = await this.loadAll();
    const hint = notes.length
      ? `现有的笔记：${notes.map((n) => `「${n.title}」`).join("、")}`
      : "记事本还是空的";
    return `（记事本里没有叫「${String(rawTitle ?? "?")}」的笔记。${hint}。）`;
  }
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
