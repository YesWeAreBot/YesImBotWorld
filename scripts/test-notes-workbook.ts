import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { NotesApp } from "../src/apps/notes.js";
import { WorldFiles } from "../src/files.js";
import { readNoteFile } from "../src/notes.js";

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-workbook-"));
  const files = new WorldFiles(directory); await files.ensure();
  let now = 1;
  const app = new NotesApp(files, { now: () => now, clockString: () => `世界 ${now}` } as any, { warn() {} } as any);
  const note = () => readNoteFile(path.join(files.notesDir, "工作本.md"));
  try {
    const opened = await app.open();
    for (const tool of ["search_notes", "replace_note_text", "check_note_item", "write_note", "edit_note"]) assert.ok(opened.tools.some(item => item.name === tool));
    const body = "# 账本\n早餐：12 元\n午餐：12 元\n\n# Todo\n- [ ] 买牛奶\n- [ ] 交作业\n- [ ] 买牛奶\n\n剪贴：Hello World，金额 $&，模式 .*";
    await app.call("write_note", { title: "工作本", content: body });
    const created = (await note()).created;
    assert.match(await app.call("search_notes", { query: "hello world" }), /工作本.*\n.*Hello World/s);
    assert.match(await app.call("search_notes", { query: ".*" }), /模式 \.\*/);
    assert.match(await app.call("search_notes", { query: "HELLO", case_sensitive: true }), /没有找到/);
    assert.match(await app.call("search_notes", { query: "工作本" }), /找到 1 篇/);
    await assert.rejects(app.call("search_notes", { query: "" }), /非空/);
    await assert.rejects(app.call("search_notes", { query: "账本", limit: 0 }), /limit/);
    assert.match(await app.call("replace_note_text", { title: "工作本", find: "12 元", replace: "15 元" }), /出现 2 次/);
    assert.equal((await note()).content, body, "ambiguous exact replacement must not alter any occurrence");
    now = 2;
    await app.call("replace_note_text", { title: "工作本", find: "12 元", replace: "$& 元", all: true });
    assert.equal((await note()).content.match(/\$& 元/g)?.length, 2, "replacement is literal, never String.replace's interpolation syntax");
    assert.deepEqual((await note()).created, created); assert.equal((await note()).updated?.value, 2);
    const beforeAmbiguous = await note();
    assert.match(await app.call("check_note_item", { title: "工作本", item: "买牛奶", checked: true }), /2 条同名/);
    assert.deepEqual(await note(), beforeAmbiguous);
    now = 3;
    await app.call("check_note_item", { title: "工作本", item: "买牛奶", checked: true, occurrence: 2 });
    assert.match((await note()).content, /- \[ \] 买牛奶\n- \[ \] 交作业\n- \[x\] 买牛奶/);
    const checked = await note(); now = 4;
    await app.call("check_note_item", { title: "工作本", item: "买牛奶", checked: true, occurrence: 2 });
    assert.deepEqual(await note(), checked, "idempotent checkbox operations do not change edit time");
    await app.call("check_note_item", { title: "工作本", item: "买牛奶", checked: false, occurrence: 2 });
    assert.doesNotMatch((await note()).content, /\[x\]/);
    await assert.rejects(app.call("check_note_item", { title: "工作本", item: "交作业", checked: "true" }), /布尔/);
    await assert.rejects(app.call("replace_note_text", { title: "工作本", find: "", replace: "x" }), /非空/);
    await app.call("replace_note_text", { title: "工作本", find: "Hello World", replace: "" });
    assert.doesNotMatch((await note()).content, /Hello World/);
    now = 5;
    await Promise.all([
      app.call("edit_note", { title: "工作本", content: "追加第一条", append: true }),
      app.call("edit_note", { title: "工作本", content: "追加第二条", append: true }),
      app.call("check_note_item", { title: "工作本", item: "交作业", checked: true }),
    ]);
    const result = await note();
    assert.match(result.content, /追加第一条\n\n追加第二条/); assert.match(result.content, /- \[x\] 交作业/);
    assert.deepEqual(result.created, created); assert.equal(result.updated?.value, 5);
    await app.call("edit_note", { title: "工作本", append: true, content: "```markdown\n- [ ] 只是代码范例\n```\n- [ ] 真实清单" });
    assert.match(await app.call("check_note_item", { title: "工作本", item: "只是代码范例", checked: true }), /未找到/);
    await app.call("check_note_item", { title: "工作本", item: "真实清单", checked: true });
    assert.match((await note()).content, /- \[ \] 只是代码范例\n```\n- \[x\] 真实清单/);
    await app.close();
    await assert.rejects(app.call("search_notes", { query: "账本" }), /已关闭/);
    await app.open(); assert.match(await app.call("search_notes", { query: "账本" }), /工作本/);
    console.log("PASS notes workbook: literal search/replacement, ambiguity guards, precise checklist edits, immutable creation/idempotent timestamps and concurrent append safety");
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
