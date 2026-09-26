/** The real shell editor runs in a minimal VM DOM; no server, browser or model. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync("src/webui/client/legacy.js", "utf8");
new vm.Script(source);
new vm.Script(readFileSync("src/webui/client/studio.js", "utf8"));
const paneCode = source.slice(source.indexOf("function phoneShellPane("), source.indexOf("function jsonlPane("));
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(content: string, visitor = false) {
  const nodes: any[] = [], calls: any[] = [], pending: ReturnType<typeof deferred>[] = [];
  const document = { activeElement: null as any };
  const sandbox: any = {
    SCREEN_PLACEHOLDER: "data:image/png;base64,AA==", isVisitor: () => visitor, document,
    toast() {}, confirm() { throw new Error("Shell design needs no extra confirmation"); },
    api(method: string, url: string, body: unknown) {
      calls.push({ method, url, body }); const task = deferred(); pending.push(task); return task.promise;
    },
    el(tag: string, attrs: any = {}, children: any[] = []) {
      const node: any = { tag, attrs, children: [], value: "", textContent: attrs.text || "", disabled: false, readOnly: false,
        appendChild(child: any) { this.children.push(child); },
        focus() { throw new Error("Async refresh must not steal focus"); },
      };
      children.forEach(child => node.appendChild(child)); nodes.push(node); return node;
    },
  };
  vm.runInNewContext(paneCode, sandbox);
  const meta = { phone: { width: 800, height: 1280 } };
  sandbox.phoneShellPane(content, meta);
  const area = nodes.find(node => node.tag === "textarea"), preview = nodes.find(node => node.tag === "iframe");
  const status = nodes.find(node => node.attrs.role === "status");
  const button = (text: string) => nodes.find(node => node.tag === "button" && node.textContent === text);
  const edit = (value: string) => { area.value = value; area.attrs.oninput(); };
  return { nodes, calls, pending, meta, document, area, preview, status, button, edit };
}

async function interactions() {
  const original = '<div>{{width}}×{{height}}<img src="{{screen}}">old</div>';
  const f = fixture(original);
  const generate = f.button("让 World LLM 重新设计"), preview = f.button("刷新预览"), undo = f.button("撤销修改"), save = f.button("保存外壳");
  assert.ok(generate); assert.equal(save.disabled, true);
  assert.match(f.preview.srcdoc, /800×1280/);
  const before = f.preview.srcdoc, nodeCount = f.nodes.length;
  f.document.activeElement = f.area;
  f.edit("draft <b>custom</b>");
  assert.equal(generate.disabled, true); assert.equal(save.disabled, false);
  assert.match(f.status.textContent, /先保存或撤销/);
  generate.attrs.onclick(); assert.equal(f.calls.length, 0, "Dirty editor must never submit a destructive replacement");
  assert.equal(f.area.value, "draft <b>custom</b>"); assert.equal(f.preview.srcdoc, before);
  preview.attrs.onclick(); assert.match(f.preview.srcdoc, /draft/);
  undo.attrs.onclick(); assert.equal(f.area.value, original); assert.equal(f.preview.srcdoc, before); assert.equal(generate.disabled, false);

  const work = generate.attrs.onclick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, "POST"); assert.equal(f.calls[0].url, "/api/state/phone-shell/generate");
  assert.equal(JSON.stringify(f.calls[0].body), "{}");
  assert.equal(f.area.readOnly, true); assert.ok([generate, preview, undo, save].every(node => node.disabled));
  assert.match(f.status.textContent, /正在生成/); assert.equal(f.preview.srcdoc, before);
  generate.attrs.onclick(); save.attrs.onclick(); undo.attrs.onclick(); preview.attrs.onclick();
  assert.equal(f.calls.length, 1, "Repeated clicks cannot generate or save concurrently");
  const generated = '<main>{{width}}×{{height}}<img src="{{screen}}">new</main>';
  f.pending[0]!.resolve({ ok: true, content: generated, phone: { width: 960, height: 1440 } });
  await work;
  assert.equal(f.area.value, generated); assert.equal(f.area.readOnly, false);
  assert.equal(f.meta.phone.width, 960); assert.equal(f.meta.phone.height, 1440);
  assert.match(f.preview.srcdoc, /960×1440/); assert.match(f.preview.srcdoc, /new/);
  assert.match(f.status.textContent, /新外壳已保存/);
  assert.equal(f.nodes.length, nodeCount); assert.equal(f.document.activeElement, f.area);

  const completedPreview = f.preview.srcdoc;
  const failed = generate.attrs.onclick(); f.pending[1]!.reject(new Error("模型超时")); await failed;
  assert.equal(f.area.value, generated); assert.equal(f.preview.srcdoc, completedPreview);
  assert.equal(f.area.readOnly, false); assert.equal(generate.disabled, false);
  assert.match(f.status.textContent, /模型超时.*当前预览与源码未替换/);
  const invalid = generate.attrs.onclick(); f.pending[2]!.resolve({ ok: true, content: "", phone: { width: 1, height: 1 } }); await invalid;
  assert.equal(f.area.value, generated); assert.equal(f.preview.srcdoc, completedPreview); assert.equal(f.meta.phone.width, 960);

  f.edit("my saved design");
  const saveFailed = save.attrs.onclick(); assert.equal(f.area.readOnly, true);
  f.pending[3]!.reject(new Error("写入失败")); await saveFailed;
  assert.equal(f.area.value, "my saved design"); assert.equal(generate.disabled, true);
  assert.match(f.status.textContent, /保存失败.*写入失败.*修改仍保留/);
  const saving = save.attrs.onclick(); f.pending[4]!.resolve({ ok: true }); await saving;
  assert.equal(generate.disabled, false); assert.equal(save.disabled, true);
  assert.match(f.preview.srcdoc, /my saved design/);
  assert.equal(f.calls[4].method, "PUT"); assert.equal(f.calls[4].body.content, "my saved design");
  assert.equal(f.nodes.length, nodeCount); assert.equal(f.document.activeElement, f.area);
}

async function emptyAndVisitor() {
  const empty = fixture("");
  const generate = empty.button("生成手机与浏览器外壳");
  assert.ok(generate); assert.equal(generate.disabled, false);
  assert.doesNotMatch(empty.preview.srcdoc, /创世/);
  const job = generate.attrs.onclick(); empty.pending[0]!.resolve({ ok: true, content: "new shell", phone: { width: 800, height: 1280 } }); await job;
  assert.equal(generate.textContent, "让 World LLM 重新设计");
  const viewer = fixture('<script>parent.localStorage.clear()</script><img src="https://invalid.test/pixel"><img src="{{screen}}">', true);
  assert.equal(viewer.nodes.filter(node => node.tag === "button").length, 0); assert.equal(viewer.area.readOnly, true);
  assert.equal(viewer.preview.attrs.sandbox, ""); assert.equal(viewer.preview.attrs.referrerpolicy, "no-referrer");
  assert.match(viewer.preview.srcdoc, /^<meta http-equiv="Content-Security-Policy"/);
  assert.match(viewer.preview.srcdoc, /default-src 'none'; script-src 'none'/);
  assert.equal(viewer.calls.length, 0);
}

async function main() {
  await interactions(); await emptyAndVisitor();
  console.log("PASS shell editor: independent generation, preserved dirty drafts and failed designs, busy controls, unchanged DOM/focus, updated dimensions, explicit save and isolated visitor preview");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
