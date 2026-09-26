import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Context } from "koishi";

declare module "koishi" {
  interface Tables {
    yesimbot_world_gallery: WorldGalleryRow;
  }
}

/** 收藏夹条目的元数据（备注由角色自愿记录，供自己日后选用，不是媒体识别结果） */
export interface WorldGalleryRow {
  id: number;
  /** 分类（= gallery 下的子目录名） */
  category: string;
  /** 分类目录内的文件名 */
  name: string;
  /** 文件内容哈希：用户手动移动/改名文件后靠它找回描述 */
  sha256: string;
  /** 角色自己的选用备注；不代表原作者/发送者的情绪或意图 */
  description: string;
  createdAt: Date;
}

/** 四大分类：Bot 保存/整理图片时必须选择其一 */
export const MAIN_CATEGORIES = ["表情包", "meme", "截图", "照片"] as const;
/** 表情包分类：此分类下的图片发送时应作为平台表情（而非普通图片）呈现 */
export const STICKER_CATEGORY: string = MAIN_CATEGORIES[0];
/** 暂未分类的存放位置，不构成必须完成的整理任务 */
export const UNSORTED_CATEGORY = "未整理";
export const ALL_CATEGORIES: readonly string[] = [...MAIN_CATEGORIES, UNSORTED_CATEGORY];

/** 宽松匹配分类名（容忍大小写与首尾空白），无法识别返回 null */
export function normalizeCategory(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  for (const c of ALL_CATEGORIES) {
    if (c === t || c.toLowerCase() === t.toLowerCase()) return c;
  }
  // 常见近义写法
  if (["未分类", "待整理", "inbox", "unsorted"].includes(t.toLowerCase())) return UNSORTED_CATEGORY;
  if (["表情", "sticker", "stickers"].includes(t.toLowerCase())) return "表情包";
  if (["梗图", "梗"].includes(t)) return "meme";
  if (["screenshot", "screenshots"].includes(t.toLowerCase())) return "截图";
  if (["photo", "photos", "图片"].includes(t.toLowerCase())) return "照片";
  return null;
}

export interface GalleryEntry {
  category: string;
  name: string;
  /** 绝对路径 */
  file: string;
}

/**
 * 收藏夹（Gallery）：分类子目录 + 数据库元数据。
 *
 * 布局：
 * ```
 * gallery/
 * ├── 表情包/   ├── meme/   ├── 截图/   ├── 照片/
 * └── 未整理/   # 用户手动丢进来的东西；gallery 根目录的散落文件也会被清扫进来
 * ```
 *
 * 文件是唯一事实来源（用户可随意增删移动）；描述存数据库，按 分类/文件名 查找，
 * 找不到时按 sha256 找回（自动修正被用户移动过的条目）。
 */
export class GalleryStore {
  constructor(
    readonly ctx: Context,
    readonly baseDir: string,
  ) {
    ctx.model.extend(
      "yesimbot_world_gallery",
      {
        id: "unsigned",
        category: "string(64)",
        name: "string(255)",
        sha256: "string(64)",
        description: "text",
        createdAt: "timestamp",
      },
      { autoInc: true, primary: "id" },
    );
  }

  dirOf(category: string): string {
    return category ? path.join(this.baseDir, category) : this.baseDir;
  }

  async ensureDirs(): Promise<void> {
    for (const c of ALL_CATEGORIES) {
      await fs.mkdir(this.dirOf(c), { recursive: true });
    }
  }

  /**
   * 清扫 gallery 根目录：散落的文件（用户随手丢的 / 旧版收藏夹遗留）移进「未整理」。
   * 重名时自动加序号。
   */
  async sweepRoot(): Promise<number> {
    await this.ensureDirs();
    let moved = 0;
    let names: string[];
    try {
      names = await fs.readdir(this.baseDir);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const src = path.join(this.baseDir, name);
      const stat = await fs.stat(src).catch(() => null);
      if (!stat?.isFile()) continue;
      const dest = await this.availableName(UNSORTED_CATEGORY, name);
      await fs.rename(src, path.join(this.dirOf(UNSORTED_CATEGORY), dest)).catch(() => null);
      moved++;
    }
    return moved;
  }

