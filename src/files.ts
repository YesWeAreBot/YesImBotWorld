import { promises as fs } from "node:fs";
import path from "node:path";
import type { NewsEntry } from "./types.js";

/** 世界元数据（创世时由 World-LLM 判定并持久化） */
export interface WorldMeta {
  /** 世界是否是现实地球世界（决定天气应用查真实天气还是由 World-LLM 生成） */
  realWorld?: boolean;
  /** 手机屏幕分辨率（配置 apps.phoneResolution 为 auto 时创世由 World-LLM 决定） */
  phone?: { width?: number; height?: number };
  /**
   * 创世时 World-LLM 生成的浏览器带壳截图外壳（完整 HTML 文档，
   * 含 {{screen}} / {{url}} / {{title}} / {{time}} 占位符）
   */
  phoneShellHtml?: string;
}

const BOT_DEF_TEMPLATE = `# Bot 角色定义

<!-- 在这里编写你的 Bot 角色定义，然后执行 world.init 生成初始状态。 -->
<!-- 建议包含：姓名、年龄、身份、性格、说话风格、兴趣爱好、日常作息、与聊天软件的关系等。 -->

（尚未编写）
`;

const WORLD_DEF_TEMPLATE = `# 世界定义

<!-- 在这里编写虚拟世界的定义，然后执行 world.init 生成初始状态。 -->
<!-- 建议包含：世界观、地点、Bot 所处环境、周边人物、社会规则、可能发生的事件类型等。 -->

（尚未编写）
`;

/**
 * 世界数据目录管理。
 *
 * 布局：
 * ```
 * basePath/
 * ├── Bot_Definition.md    # 用户编写：Bot 角色定义
 * ├── World_Definition.md  # 用户编写：世界定义
 * ├── Bot_Status.md        # Bot-LLM 维护（压缩时更新）：Bot 当前状态
 * ├── World_Status.md      # World-LLM 维护：世界当前状态
 * ├── News.db              # World-LLM 维护：世界重大事件列表（JSONL 格式，世界中心）
 * ├── facts.jsonl          # World-LLM 维护：Bot 的小事记（JSONL 格式，Bot 中心）
 * ├── clock.json           # World Clock 状态
 * ├── meta.json            # 世界元数据（创世时判定：是否现实世界等）
 * ├── focus.json           # Bot 正在关注的频道
 * ├── pinned.json          # Bot-LLM 置顶上下文 + 计数器
 * ├── stream.jsonl         # Bot-LLM 工作窗口（Tool Call 流）
 * ├── browserCache.json    # 虚构世界浏览器页面缓存（同一网址总是呈现同一页面）
 * ├── Notes/               # Bot 的记事本：一篇笔记一个 Markdown 文件（文件名即标题）
 * ├── gallery/             # 收藏夹（分类子目录见 media/gallery.ts；描述元数据存数据库）
 * └── archive/             # 归档：压缩/重置/手动存档的历史快照（每份一个时间戳文件夹）
 * ```
 */
export class WorldFiles {
  readonly botDef: string;
  readonly worldDef: string;
  readonly botStatus: string;
  readonly worldStatus: string;
  readonly news: string;
  readonly facts: string;
  readonly clock: string;
  readonly meta: string;
  readonly focus: string;
  readonly notify: string;
  readonly pinned: string;
  readonly stream: string;
  readonly browserCache: string;
  readonly notesDir: string;
  readonly archiveDir: string;
  readonly galleryDir: string;

