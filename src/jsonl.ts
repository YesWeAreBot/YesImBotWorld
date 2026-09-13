import { promises as fs } from "node:fs";

/** Append one committed record. Failed writes roll back only their own bytes, never earlier history. */
export async function appendJsonLine(file: string, value: unknown): Promise<void> {
  const handle = await fs.open(file, "a+");
  try {
    const size = (await handle.stat()).size;
    const tail = Buffer.alloc(1);
    if (size) await handle.read(tail, 0, 1, size - 1);
    const line = (size && tail[0] !== 10 ? "\n" : "") + JSON.stringify(value) + "\n";
    try {
      await fs.appendFile(file, line);
      await handle.sync();
    } catch (error) {
      try { await handle.truncate(size); await handle.sync(); }
      catch (rollback) { throw new AggregateError([error, rollback], "记录追加失败且未能撤销未提交字节；保留原文件，停止本次写入"); }
      throw error;
    }
  } finally { await handle.close(); }
}