  /** 目标分类下可用的文件名（重名自动加 -2、-3…） */
  private async availableName(category: string, name: string): Promise<string> {
    const dir = this.dirOf(category);
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let candidate = name;
    for (let i = 2; i < 100; i++) {
      const exists = await fs
        .stat(path.join(dir, candidate))
        .then((s) => s.isFile())
        .catch(() => false);
      if (!exists) return candidate;
      candidate = `${stem}-${i}${ext}`;
    }
    return candidate;
  }

  /** 某分类下的文件名列表（排序后） */
  async listNames(category: string): Promise<string[]> {
    try {
      const names = await fs.readdir(this.dirOf(category));
      const files: string[] = [];
      for (const n of names) {
        if (n.startsWith(".")) continue;
        const stat = await fs.stat(path.join(this.dirOf(category), n)).catch(() => null);
        if (stat?.isFile()) files.push(n);
      }
      return files.sort();
    } catch {
      return [];
    }
  }

  /** 各分类的条目数 */
  async counts(): Promise<{ category: string; count: number }[]> {
    const out: { category: string; count: number }[] = [];
    for (const c of ALL_CATEGORIES) {
      out.push({ category: c, count: (await this.listNames(c)).length });
    }
    return out;
  }

  /**
   * 解析收藏夹文件引用："分类/文件名" 或唯一匹配的裸 "文件名"。
   * 找不到、名称有歧义或路径不合法时返回 null。
   */
  async resolve(refText: string): Promise<GalleryEntry | null> {
    const raw = refText.trim();
    if (!raw || raw.includes("\\") || raw.includes("..")) return null;
    const slash = raw.indexOf("/");
    if (slash >= 0) {
      const cat = normalizeCategory(raw.slice(0, slash));
      const name = sanitizeFileName(raw.slice(slash + 1));
      if (!cat || !name) return null;
      const file = path.join(this.dirOf(cat), name);
      const ok = await fs.stat(file).then((s) => s.isFile()).catch(() => false);
      return ok ? { category: cat, name, file } : null;
    }
    const name = sanitizeFileName(raw);
    if (!name) return null;
    const matches: GalleryEntry[] = [];
    for (const cat of ALL_CATEGORIES) {
      const file = path.join(this.dirOf(cat), name);
      const ok = await fs.stat(file).then((s) => s.isFile()).catch(() => false);
      if (ok) matches.push({ category: cat, name, file });
    }
    // 根目录兜底（尚未清扫的散落文件）
    const rootFile = path.join(this.baseDir, name);
    const ok = await fs.stat(rootFile).then((s) => s.isFile()).catch(() => false);
    if (ok) matches.push({ category: "", name, file: rootFile });
    return matches.length === 1 ? matches[0]! : null;
  }

  /**
   * 查找条目的元数据：先按 分类/文件名，找不到再按 sha256 找回
   * （用户手动移动/改名过的条目自动修正路径；同图复制则借用描述）。
   */
  async findMeta(category: string, name: string, sha256?: string): Promise<WorldGalleryRow | null> {
    // A file may be replaced in place. Names alone must never attach the old image's description.
    sha256 ??= await this.hashFile(path.join(this.dirOf(category), name)).catch(() => undefined);
    if (!sha256) return null;
    const byPath = await this.ctx.database.get("yesimbot_world_gallery", { category, name }, { limit: 1 });
    if (byPath[0]?.sha256 === sha256) return byPath[0];
    const bySha = await this.ctx.database.get("yesimbot_world_gallery", { sha256 });
    for (const row of bySha) {
      const exists = await fs
        .stat(path.join(this.dirOf(row.category), row.name))
        .then((s) => s.isFile())
        .catch(() => false);
      if (!exists) {
        // 原位置已无此文件：视为被用户移动/改名，修正为当前位置
        await this.ctx.database.set("yesimbot_world_gallery", { id: row.id }, { category, name });
        return { ...row, category, name };
      }
    }
    return bySha[0] ? { ...bySha[0], category, name } : null;
  }