  constructor(readonly base: string) {
    this.botDef = path.join(base, "Bot_Definition.md");
    this.worldDef = path.join(base, "World_Definition.md");
    this.botStatus = path.join(base, "Bot_Status.md");
    this.worldStatus = path.join(base, "World_Status.md");
    this.news = path.join(base, "News.db");
    this.facts = path.join(base, "facts.jsonl");
    this.clock = path.join(base, "clock.json");
    this.meta = path.join(base, "meta.json");
    this.focus = path.join(base, "focus.json");
    this.notify = path.join(base, "notify.json");
    this.pinned = path.join(base, "pinned.json");
    this.stream = path.join(base, "stream.jsonl");
    this.browserCache = path.join(base, "browserCache.json");
    this.notesDir = path.join(base, "Notes");
    this.archiveDir = path.join(base, "archive");
    this.galleryDir = path.join(base, "gallery");
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.base, { recursive: true });
    await fs.mkdir(this.archiveDir, { recursive: true });
    await fs.mkdir(this.galleryDir, { recursive: true });
    await fs.mkdir(this.notesDir, { recursive: true });
    if (!(await this.exists(this.botDef))) await fs.writeFile(this.botDef, BOT_DEF_TEMPLATE);
    if (!(await this.exists(this.worldDef))) await fs.writeFile(this.worldDef, WORLD_DEF_TEMPLATE);
  }

  async exists(file: string): Promise<boolean> {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  async isInitialized(): Promise<boolean> {
    return (await this.exists(this.botStatus)) && (await this.exists(this.worldStatus));
  }

  async readText(file: string): Promise<string> {
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return "";
    }
  }

  async readBotStatus(): Promise<string> {
    return this.readText(this.botStatus);
  }

  async writeBotStatus(content: string): Promise<void> {
    await this.atomicWrite(this.botStatus, content);
  }

  async writeBotDef(content: string): Promise<void> {
    await this.atomicWrite(this.botDef, content);
  }

  async writeWorldDef(content: string): Promise<void> {
    await this.atomicWrite(this.worldDef, content);
  }

  async readWorldStatus(): Promise<string> {
    return this.readText(this.worldStatus);
  }

  async writeWorldStatus(content: string): Promise<void> {
    await this.atomicWrite(this.worldStatus, content);
  }

  async appendNews(entry: NewsEntry): Promise<void> {
    await fs.appendFile(this.news, JSON.stringify(entry) + "\n");
  }

  /** 读取最近 n 条世界事件 */
  async readNews(n = 10): Promise<NewsEntry[]> {
    const raw = await this.readText(this.news);
    if (!raw.trim()) return [];
    const lines = raw.trim().split("\n");
    const entries: NewsEntry[] = [];
    for (const line of lines.slice(-n)) {
      try {
        entries.push(JSON.parse(line) as NewsEntry);
      } catch {
        /* 跳过损坏行 */
      }
    }
    return entries;
  }

  /** 追加一条 Bot 的小事记（facts.jsonl，Bot 中心，供 Bot 记私事） */
  async appendFacts(entry: NewsEntry): Promise<void> {
    await fs.appendFile(this.facts, JSON.stringify(entry) + "\n");
  }

  /** 读取最近 n 条 Bot 小事记 */
  async readFacts(n = 10): Promise<NewsEntry[]> {
    const raw = await this.readText(this.facts);
    if (!raw.trim()) return [];
    const lines = raw.trim().split("\n");
    const entries: NewsEntry[] = [];
    for (const line of lines.slice(-n)) {
      try {
        entries.push(JSON.parse(line) as NewsEntry);
      } catch {
        /* 跳过损坏行 */
      }
    }
    return entries;
  }

  /** 读取全部 Bot 小事记（按文件顺序） */
  async readFactsAll(): Promise<NewsEntry[]> {
    const raw = await this.readText(this.facts);
    if (!raw.trim()) return [];
    const entries: NewsEntry[] = [];
    for (const line of raw.trim().split("\n")) {
      try {
        entries.push(JSON.parse(line) as NewsEntry);
      } catch {
        /* 跳过损坏行 */
      }
    }
    return entries;
  }

  /** 整体覆盖 facts.jsonl */
  async writeFacts(entries: NewsEntry[]): Promise<void> {
    await this.atomicWrite(this.facts, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  /** 用户固定的小事记条目（重置/创世时保留） */
  async readPinnedFacts(): Promise<NewsEntry[]> {
    return (await this.readFactsAll()).filter((e) => e.pinned);
  }

  /** 读取世界元数据（不存在时返回空对象） */
  async readMeta(): Promise<WorldMeta> {
    try {
      const parsed = JSON.parse(await this.readText(this.meta)) as WorldMeta;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  async writeMeta(meta: WorldMeta): Promise<void> {
    await this.atomicWrite(this.meta, JSON.stringify(meta));
  }

  async readDefinitions(): Promise<{ botDef: string; worldDef: string }> {
    return {
      botDef: await this.readText(this.botDef),
      worldDef: await this.readText(this.worldDef),
    };
  }

  /** 归档当前 stream 文件（压缩时调用），返回归档快照文件夹路径 */
  async archiveStream(): Promise<string | null> {
    if (!(await this.exists(this.stream))) return null;
    const dir = await this.makeArchiveDir("压缩");
    await fs.copyFile(this.stream, path.join(dir, "stream.jsonl"));
    await this.writeManifest(dir, "压缩", ["stream.jsonl"]);
    await fs.writeFile(this.stream, "");
    return dir;
  }

  /**
   * 把当前全部运行时状态复制成一份新归档快照（不动运行中的文件），
   * 返回快照文件夹名。用于重置/重新创世前的自动归档与 WebUI 手动存档。
   */
  async snapshot(label = ""): Promise<string> {
    const dir = await this.makeArchiveDir(label);
    const saved: string[] = [];
    for (const file of [
      this.botStatus,
      this.worldStatus,
      this.news,
      this.facts,
      this.pinned,
      this.stream,
      this.clock,
      this.meta,
      this.focus,
      this.notify,
    ]) {
      if (await this.exists(file)) {
        await fs.copyFile(file, path.join(dir, path.basename(file)));
        saved.push(path.basename(file));
      }
    }
    if (await this.exists(this.notesDir)) {
      await fs.cp(this.notesDir, path.join(dir, "Notes"), { recursive: true });
      saved.push("Notes/");
    }
    await this.writeManifest(dir, label, saved);
    return path.basename(dir);
  }

  /** 用一份归档快照覆盖当前运行时状态（调用方负责先自动存档/停世界） */
  async restoreFrom(snapDir: string): Promise<void> {
    for (const file of [
      this.botStatus,
      this.worldStatus,
      this.news,
      this.facts,
      this.pinned,
      this.stream,
      this.clock,
      this.meta,
      this.focus,
      this.notify,
    ]) {
      const src = path.join(snapDir, path.basename(file));
      if (await this.exists(src)) await fs.copyFile(src, file);
    }
    const notesSrc = path.join(snapDir, "Notes");
    if (await this.exists(notesSrc)) {
      await fs.rm(this.notesDir, { recursive: true, force: true });
      await fs.cp(notesSrc, this.notesDir, { recursive: true });
    }
  }

  /** 创建新的归档快照文件夹（时间戳 + 备注标签，重名时自动加序号） */
  private async makeArchiveDir(label: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safe =
      String(label || "")
        .trim()
        .replace(/[^\w\u4e00-\u9fa5.-]/g, "-")
        .slice(0, 32) || "存档";
    const base = safe ? `${stamp}-${safe}` : stamp;
    let dir = path.join(this.archiveDir, base);
    for (let i = 1; await this.exists(dir); i++) {
      dir = path.join(this.archiveDir, `${base}-${i}`);
    }
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** 在快照文件夹里写一份 manifest.json（WebUI 展示备注/文件清单用） */
  private async writeManifest(dir: string, label: string, files: string[]): Promise<void> {
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ created: Date.now(), label: String(label || "").trim(), files }),
    );
  }

  /** 重置全部运行时状态（保留用户定义文件与固定的小事记），旧状态归档 */
  async reset(): Promise<void> {
    // 固定的小事记跨越"这辈子"保留：先归档全部旧状态，再只把固定条目留回 facts.jsonl
    const pinnedFacts = await this.readPinnedFacts();
    await this.snapshot("重置");
    for (const file of [
      this.botStatus,
      this.worldStatus,
      this.news,
      this.facts,
      this.pinned,
      this.stream,
      this.clock,
      this.meta,
      this.focus,
      this.notify,
      this.browserCache,
    ]) {
      await fs.rm(file, { force: true });
    }
    // 记事本目录整体归档（"这辈子"的笔记跟着世界走）
    if (await this.exists(this.notesDir)) {
      await fs.rm(this.notesDir, { recursive: true, force: true });
    }
    if (pinnedFacts.length) await this.writeFacts(pinnedFacts);
  }

  async atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, file);
  }
}
