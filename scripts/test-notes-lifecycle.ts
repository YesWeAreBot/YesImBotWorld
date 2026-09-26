import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotesApp } from "../src/apps/notes.js";
import { AppManager } from "../src/apps/manager.js";
import { WorldFiles } from "../src/files.js";
import { readNoteFile } from "../src/notes.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("notes IO did not settle")), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

async function closeDrainsLocalIO() {
  for (const tool of ["write_note", "edit_note", "delete_note"] as const) {
    for (const stage of (tool === "delete_note" ? ["rm"] : ["mkdir", "rename"]) as ("mkdir" | "rename" | "rm")[]) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-notes-lifecycle-"));
      const files = new WorldFiles(dir); await files.ensure();
      const logger = { info() {}, warn() {} } as any;
      const app = new NotesApp(files, { now: () => 10, clockString: () => "上午" } as any, logger);
      let manager = new AppManager("聊天", [app], new Set(), logger);
      await manager.open(app);
      if (tool !== "write_note") await manager.call("write_note", { title: "旧笔记", content: "旧世界的内容" });
      const entered = deferred(), release = deferred();
      const original = fs[stage]; let held = false;
      (fs as any)[stage] = async (...args: any[]) => {
        const target = String(args[0]);
        const matches = stage === "mkdir" ? target === files.notesDir
          : stage === "rename" ? target.startsWith(path.join(files.notesDir, "旧笔记.md.")) && target.endsWith(".tmp")
          : target === path.join(files.notesDir, "旧笔记.md");
        if (!held && matches) { held = true; entered.resolve(); await release.promise; }
        return (original as any)(...args);
      };
      let action!: Promise<unknown>, closing!: Promise<void>;
      try {
        action = manager.call(tool, { title: "旧笔记", content: "旧世界迟到的写入" });
        await bounded(entered.promise);
        let closed = false;
        closing = manager.closeAll().then(() => { closed = true; });
        await tick();
        assert.equal(closed, false, `${tool}: closeAll must drain pending local ${stage}`);
        await assert.rejects(app.call("write_note", { title: "关闭后", content: "禁止迟到调用" }), /已关闭/);
        release.resolve();
        await bounded(Promise.all([action, closing]));
        await files.reset();
        await tick();
        assert.equal(await files.exists(files.notesDir), false, "the old operation cannot recreate Notes after reset");
        await assert.rejects(app.call("delete_note", { title: "旧笔记" }), /已关闭/);
        manager = new AppManager("聊天", [app], new Set(), logger);
        await manager.open(app);
        await manager.call("write_note", { title: "旧笔记", content: "新世界的新内容" });
        await tick();
        assert.equal((await readNoteFile(path.join(files.notesDir, "旧笔记.md"))).content, "新世界的新内容");
      } finally {
        release.resolve(); (fs as any)[stage] = original;
        await Promise.allSettled([action, closing]);
        await manager.closeAll();
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  }
  console.log("PASS Notes closeAll drains blocked mkdir/rename/delete before reset; stale calls are rejected and explicit reopen operates only on new notes");
}

async function failedIOStillCloses() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-notes-failure-"));
  const files = new WorldFiles(dir); await files.ensure();
  const app = new NotesApp(files, { now: () => 0, clockString: () => "清晨" } as any, { warn() {} } as any);
  const original = fs.rename;
  try {
    fs.rename = async (from, to) => {
      if (String(to).startsWith(files.notesDir + path.sep)) throw new Error("fixture disk failure");
      return original(from, to);
    };
    await assert.rejects(app.call("write_note", { title: "失败", content: "不会落盘" }), /fixture disk failure/);
    await bounded(app.close());
    assert.deepEqual(await fs.readdir(files.notesDir), []);
  } finally { fs.rename = original; await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
  console.log("PASS failed local Notes IO settles and removes temporary files without blocking close");
}

async function main() {
  await closeDrainsLocalIO();
  await failedIOStillCloses();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
