import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppToolDef } from "./app.js";

/** Learned navigation hints only. Nothing here opens a device or grants execution permission. */
export class LearnedToolCatalog {
  private owners = new Map<string, AppToolDef[]>();
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string | undefined, private warn: (error: unknown) => void) {}

  load(): Promise<void> {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      if (!this.file) return;
      try {
        const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
        if (raw?.schemaVersion !== 1 || !raw.owners || typeof raw.owners !== "object" || Array.isArray(raw.owners)) throw new Error("已学工具目录格式无效");
        for (const [owner, defs] of Object.entries(raw.owners)) {
          if (this.owners.has(owner) || !Array.isArray(defs) || defs.length > 2000 || !defs.every(validDefinition) || new Set(defs.map(def => def.name)).size !== defs.length) continue;
          this.owners.set(owner, structuredClone(defs));
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(error); }
    })();
    return this.loaded;
  }

  async remember(owner: string, defs: AppToolDef[]): Promise<void> {
    // Startup loads may race with a successful discovery. The live result always wins.
    await this.load();
    this.owners.set(owner, structuredClone(defs));
    if (!this.file) return;
    const data = JSON.stringify({ schemaVersion: 1, owners: Object.fromEntries(this.owners) });
    const write = this.writes.then(async () => {
      const file = this.file!, temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(temporary, data, { flag: "wx" });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
    });
    // Losing an optional navigation cache cannot turn an opened real application into failure.
    this.writes = write.catch(error => this.warn(error));
    await this.writes;
  }

  /** Ambiguous names and no-longer-installed owners are excluded, not guessed by display name. */
  known(ownerIds: string[], blocked: Iterable<string> = []): { owner: string; def: AppToolDef }[] {
    const forbidden = new Set(blocked), ownerCounts = new Map<string, number>();
    for (const owner of ownerIds) ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
    const entries = [...ownerCounts].filter(([, count]) => count === 1).flatMap(([owner]) => (this.owners.get(owner) ?? []).map(def => ({ owner, def })));
    const names = new Map<string, number>();
    for (const { def } of entries) names.set(def.name, (names.get(def.name) ?? 0) + 1);
    return structuredClone(entries.filter(({ def }) => !forbidden.has(def.name) && names.get(def.name) === 1));
  }
}

function validDefinition(value: unknown): value is AppToolDef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const def = value as AppToolDef;
  return typeof def.name === "string" && !!def.name && def.name.length <= 256
    && typeof def.signature === "string" && def.signature.length <= 8192
    && typeof def.description === "string" && def.description.length <= 100_000
    && (def.inputSchema === undefined || !!def.inputSchema && typeof def.inputSchema === "object" && !Array.isArray(def.inputSchema));
}
