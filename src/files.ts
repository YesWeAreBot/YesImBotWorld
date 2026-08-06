import { promises as fs } from "node:fs";
import path from "node:path";
import type { NewsEntry } from "./types.js";

/** 世界元数据（创世时由 World-LLM 判定并持久化） */
export interface WorldMeta {
  /** 世界是否是现实地球世界（决定天气应用查真实天气还是由 World-LLM 生成） */
  realWorld?: boolean;
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
 * ├── News.db              # World-LLM 维护：世界事件列表（JSONL 格式）
 * ├── clock.json           # World Clock 状态
 * ├── meta.json            # 世界元数据（创世时判定：是否现实世界等）
 * ├── focus.json           # Bot 正在关注的频道
 * ├── pinned.json          # Bot-LLM 置顶上下文 + 计数器
 * ├── stream.jsonl         # Bot-LLM 工作窗口（Tool Call 流）
 * ├── Notes/               # Bot 的记事本：一篇笔记一个 Markdown 文件（文件名即标题）
 * ├── gallery/             # 收藏夹（分类子目录见 media/gallery.ts；描述元数据存数据库）
 * └── archive/             # 压缩时归档的历史流
 * ```
 */
export class WorldFiles {
  readonly botDef: string;
  readonly worldDef: string;
  readonly botStatus: string;
  readonly worldStatus: string;
  readonly news: string;
  readonly clock: string;
  readonly meta: string;
  readonly focus: string;
  readonly notify: string;
  readonly pinned: string;
  readonly stream: string;
  readonly notesDir: string;
  readonly archiveDir: string;
  readonly galleryDir: string;

  constructor(readonly base: string) {
    this.botDef = path.join(base, "Bot_Definition.md");
    this.worldDef = path.join(base, "World_Definition.md");
    this.botStatus = path.join(base, "Bot_Status.md");
    this.worldStatus = path.join(base, "World_Status.md");
    this.news = path.join(base, "News.db");
    this.clock = path.join(base, "clock.json");
    this.meta = path.join(base, "meta.json");
    this.focus = path.join(base, "focus.json");
    this.notify = path.join(base, "notify.json");
    this.pinned = path.join(base, "pinned.json");
    this.stream = path.join(base, "stream.jsonl");
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

  /** 归档当前 stream 文件（压缩时调用），返回归档路径 */
  async archiveStream(): Promise<string | null> {
    if (!(await this.exists(this.stream))) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(this.archiveDir, `stream-${stamp}.jsonl`);
    await fs.copyFile(this.stream, dest);
    await fs.writeFile(this.stream, "");
    return dest;
  }

  /** 重置全部运行时状态（保留用户定义文件），旧状态归档 */
  async reset(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const file of [this.botStatus, this.worldStatus, this.news, this.pinned, this.stream, this.clock, this.meta, this.focus, this.notify]) {
      if (await this.exists(file)) {
        const dest = path.join(this.archiveDir, `${stamp}-${path.basename(file)}`);
        await fs.rename(file, dest).catch(() => fs.rm(file, { force: true }));
      }
    }
    // 记事本目录整体归档（"这辈子"的笔记跟着世界走）
    if (await this.exists(this.notesDir)) {
      await fs
        .rename(this.notesDir, path.join(this.archiveDir, `${stamp}-Notes`))
        .catch(() => fs.rm(this.notesDir, { recursive: true, force: true }));
    }
  }

  async atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, file);
  }
}
