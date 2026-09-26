import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ParsedPage } from "./html.js";
import type { BrowserSessionState } from "./browser-session.js";

export interface BrowserPage extends ParsedPage {
  url: string;
  html?: string;
  screen: number;
  originEventIds?: string[];
}
export interface BrowserVisit {
  id: string; url: string; title: string; visitedAt: string; worldTime: string;
  /** Virtual/text history is a record of what was read, never newly generated evidence. */
  page?: BrowserPage;
}
export interface BrowserBookmark {
  id: string; url: string; title: string; createdAt: string; updatedAt: string;
  page?: BrowserPage;
}
export interface BrowserLibraryMode {
  current: BrowserPage | null;
  back: BrowserPage[];
  forward: BrowserPage[];
  history: BrowserVisit[];
  bookmarks: BrowserBookmark[];
  session?: BrowserSessionState;
}
const empty = (): BrowserLibraryMode => ({ current: null, back: [], forward: [], history: [], bookmarks: [] });

/** World-scoped storage. Cookies/storage never enter the public library projection. */
export class BrowserLibrary {
  private data = { version: 1, real: empty(), virtual: empty() };
  private loading?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  constructor(private file?: string) {}

  load(): Promise<void> {
    return this.loading ??= (async () => {
      if (!this.file) return;
      let content: string;
      try { content = await fs.readFile(this.file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const data = JSON.parse(content);
      const page = (value: any) => value && typeof value.url === "string" && typeof value.title === "string" && typeof value.text === "string" && Array.isArray(value.links) && Array.isArray(value.images) && Number.isInteger(value.screen) && value.screen >= 0;
      for (const mode of ["real", "virtual"]) {
        const value = data?.[mode];
        if (data?.version !== 1 || !value || (value.current !== null && !page(value.current)) ||
            !Array.isArray(value.back) || !value.back.every(page) || !Array.isArray(value.forward) || !value.forward.every(page) ||
            !Array.isArray(value.history) || !value.history.every((item: any) => typeof item?.id === "string" && typeof item.url === "string" && typeof item.title === "string" && typeof item.visitedAt === "string" && (!item.page || page(item.page))) ||
            !Array.isArray(value.bookmarks) || !value.bookmarks.every((item: any) => typeof item?.id === "string" && typeof item.url === "string" && typeof item.title === "string" && typeof item.createdAt === "string" && typeof item.updatedAt === "string" && (!item.page || page(item.page)))) {
          throw new Error("浏览器存档格式无效，请保留原文件检查；未覆盖已有记录。");
        }
      }
      this.data = data;
    })();
  }

  get(mode: "real" | "virtual"): BrowserLibraryMode { return this.data[mode]; }

  save(): Promise<void> {
    if (!this.file) return Promise.resolve(); // Minimal embedded/offline fixtures may use an in-memory library.
    const file = this.file, content = JSON.stringify(this.data);
    const operation = this.tail.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 }); await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  view(mode: "real" | "virtual") {
    const data = this.get(mode);
    return {
      history: data.history.slice().reverse().map(({ id, url, title, visitedAt, worldTime }) => ({ id, url, title, visitedAt, worldTime })),
      bookmarks: data.bookmarks.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, url, title, createdAt, updatedAt }) => ({ id, url, title, createdAt, updatedAt })),
    };
  }
}
