import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BotEvent, RichText } from "../types.js";

interface StoredReceipt { version: 1; epoch: string; event: BotEvent }
const consumers = new Map<string, { owner: object; wake: () => void }>();

/** Late results never write an old BotContext. Epochs deliberately do not roll back with saves. */
export class ReceiptInbox {
  readonly directory: string;
  readonly epochPath: string;
  private readonly epoch: Promise<string>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private base: string) {
    this.directory = path.join(base, "bot-receipts");
    this.epochPath = path.join(base, "bot-receipts-epoch");
    this.epoch = this.ensureEpoch();
    // An unavailable disk must fail the first actual use rather than produce an unhandled rejection.
    void this.epoch.catch(() => {});
  }
  activate(wake: () => void): void { consumers.set(this.base, { owner: this, wake }); }
  deactivate(): void { if (consumers.get(this.base)?.owner === this) consumers.delete(this.base); }
  async ready(): Promise<void> { await this.epoch; }
  async settled(): Promise<void> { await this.writes; }

  save(content: string | RichText, worldTime: number, refToolCallId?: string): Promise<void> {
    const rich: RichText = typeof content === "string" ? { text: content } : content;
    const event: BotEvent = { id: `ev_receipt_${randomUUID()}`, source: "tool", content: rich.text, worldTime,
      ...(refToolCallId ? { refToolCallId } : {}), ...(rich.originEventIds ? { originEventIds: rich.originEventIds } : {}),
      ...(rich.attachments ? { attachments: rich.attachments } : {}), ...(rich.parts ? { parts: rich.parts } : {}), ...(rich.statusEcho ? { statusEcho: rich.statusEcho } : {}) };
    const work = this.writes.then(async () => {
      const epoch = await this.epoch;
      await fs.mkdir(this.directory, { recursive: true });
      await this.atomicFile(path.join(this.directory, `${event.id}.json`), JSON.stringify({ version: 1, epoch, event } satisfies StoredReceipt));
      consumers.get(this.base)?.wake();
    });
    this.writes = work.catch(() => {});
    return work;
  }

  async drain(accept: (event: BotEvent) => Promise<void>): Promise<void> {
    const epoch = await this.epoch;
    if ((await fs.readFile(this.epochPath, "utf8")).trim() !== epoch) return;
    let names: string[];
    try { names = await fs.readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of names.sort()) {
      if (!/^ev_receipt_[\da-f-]+\.json$/.test(name)) continue;
      const file = path.join(this.directory, name);
      const receipt = JSON.parse(await fs.readFile(file, "utf8")) as StoredReceipt;
      if (receipt.version !== 1 || receipt.epoch !== epoch) continue; // Retain other timelines as an administrative audit only.
      if ((await fs.readFile(this.epochPath, "utf8")).trim() !== epoch) return;
      await accept(receipt.event);
      await fs.rm(file, { force: true });
    }
  }

  private async ensureEpoch(): Promise<string> {
    await fs.mkdir(this.base, { recursive: true });
    try { return (await fs.readFile(this.epochPath, "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const epoch = randomUUID(), tmp = `${this.epochPath}.${epoch}.tmp`;
    await fs.writeFile(tmp, epoch, { flag: "wx" });
    try { await fs.link(tmp, this.epochPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { await fs.rm(tmp, { force: true }); }
    return (await fs.readFile(this.epochPath, "utf8")).trim();
  }
  private async atomicFile(file: string, text: string): Promise<void> {
    const tmp = `${file}.${randomUUID()}.tmp`, handle = await fs.open(tmp, "wx");
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, file);
  }
}
