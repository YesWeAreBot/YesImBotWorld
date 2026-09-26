/** App results retain facts and provenance without reprinting their use manuals. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { NotesApp } from "../src/apps/notes.js";
import { TerminalApp } from "../src/apps/terminal.js";
import { FileManagerApp } from "../src/apps/files.js";
import { BrowserApp } from "../src/apps/browser.js";
import { NewsApp } from "../src/apps/news.js";
import { AssistantApp } from "../src/apps/assistant.js";
import type { RichText } from "../src/types.js";

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-app-feedback-"));
  const files = new WorldFiles(dir); await files.ensure(); await files.writeMeta({ realWorld: false } as any);
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;
  const clock = { now: () => 12, timeLine: () => "星历十二刻", clockString: () => "星历十二刻", syncRealTime: false } as any;
  const cfg = Config({ autoStart: false });
  const notes = new NotesApp(files, clock, logger);
  const notices: RichText[] = [];
  const assistant = new AssistantApp({ historyFile: path.join(dir, "assistant.json"), llm: {} as any,
    client: { complete: async () => ({ content: "草稿第一行\n草稿第二行", toolCalls: [] }) },
    onComplete: notice => { notices.push(notice); } });
  const browser = new BrowserApp({} as any, {
    observeVirtualApp: async () => ({ text: '<html><head><title>旧书目录</title></head><body><p>每周更新目录</p><a href="https://books.invalid/detail">查看目录</a></body></html>', originEventIds: ["web-original"] }),
  } as any, files, clock, {} as any, {} as any, {} as any, () => false, cfg.apps, logger);
  try {
    const opening = await notes.open();
    assert.doesNotMatch(opening.opening, /write_note|可以保存|写作业/);
    assert.match(opening.tools.find(tool => tool.name === "write_note")!.description, /Markdown/, "the on-demand manual remains complete");
    assert.doesNotMatch(await notes.call("list_notes", {}), /write_note/);
    const body = "# 原样正文\n- [ ] 买牛奶\n金额 12.50";
    assert.match(await notes.call("write_note", { title: "采购", content: body }), /已记下「采购」/);
    const read = await notes.call("view_note", { title: "采购" });
    assert.ok(read.endsWith(body)); assert.match(read, /创建.*最近编辑/);
    assert.match(await notes.call("write_note", { title: "采购", content: body }), /edit_note/, "a rejected duplicate still explains how to recover");

    const rich: RichText = { text: "保留的输出\n第二行", originEventIds: ["device-original"], parts: [{ kind: "text", text: "保留的输出\n第二行" }] };
    const world = { executeAppAction: async () => structuredClone(rich), observeVirtualApp: async () => structuredClone(rich) } as any;
    const terminal = new TerminalApp({} as any, world, files, clock, cfg.apps, logger);
    const explorer = new FileManagerApp({} as any, world, files, clock, cfg.apps, logger);
    assert.deepEqual(await terminal.call("run_command", { command: "cat journal" }), rich, "virtual stdout, media parts and origins survive without an appended tutorial");
    assert.deepEqual(await explorer.call("show", { path: "journal" }), rich, "reading preserves the exact rich result and provenance");
    world.executeAppAction = async () => { throw new Error("offline failure"); };
    assert.match(String(await terminal.call("run_command", { command: "cat journal" })), /未取得结果.*不能据此判断是否执行成功/);
    const realTerminal = new TerminalApp({ homeDir: "/home/character", exec: async () => ({ code: 7, output: "original stderr\n" }) } as any,
      world, { readMeta: async () => ({ realWorld: true }) } as any, clock, cfg.apps, logger);
    const processResult = await realTerminal.call("run_command", { command: "fixture", cwd: "work" });
    assert.equal(processResult, "终端 · work（退出码 7）\noriginal stderr\n", "concise feedback must retain the process failure status and exact output");

    assert.doesNotMatch(String((await browser.open()).opening), /可用 home|search 搜索/);
    const page = await browser.call("open_url", { url: "https://books.invalid" }) as RichText;
    assert.match(page.text, /旧书目录[\s\S]*每周更新目录[\s\S]*查看目录/);
    assert.deepEqual(page.originEventIds, ["web-original"]);
    assert.doesNotMatch(page.text, /用 open_link|view_image 点开|可用 screenshot/);
    assert.match(String(await browser.call("open_link", { n: 999 })), /当前页面没有链接/, "invalid navigation remains an explicit failure");

    await files.appendNews({ t: 12, clock: "星历十二刻", content: "图书馆开放", detail: "东翼阅览室重新开放。" });
    const news = new NewsApp(files, clock, cfg.apps, logger);
    assert.doesNotMatch((await news.open()).opening, /扑面而来|你点开/);
    const headlines = await news.call("headlines", {});
    assert.match(headlines, /\[1\].*T=12\.0.*图书馆开放/);
    assert.doesNotMatch(headlines, /open_news|你划着|映入眼帘/);
    assert.match(await news.call("open_news", { n: 1 }), /星历十二刻[\s\S]*东翼阅览室重新开放/);

    assert.doesNotMatch((await assistant.open()).opening, /可以发起问题|只能读取/);
    const task = await assistant.call("ask", { question: "写两行草稿" });
    assert.match(task, /任务 .* 正在生成/);
    for (let i = 0; i < 200 && assistant.viewState().busy; i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(assistant.viewState().busy, false);
    assert.match(notices[0]!.text, /已完成/);
    assert.doesNotMatch(notices[0]!.text, /read_reply|草稿第一行/, "completion notices neither teach nor prematurely reveal the result");
    const reply = await assistant.call("read_reply", {});
    assert.match(reply, /外部助手的建议.*不是世界事实/);
    assert.ok(reply.endsWith("草稿第一行\n草稿第二行"));
    console.log("PASS app feedback: readable facts without repeated tutorials, complete help, provenance, media boundaries and actionable failures");
  } finally {
    await assistant.dispose(); await notes.close(); await browser.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
