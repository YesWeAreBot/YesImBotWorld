/**
 * 内置记事本 App。
 *
 * 自由文本工作本：剪贴板、作业、账本、待办清单、备忘与日记……
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
  readonly description = "自由文本工作本：剪贴板、作业、账本、待办清单、备忘和日记，可搜索、精确修改与勾选";
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private generation = 0;
  private closing: Promise<void> = Promise.resolve();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private files: WorldFiles,
    private clock: WorldClock,
    private logger: Logger,
  ) {}

  async open(): Promise<{ tools: AppRawTool[]; opening: string }> {
    const generation = this.generation;
    await this.closing;
    if (generation !== this.generation) throw new Error("记事本的打开操作已取消，请重新打开应用。");
    this.closed = false;
    return this.track(() => this.openNotebook());
  }

  private async openNotebook(): Promise<{ tools: AppRawTool[]; opening: string }> {
    const notes = await this.loadAll();
    const recent = notes
      .slice(0, 5)
      .map((n) => `- 「${n.title}」（更新于 ${noteTimeText(n.updated)}）`);
    const opening = notes.length
      ? `你打开了记事本，里面有 ${notes.length} 篇笔记。最近更新：\n${recent.join("\n")}`
      : "记事本还是空的。";
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
            "写一篇新的自由文本笔记。title 是标题（如「剪贴板」「作业草稿」「本月账本」「采购清单」），content 是 Markdown 正文；待办可写成 - [ ] 项目，不需要固定表格或分类。",
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
            "修改一篇笔记：给 content 时默认整体覆盖正文；append: true 表示把 content 追加到末尾（适合追加账目、剪贴内容、作业或日记）；给 new_title 时重命名。局部修改可用 replace_note_text。",
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
          name: "search_notes",
          description: "按普通文字搜索标题和正文，不使用正则。返回命中片段、创建和编辑时间；默认忽略英文大小写，按最近编辑倒序。",
          inputSchema: { type: "object", properties: {
            query: { type: "string", description: "搜索文字，不能为空" },
            case_sensitive: { type: "boolean", default: false },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          }, required: ["query"] },
        },
        {
          name: "replace_note_text",
          description: "在一篇笔记中精确替换原文，不使用正则。find 必须与原文完全一致；多处匹配时默认拒绝，确认全改才设 all:true。replace 可以为空以删除该片段；保留其余正文及创建时间。",
          inputSchema: { type: "object", properties: {
            title: { type: "string" }, find: { type: "string", description: "非空原文" },
            replace: { type: "string", description: "替换为的文字，可以为空" }, all: { type: "boolean", default: false },
          }, required: ["title", "find", "replace"] },
        },
        {
          name: "check_note_item",
          description: "勾选或取消勾选一条 Markdown 清单项（- [ ] / - [x]）。item 为方框后的完整文字；有重名时必须给 occurrence（从 1 起）明确第几项。只改方框，不改项目文字。",
          inputSchema: { type: "object", properties: {
            title: { type: "string" }, item: { type: "string" }, checked: { type: "boolean" },
            occurrence: { type: "integer", minimum: 1 },
          }, required: ["title", "item", "checked"] },
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
    return this.track(() => this.callOpen(tool, args));
  }

  private async callOpen(tool: string, args: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case "list_notes":
        return this.listNotes(args);
      case "view_note":
        return this.viewNote(args);
      case "write_note":
        return this.writeNote(args);
      case "edit_note":
        return this.editNote(args);
      case "search_notes":
        return this.searchNotes(args);
      case "replace_note_text":
        return this.replaceNoteText(args);
      case "check_note_item":
        return this.checkNoteItem(args);
      case "delete_note":
        return this.deleteNote(args);
      default:
        throw new Error(`记事本没有 ${tool} 这个操作`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation++;
    // Tool cancellation may stop its caller waiting before local disk IO has
    // finished. Join accepted operations before reset archives/removes Notes.
    this.closing = Promise.allSettled([...this.pending]).then(() => {});
    await this.closing;
  }

  private async track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("记事本已关闭，请重新打开应用后操作。");
    // Serialise read-modify-write operations so two accepted app calls cannot
    // silently lose an append, exact replacement or checklist update.
    const task = this.operationTail.then(operation);
    this.operationTail = task.then(() => {}, () => {});
    this.pending.add(task);
    try { return await task; }
    finally { this.pending.delete(task); }
  }

  // ---------- 操作 ----------

  private async listNotes(args: Record<string, unknown>): Promise<string> {
    if (args.sort != null && args.sort !== "updated" && args.sort !== "created") throw new Error("sort 须为 updated 或 created");
    const order = args.sort === "created" ? "created" : "updated";
    const notes = (await this.loadAll()).sort((a, b) => compareNotes(a, b, order));
    if (!notes.length) {
      return "记事本还是空的。";
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

  private async searchNotes(args: Record<string, unknown>): Promise<string> {
    if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query 须为非空搜索文字");
    if (args.case_sensitive != null && typeof args.case_sensitive !== "boolean") throw new Error("case_sensitive 须为布尔值");
    const limit = args.limit ?? 20;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit 须为 1 至 50 的整数");
    const normalize = (text: string) => args.case_sensitive === true ? text : text.toLowerCase();
    const query = normalize(args.query);
    const hits = (await this.loadAll()).filter(note => normalize(note.title).includes(query) || normalize(note.content).includes(query));
    if (!hits.length) return `没有找到包含「${args.query}」的笔记。`;
    return `找到 ${hits.length} 篇笔记，显示前 ${Math.min(limit, hits.length)} 篇（最近编辑倒序）：\n` + hits.slice(0, limit).map(note => {
      const index = normalize(note.content).indexOf(query);
      const start = Math.max(0, index - 50), end = Math.min(note.content.length, Math.max(index, 0) + query.length + 100);
      const snippet = `${start ? "…" : ""}${note.content.slice(start, end)}${end < note.content.length ? "…" : ""}`;
      return `「${note.title}」[创建 ${noteTimeText(note.created)}；最近编辑 ${noteTimeText(note.updated)}]\n${snippet}`;
    }).join("\n\n");
  }

  private async replaceNoteText(args: Record<string, unknown>): Promise<string> {
    if (typeof args.find !== "string" || !args.find) throw new Error("find 须为非空原文");
    if (typeof args.replace !== "string") throw new Error("replace 须为文字，可以为空");
    if (args.all != null && typeof args.all !== "boolean") throw new Error("all 须为布尔值");
    const note = await this.find(args.title);
    if (!note) return this.notFound(args.title);
    const pieces = note.content.split(args.find), count = pieces.length - 1;
    if (!count) return "（未找到完全匹配的原文，笔记未改变。请先查看笔记再复制要修改的片段。）";
    if (count > 1 && args.all !== true) return `（原文出现 ${count} 次，笔记未改变。请扩大 find 使其唯一，或用 all:true 确认全部替换。）`;
    const content = pieces.join(args.replace);
    if (content === note.content) return `「${note.title}」的内容已符合要求，无需修改。`;
    if (content.length > MAX_NOTE_CHARS) throw new Error(`修改后超过单篇 ${MAX_NOTE_CHARS} 字符上限，笔记未改变`);
    await saveNoteFile(note.file, content, note.created, noteStamp(this.clock));
    return `「${note.title}」已精确替换 ${count} 处。`;
  }

  private async checkNoteItem(args: Record<string, unknown>): Promise<string> {
    if (typeof args.item !== "string" || !args.item.trim()) throw new Error("item 须为方框后的完整项目文字");
    if (typeof args.checked !== "boolean") throw new Error("checked 须为布尔值");
    if (args.occurrence != null && (typeof args.occurrence !== "number" || !Number.isInteger(args.occurrence) || args.occurrence < 1)) throw new Error("occurrence 须为从 1 起的整数");
    const note = await this.find(args.title);
    if (!note) return this.notFound(args.title);
    const matches: { offset: number; checked: string }[] = [];
    let fence: { marker: string; length: number } | null = null;
    for (const line of note.content.matchAll(/^.*$/gm)) {
      const boundary = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line[0]);
      if (boundary) {
        const marker = boundary[1]!;
        if (!fence) fence = { marker: marker[0]!, length: marker.length };
        else if (marker[0] === fence.marker && marker.length >= fence.length && !boundary[2]!.trim()) fence = null;
        continue;
      }
      if (fence) continue;
      const match = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+\[)([ xX])(\][ \t]+)(.*)$/.exec(line[0]);
      if (match && match[4]!.trim() === args.item.trim()) matches.push({ offset: line.index! + match[1]!.length, checked: match[2]! });
    }
    if (!matches.length) return "（未找到完全同名的 Markdown 清单项，笔记未改变。）";
    if (matches.length > 1 && args.occurrence == null) return `（有 ${matches.length} 条同名清单项，笔记未改变。请用 occurrence 指定从 1 起的第几项。）`;
    const match = matches[(args.occurrence as number | undefined ?? 1) - 1];
    if (!match) return `（该项目只有 ${matches.length} 条匹配，笔记未改变。）`;
    const checked = args.checked ? "x" : " ";
    if (match.checked.toLowerCase() === checked) return `「${note.title}」中的「${args.item}」已经${args.checked ? "勾选" : "取消勾选"}，无需修改。`;
    const offset = match.offset;
    const content = note.content.slice(0, offset) + checked + note.content.slice(offset + 1);
    await saveNoteFile(note.file, content, note.created, noteStamp(this.clock));
    return `已${args.checked ? "勾选" : "取消勾选"}「${note.title}」中的「${args.item}」。`;
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
