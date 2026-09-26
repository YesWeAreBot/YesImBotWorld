/** Remember only tools actually discovered by opening a device; knowledge never grants live availability. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { ComputerDevice } from "../src/apps/computerDevice.js";
import { WorldFiles } from "../src/files.js";
import type { AppRawTool, WorldApp } from "../src/apps/app.js";

const warnings: unknown[] = [];
const logger = { info() {}, warn(...args: unknown[]) { warnings.push(args); } } as any;
const raw = (name: string): AppRawTool => ({ name, description: `${name}的已学说明`, inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } });
function fixtureApp(id: string, tools: string[]) {
  const counters = { opens: 0, calls: 0, closes: 0 };
  const available = { tools };
  const app: WorldApp = { id, name: `应用 ${id}`, description: "本地测试应用", connected: true,
    open: async () => { counters.opens++; return { tools: available.tools.map(raw), opening: "当前应用界面。" }; },
    call: async name => { counters.calls++; if (!available.tools.includes(name)) throw new Error("工具已移除"); return "已执行"; },
    close: async () => { counters.closes++; },
  };
  return { app, counters, available };
}

async function catalogLifecycle(base: string) {
  const world = new WorldFiles(base); await world.ensure(); await world.writeMeta({ realWorld: true });
  const emptyArchive = path.join(world.archiveDir, await world.snapshot("没有工具知识"));
  const phoneApp = fixtureApp("notes", ["past_note"]), terminal = fixtureApp("terminal", ["past_command"]);
  const phone = () => new AppManager("聊天", [phoneApp.app], new Set(), logger, () => [], world.phoneToolCatalog);
  const computer = () => new ComputerDevice(terminal.app as any, null, null, { ensureReady: async () => ({ ok: true }) } as any,
    world, { syncRealTime: true } as any, { mode: "docker" } as any, new Set(), logger, () => [], true, world.computerToolCatalog);
  let activePhone = phone(), activeComputer = computer();
  await activePhone.open(phoneApp.app); await activeComputer.open();
  await activePhone.closeAll(); await activeComputer.close();
  const pastPhone = await fs.readFile(world.phoneToolCatalog, "utf8"), pastComputer = await fs.readFile(world.computerToolCatalog, "utf8");
  const pastArchive = path.join(world.archiveDir, await world.snapshot("过去的知识"));
  assert.equal(await fs.readFile(path.join(pastArchive, "phone-tool-catalog.json"), "utf8"), pastPhone);
  assert.equal(await fs.readFile(path.join(pastArchive, "computer-tool-catalog.json"), "utf8"), pastComputer);
  const manifest = JSON.parse(await fs.readFile(path.join(pastArchive, "manifest.json"), "utf8"));
  assert.ok(manifest.files.includes("phone-tool-catalog.json") && manifest.files.includes("computer-tool-catalog.json"));

  phoneApp.available.tools = ["future_note"]; terminal.available.tools = ["future_command"];
  activePhone = phone(); activeComputer = computer();
  await activePhone.loadToolCatalog(); await activeComputer.loadToolCatalog();
  await activePhone.open(phoneApp.app); await activeComputer.open();
  assert.deepEqual(activePhone.knownToolDefs().map(def => def.name), ["future_note"]);
  assert.deepEqual(activeComputer.knownToolDefs().map(def => def.name), ["future_command"]);
  await activePhone.closeAll(); await activeComputer.close();
  await world.restoreFrom(pastArchive);
  activePhone = phone(); activeComputer = computer();
  const opensBeforeRestore = phoneApp.counters.opens + terminal.counters.opens;
  await activePhone.loadToolCatalog(); await activeComputer.loadToolCatalog();
  assert.deepEqual(activePhone.knownToolDefs().map(def => def.name), ["past_note"], "restored characters cannot navigate with future phone knowledge");
  assert.deepEqual(activeComputer.knownToolDefs().map(def => def.name), ["past_command"], "restored characters cannot navigate with future computer knowledge");
  assert.equal(phoneApp.counters.opens + terminal.counters.opens, opensBeforeRestore, "restored knowledge is loaded without discovering the current app's future definitions");
  await activePhone.closeAll(); await activeComputer.close();

  await world.restoreFrom(emptyArchive);
  assert.equal(await world.exists(world.phoneToolCatalog), false);
  assert.equal(await world.exists(world.computerToolCatalog), false);
  activePhone = phone(); activeComputer = computer();
  await activePhone.loadToolCatalog(); await activeComputer.loadToolCatalog();
  assert.deepEqual(activePhone.knownToolDefs(), []); assert.deepEqual(activeComputer.knownToolDefs(), [], "old archives without catalogs clear later learned knowledge");
  await activePhone.open(phoneApp.app); await activeComputer.open();
  await activePhone.closeAll(); await activeComputer.close();
  const beforeResetPhone = await fs.readFile(world.phoneToolCatalog, "utf8"), beforeResetComputer = await fs.readFile(world.computerToolCatalog, "utf8");
  const priorArchives = new Set(await fs.readdir(world.archiveDir));
  await world.reset();
  const resetArchive = (await fs.readdir(world.archiveDir)).find(name => !priorArchives.has(name));
  assert.ok(resetArchive, "reset archives the previous character's learned tools");
  assert.equal(await fs.readFile(path.join(world.archiveDir, resetArchive, "phone-tool-catalog.json"), "utf8"), beforeResetPhone);
  assert.equal(await fs.readFile(path.join(world.archiveDir, resetArchive, "computer-tool-catalog.json"), "utf8"), beforeResetComputer);
  assert.equal(await world.exists(world.phoneToolCatalog), false); assert.equal(await world.exists(world.computerToolCatalog), false);
  activePhone = phone(); activeComputer = computer();
  await activePhone.loadToolCatalog(); await activeComputer.loadToolCatalog();
  assert.deepEqual(activePhone.knownToolDefs(), []); assert.deepEqual(activeComputer.knownToolDefs(), [], "a new character must learn device operations from its own experiences");
  await activePhone.closeAll(); await activeComputer.close();
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-known-tools-"));
  try {
    const file = path.join(dir, "phone-tools.json"), a = fixtureApp("alpha", ["write_note", "search"]), b = fixtureApp("beta", ["search", "find_book"]);
    let blocked: string[] = [];
    const manager = new AppManager("聊天", [a.app, b.app], new Set(["send"]), logger, () => blocked, file);
    await manager.loadToolCatalog();
    assert.deepEqual(manager.knownToolDefs(), []);
    assert.equal(manager.toolOwner("write_note"), null);
    assert.equal(a.counters.opens + b.counters.opens, 0, "catalog reads cannot probe or open unvisited applications");
    await manager.open(a.app);
    assert.deepEqual(manager.toolOwner("write_note"), { id: a.app.id, name: a.app.name });
    await manager.closeCurrent();
    assert.deepEqual(manager.activeToolDefs(), []);
    assert.equal(manager.hasTool("write_note"), false, "remembering a tool never makes a closed app executable");
    assert.ok(manager.knownToolDefs().some(def => def.name === "write_note"));
    await assert.rejects(manager.call("write_note", { text: "不会执行" }), /没有打开/);
    assert.equal(a.counters.calls, 0);
    const clone = manager.knownToolDefs(); clone[0]!.description = "调用方不能改写目录";
    assert.ok(manager.knownToolDefs().every(def => def.description !== clone[0]!.description));
    blocked = ["write_note"];
    assert.equal(manager.toolOwner("write_note"), null, "another device's currently exposed homonym cannot be mistaken for a phone route");
    blocked = [];

    await manager.open(b.app); await manager.closeCurrent();
    assert.equal(manager.toolOwner("search"), null, "two previously opened applications sharing an exposed name are ambiguous");
    assert.ok(!manager.knownToolDefs().some(def => def.name === "search"));
    assert.deepEqual(manager.toolOwner("find_book"), { id: b.app.id, name: b.app.name });
    assert.equal(b.counters.calls, 0);
    const reopened = new AppManager("聊天", [a.app, b.app], new Set(["send"]), logger, () => [], file);
    const opensBeforeLoad = a.counters.opens + b.counters.opens;
    await reopened.loadToolCatalog();
    assert.deepEqual(reopened.knownToolDefs(), manager.knownToolDefs());
    assert.equal(a.counters.opens + b.counters.opens, opensBeforeLoad, "restart restores only learned definitions without device IO");
    assert.equal(reopened.hasTool("write_note"), false);
    const withoutAlpha = new AppManager("聊天", [b.app], new Set(["send"]), logger, () => [], file);
    await withoutAlpha.loadToolCatalog();
    assert.equal(withoutAlpha.toolOwner("write_note"), null, "uninstalled or disabled apps do not retain a routable cache owner");
    assert.deepEqual(withoutAlpha.toolOwner("search"), { id: b.app.id, name: b.app.name });
    a.available.tools = ["new_note"];
    await reopened.open(a.app);
    assert.equal(reopened.hasTool("write_note"), false);
    assert.equal(reopened.toolOwner("write_note"), null, "actual rediscovery replaces retired tool definitions");
    assert.deepEqual(reopened.toolOwner("new_note"), { id: a.app.id, name: a.app.name });
    await reopened.closeAll();
    assert.deepEqual(reopened.knownToolDefs(), []);
    assert.equal(reopened.toolOwner("new_note"), null, "a stopped manager cannot provide navigation targets for an obsolete world");

    const c = fixtureApp("gamma", ["send", "observe"]);
    const namespaced = new AppManager("聊天", [c.app], new Set(["send"]), logger);
    await namespaced.open(c.app); await namespaced.closeCurrent();
    assert.deepEqual(namespaced.knownToolDefs().map(def => def.name), ["gamma.send", "gamma.observe"]);
    assert.equal(namespaced.toolOwner("send"), null);
    assert.equal(namespaced.toolOwner("observe"), null);
    assert.deepEqual(namespaced.toolOwner("gamma.send"), { id: "gamma", name: c.app.name });
    const invalidPath = path.join(dir, "corrupt.json"); await fs.writeFile(invalidPath, "{broken");
    const corrupt = new AppManager("聊天", [c.app], new Set(), logger, () => [], invalidPath);
    await corrupt.loadToolCatalog();
    assert.deepEqual(corrupt.knownToolDefs(), []);
    assert.ok(warnings.length, "a damaged optional cache is reported without forcing application connections");

    const computerFile = path.join(dir, "computer-tools.json"), terminal = fixtureApp("terminal", ["run_command"]), explorer = fixtureApp("files", ["read_file"]), desktop = fixtureApp("desktop", ["screen"]);
    let real = true, starts = 0;
    const host = { ensureReady: async () => { starts++; return { ok: true }; } } as any;
    const files = { readMeta: async () => ({ realWorld: real }) } as any;
    const clock = { syncRealTime: true } as any;
    const makeComputer = (mode: "docker" | "off" | "remote_desktop", realWorld = true) => new ComputerDevice(terminal.app as any, explorer.app as any, desktop.app as any, host, files, clock, { mode } as any, new Set(), logger, () => [], realWorld, computerFile);
    const computer = makeComputer("docker"); await computer.loadToolCatalog();
    assert.deepEqual(computer.knownToolDefs(), []); assert.equal(starts, 0);
    await computer.open(); await computer.close();
    assert.deepEqual(computer.knownToolDefs().map(def => def.name), ["run_command", "read_file"]);
    assert.ok(!computer.hasTool("run_command"));
    await assert.rejects(computer.call("run_command", { text: "不会执行" }), /没有打开电脑/);
    assert.equal(terminal.counters.calls, 0);
    const resumedComputer = makeComputer("docker"); await resumedComputer.loadToolCatalog();
    assert.deepEqual(resumedComputer.knownToolDefs(), computer.knownToolDefs());
    assert.equal(starts, 1, "restoring computer knowledge cannot start containers");
    const off = makeComputer("off"); await off.loadToolCatalog(); assert.deepEqual(off.knownToolDefs(), []);
    const remote = makeComputer("remote_desktop"); await remote.loadToolCatalog();
    assert.deepEqual(remote.knownToolDefs(), [], "switching implementations must not restore stale tools from a different device mode");
    assert.equal(desktop.counters.opens, 0);
    await remote.open(); await remote.close();
    assert.deepEqual(remote.knownToolDefs().map(def => def.name), ["screen"]);
    real = false;
    const virtual = makeComputer("off", false); await virtual.loadToolCatalog();
    assert.deepEqual(virtual.knownToolDefs(), [], "virtual and real device knowledge have distinct persisted ownership");
    await virtual.open(); await virtual.close();
    assert.deepEqual(virtual.knownToolDefs().map(def => def.name), ["run_command", "read_file"]);
    assert.equal(starts, 1, "learning virtual device tools never starts a real computer");

    // Hidden UI manipulation and character knowledge have separate lifetimes. A human can
    // open a real app without revealing its tool names or replacing the character's memory.
    const secretFile = path.join(dir, "secret-phone-tools.json");
    const familiar = fixtureApp("familiar", ["old_note"]), unseen = fixtureApp("unseen", ["secret_search"]);
    const hiddenPhone = new AppManager("聊天", [familiar.app, unseen.app], new Set(), logger, () => [], secretFile);
    await hiddenPhone.open(familiar.app); await hiddenPhone.closeCurrent();
    const knownBeforeSecret = hiddenPhone.knownToolDefs(), cacheBeforeSecret = await fs.readFile(secretFile, "utf8");
    await hiddenPhone.open(unseen.app, { learn: false });
    assert.ok(hiddenPhone.hasTool("secret_search"), "secret operations still open the real interface for the human");
    assert.deepEqual(hiddenPhone.knownToolDefs(), knownBeforeSecret, "secret first-open must not add any character knowledge");
    assert.equal(hiddenPhone.toolOwner("secret_search"), null);
    assert.equal(await fs.readFile(secretFile, "utf8"), cacheBeforeSecret, "hidden opens must not persist discovered definitions");
    const hiddenRestart = new AppManager("聊天", [familiar.app, unseen.app], new Set(), logger, () => [], secretFile);
    await hiddenRestart.loadToolCatalog();
    assert.deepEqual(hiddenRestart.knownToolDefs(), knownBeforeSecret, "restart cannot reveal an unobserved hidden open");
    await hiddenPhone.learnCurrentTools();
    assert.deepEqual(hiddenPhone.knownToolDefs().map(def => def.name), ["old_note", "secret_search"], "actual observation learns visible definitions while preserving old knowledge");
    assert.deepEqual(hiddenPhone.toolOwner("secret_search"), { id: unseen.app.id, name: unseen.app.name });
    familiar.available.tools = ["new_note"];
    await hiddenPhone.open(familiar.app, { learn: false });
    assert.ok(hiddenPhone.knownToolDefs().some(def => def.name === "old_note"));
    assert.ok(!hiddenPhone.knownToolDefs().some(def => def.name === "new_note"), "a hidden reopen cannot silently replace previously known definitions");
    await hiddenPhone.learnCurrentTools();
    assert.deepEqual(hiddenPhone.knownToolDefs().map(def => def.name), ["new_note", "secret_search"]);
    await hiddenPhone.closeCurrent();
    const afterPhoneLook = await fs.readFile(secretFile, "utf8");
    await hiddenPhone.learnCurrentTools();
    assert.equal(await fs.readFile(secretFile, "utf8"), afterPhoneLook, "learning a closed phone app cannot probe or overwrite its catalog");

    const secretComputerFile = path.join(dir, "secret-computer-tools.json");
    const hiddenTerminal = fixtureApp("terminal", ["old_command"]), hiddenFiles = fixtureApp("files", ["old_file"]);
    const hiddenComputer = new ComputerDevice(hiddenTerminal.app as any, hiddenFiles.app as any, null,
      { ensureReady: async () => ({ ok: true }) } as any, { readMeta: async () => ({ realWorld: true }) } as any,
      clock, { mode: "docker" } as any, new Set(), logger, () => [], true, secretComputerFile);
    await hiddenComputer.open({ learn: false });
    assert.ok(hiddenComputer.hasTool("old_command"));
    assert.deepEqual(hiddenComputer.knownToolDefs(), []);
    await assert.rejects(fs.readFile(secretComputerFile, "utf8"), { code: "ENOENT" }, "a secret first-open does not create a learned cache");
    await hiddenComputer.learnCurrentTools();
    assert.deepEqual(hiddenComputer.knownToolDefs().map(def => def.name), ["old_command", "old_file"]);
    await hiddenComputer.close();
    const knownComputerBeforeSecret = hiddenComputer.knownToolDefs(), computerCacheBeforeSecret = await fs.readFile(secretComputerFile, "utf8");
    hiddenTerminal.available.tools = ["new_command"];
    await hiddenComputer.open({ learn: false });
    assert.deepEqual(hiddenComputer.knownToolDefs(), knownComputerBeforeSecret);
    assert.equal(await fs.readFile(secretComputerFile, "utf8"), computerCacheBeforeSecret);
    await hiddenComputer.learnCurrentTools();
    assert.deepEqual(hiddenComputer.knownToolDefs().map(def => def.name), ["new_command", "old_file"], "seeing the real computer replaces only the rediscovered owner's definitions");
    await hiddenComputer.close();
    const afterComputerLook = await fs.readFile(secretComputerFile, "utf8");
    await hiddenComputer.learnCurrentTools();
    assert.equal(await fs.readFile(secretComputerFile, "utf8"), afterComputerLook);
    await catalogLifecycle(path.join(dir, "world-lifecycle"));
    console.log("PASS learned tool catalogs: observed discovery, stealth isolation, archive/reset knowledge isolation, closed/restarted navigation, live execution checks, ambiguity/uninstall/namespace guards, cloned definitions and computer mode isolation");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
