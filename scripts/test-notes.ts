import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotesApp } from "../src/apps/notes.js";
import { WorldFiles } from "../src/files.js";
import { WorldService } from "../src/service.js";
import { compareNotes, parseNote, readNoteFile, noteTimeText, sanitizeNoteTitle } from "../src/notes.js";

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-notes-"));
  try {
    const files = new WorldFiles(base); await files.ensure();
    let now = 10;
    const clock = { now: () => now, clockString: (t: number) => `世界时刻 ${t}` } as any;
    const app = new NotesApp(files, clock, { warn() {} } as any);
    assert.equal(sanitizeNoteTitle("../"), "");
    assert.equal(Array.from(sanitizeNoteTitle("🌱".repeat(61))).length, 60);
    assert.ok(sanitizeNoteTitle("🌱".repeat(61)).isWellFormed(), "filename limits must not split emoji surrogate pairs");
    // Use only the service's file adapter methods; no Koishi context, model, world or messaging startup.
    const service = Object.assign(Object.create(WorldService.prototype), { files, clock }) as WorldService;
    await app.call("write_note", { title: "早写晚改", content: "第一稿" });
    now = 20; await app.call("write_note", { title: "晚写未改", content: "第二篇" });
    now = 30; await app.call("edit_note", { title: "早写晚改", content: "补充", append: true });
    now = 40; await app.call("edit_note", { title: "早写晚改", new_title: "改名之后" });
    const renamed = await readNoteFile(path.join(files.notesDir, "改名之后.md"));
    assert.equal(renamed.created?.value, 10);
    assert.equal(renamed.updated?.value, 40);
    assert.equal(renamed.content, "第一稿\n\n补充");
    assert.equal(await files.exists(path.join(files.notesDir, "早写晚改.md")), false);
    now = 50; await service.writeNote("改名之后", "从网页修改");
    const edited = await readNoteFile(path.join(files.notesDir, "改名之后.md"));
    assert.deepEqual(edited.created, renamed.created, "WebUI saves must preserve creation metadata");
    assert.equal(edited.updated?.value, 50, "WebUI and App writes use the same world timestamp format");
    const webNotes = await service.notes();
    assert.equal(webNotes[0]?.title, "改名之后");
    assert.equal(webNotes[0]?.updated?.clock, "world");
    assert.equal(webNotes[0]?.content, "从网页修改");
    assert.equal(webNotes.slice().sort((a, b) => compareNotes(a, b, "created"))[0]?.title, "晚写未改");
    const updatedList = await app.call("list_notes", { sort: "updated" });
    const createdList = await app.call("list_notes", { sort: "created" });
    assert.ok(updatedList.indexOf("改名之后") < updatedList.indexOf("晚写未改"));
    assert.ok(createdList.indexOf("晚写未改") < createdList.indexOf("改名之后"));
    await assert.rejects(app.call("list_notes", { sort: "invalid" }), /sort/);
    assert.match(await app.call("view_note", { title: "改名之后" }), /创建 世界时刻 10.*最近编辑 世界时刻 50/);

    const old = parseNote("---\r\ncreated: 旧历清晨（T=3.0）\r\nupdated: 旧历黄昏（T=8.5）\r\n---\r\n\r\n旧版笔记");
    assert.equal(old.created?.value, 3); assert.equal(old.updated?.value, 8.5); assert.equal(old.content, "旧版笔记");
    const noTu = parseNote("---\ncreated: 2026-01-01 09:00\nupdated: 2026-01-02 10:00\n---\n旧网页创建的记录");
    assert.equal(noTu.created?.clock, "world"); assert.equal(noTu.created?.value, null, "do not misread a virtual calendar date as Unix time");
    assert.match(noteTimeText(noTu.created), /未记录 TU/);
    const importedFile = path.join(files.notesDir, "用户导入.md");
    await fs.writeFile(importedFile, "手动放入的笔记");
    const imported = await readNoteFile(importedFile);
    assert.equal(imported.updated?.source, "file"); assert.equal(imported.updated?.clock, "real");
    assert.match(noteTimeText(imported.updated), /文件时间/);
    assert.ok(compareNotes({ title: "世界笔记", ...edited }, { title: "导入", ...imported }) < 0, "Unix milliseconds must never numerically outrank a world TU");
    now = 60; await app.call("edit_note", { title: "用户导入", content: "在应用里补充" });
    const importedEdited = await readNoteFile(importedFile);
    assert.deepEqual(importedEdited.created, imported.created, "atomic replacement must keep imported creation metadata stable");
    assert.equal(importedEdited.updated?.value, 60);
    assert.equal(importedEdited.created?.source, "file");
    now = 70; await service.writeNote("用户导入", "再次从网页修改");
    assert.deepEqual((await readNoteFile(importedFile)).created, imported.created);
    assert.equal((await fs.readdir(files.notesDir)).some(name => name.endsWith(".tmp")), false);
    console.log("PASS notes: App/WebUI timestamp parity, immutable creation through edit/rename, legacy frontmatter, distinct clock domains, imported file provenance and both sort orders");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