  /** 仅按 sha256 查找（不做路径修正）：反查某个媒体是否已被收藏过 */
  async findBySha(sha256: string): Promise<WorldGalleryRow | null> {
    const rows = await this.ctx.database.get("yesimbot_world_gallery", { sha256 });
    for (const row of rows) {
      // Check bytes as well as existence: manual replacement must not impersonate the old asset.
      const current = await this.hashFile(path.join(this.dirOf(row.category), row.name)).catch(() => null);
      if (current === sha256) return row;
    }
    return null;
  }

  /** 写入/更新条目描述 */
  async upsertMeta(category: string, name: string, sha256: string, description: string): Promise<void> {
    const existing = await this.ctx.database.get("yesimbot_world_gallery", { category, name }, { limit: 1 });
    if (existing.length) {
      await this.ctx.database.set(
        "yesimbot_world_gallery",
        { id: existing[0]!.id },
        { sha256, description },
      );
      return;
    }
    await this.ctx.database.create("yesimbot_world_gallery", {
      category,
      name,
      sha256,
      description,
      createdAt: new Date(),
    });
  }

  /**
   * 把一个外部文件导入收藏夹（复制进分类目录并记录描述），返回最终文件名。
   * 供浏览器截图等运行时组件直接入库使用（重名自动加序号）。
   */
  async importFile(
    src: string,
    category: string,
    preferredName: string,
    sha256: string,
    description: string,
  ): Promise<string> {
    await this.ensureDirs();
    const name = await this.availableName(category, preferredName);
    await fs.copyFile(src, path.join(this.dirOf(category), name));
    await this.upsertMeta(category, name, sha256, description);
    return name;
  }

  /** 移动条目到另一个分类（可顺带更新描述），返回移动后的位置 */
  async move(
    entry: GalleryEntry,
    targetCategory: string,
    description?: string,
  ): Promise<GalleryEntry> {
    await this.ensureDirs();
    const destName = await this.availableName(targetCategory, entry.name);
    const destFile = path.join(this.dirOf(targetCategory), destName);
    await fs.rename(entry.file, destFile);
    const sha256 = await this.hashFile(destFile);
    const row = await this.findMeta(entry.category, entry.name, sha256);
    if (row) {
      await this.ctx.database.set(
        "yesimbot_world_gallery",
        { id: row.id },
        {
          category: targetCategory,
          name: destName,
          sha256,
          ...(description ? { description } : {}),
        },
      );
    } else {
      await this.ctx.database.create("yesimbot_world_gallery", {
        category: targetCategory,
        name: destName,
        sha256,
        description: description ?? "",
        createdAt: new Date(),
      });
    }
    return { category: targetCategory, name: destName, file: destFile };
  }

  /** 删除条目（文件 + 元数据） */
  async remove(entry: GalleryEntry): Promise<void> {
    await fs.unlink(entry.file);
    if (entry.category) {
      await this.ctx.database.remove("yesimbot_world_gallery", {
        category: entry.category,
        name: entry.name,
      });
    }
  }

  async hashFile(file: string): Promise<string> {
    const data = await fs.readFile(file);
    return createHash("sha256").update(data).digest("hex");
  }
}

/** 文件名净化：拒绝路径穿越（分类前缀已在 resolve 中单独解析） */
export function sanitizeFileName(name: string): string | null {
  const t = name.trim();
  if (!t || t.includes("/") || t.includes("\\") || t.includes("..")) return null;
  return t;
}
