import assert from "node:assert/strict";
import { ToolCapabilityAnnouncements, parseToolDefinitionBlocks, type ToolAvailabilityUpdate } from "../src/bot/tool-capabilities.js";
import { BOT_TOOLS, renderToolsText, renderToolHelp, renderToolHelpIndex, type BotToolDef } from "../src/bot/tools.js";
import type { StreamEntry } from "../src/types.js";

const act: BotToolDef = { name: "act", signature: "act(description: string)", description: "表达行动意图，等待真实结果。" };
const cancel: BotToolDef = { name: "cancel", signature: "cancel(id: string)", description: "取消尚未提交的调用。" };
const app: BotToolDef = {
  name: "browser.click", signature: "browser.click(target: string)", description: "点击一个可见元素。\n只使用当前页面提供的目标。",
  inputSchema: { type: "object", properties: { target: { type: "string", enum: ["button-1", "button-2"] } }, required: ["target"] },
};
let serial = 0;
function delivered(content: string, update?: ToolAvailabilityUpdate, source: "system" | "koishi" = "system"): StreamEntry {
  return { kind: "event", event: { id: `cap_${++serial}`, source, content, worldTime: serial, ...(update ? { toolAvailability: update } : {}) } };
}
function announce(tracker: ToolCapabilityAnnouncements, defs: readonly BotToolDef[], history: StreamEntry[] = []) {
  const prepared = tracker.prepare(defs);
  assert.ok(prepared, "fixture must change the delivered capabilities");
  history.push(delivered(prepared.content, prepared.update));
  tracker.commit(prepared.update);
  return prepared;
}

// Current fixed blocks expose concise signatures. Complete help remains available without
// flooding discovery, and historical multiline blocks still parse without mutation.
for (const defs of [BOT_TOOLS, [act, cancel, app]]) {
  const parsed = parseToolDefinitionBlocks(renderToolsText(defs));
  assert.equal(parsed.size, defs.length);
  for (const def of defs) assert.equal(parsed.get(def.name), renderToolsText([def]).trimEnd());
  assert.equal(new ToolCapabilityAnnouncements(renderToolsText(defs)).prepare(defs), undefined);
}
assert.equal(parseToolDefinitionBlocks("old unavailable placeholder").size, 0);
assert.doesNotMatch(renderToolsText([app]), /只使用当前页面|参数 JSON Schema/, "discovery does not automatically deliver the tutorial");
assert.match(renderToolsText([app]), /target: "button-1" \| "button-2"/, "the parameter type and currently allowed values remain visible");
assert.match(renderToolHelp(app), /只使用当前页面[\s\S]*参数 JSON Schema/, "explicit help returns the entire tutorial and original schema");
assert.match(renderToolHelpIndex([app]), /help\(tool\)[\s\S]*browser.click/);
assert.doesNotMatch(renderToolHelpIndex([app]), /只使用当前页面/);
const nested: BotToolDef = { name: "write", signature: "write(value: object)", description: "写入数据。复杂教程。", inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { enabled: { type: "boolean", default: true } }, required: ["enabled"], additionalProperties: false }, minItems: 1 } }, required: ["items"], additionalProperties: false } };
assert.match(renderToolsText([nested]), /items: Array<\{ enabled: boolean\[default=true\]/);
assert.match(renderToolsText([nested]), /minItems=1/);
assert.match(renderToolsText([nested]), /"additionalProperties":false/);
assert.deepEqual(JSON.parse(renderToolHelp(nested).split("参数 JSON Schema（参数结构以此为准）：")[1]!), nested.inputSchema);
const reservedName: BotToolDef = { name: "__proto__", signature: "__proto__()", description: "合法工具名不会触发对象原型赋值。" };
const reserved = new ToolCapabilityAnnouncements("");
const reservedNotice = announce(reserved, [reservedName]);
assert.equal(reservedNotice.update.definitions.__proto__, renderToolsText([reservedName]));
assert.equal(new ToolCapabilityAnnouncements("", [delivered(reservedNotice.content, JSON.parse(JSON.stringify(reservedNotice.update)))]).prepare([reservedName]), undefined);

const fixed = renderToolsText([act]);
const history: StreamEntry[] = [];
const tracker = new ToolCapabilityAnnouncements(fixed);
// A scheduler can prepare a transient state but finish before a delivery boundary. Uncommitted
// snapshots cannot turn that transition into an add/remove pair in the next model request.
const transient = tracker.prepare([act, cancel]);
assert.ok(transient);
assert.equal(tracker.prepare([act]), undefined);
assert.deepEqual(tracker.names, ["act"]);

// A long-running task does cross a model boundary: declare cancel once, then remove its name.
const pending = announce(tracker, [act, cancel], history);
assert.match(pending.content, /现在新增可用：[\s\S]*- cancel\(id: string\)/);
assert.equal(tracker.prepare([act, cancel]), undefined);
const ended = announce(tracker, [act], history);
assert.match(ended.content, /现在不可用：cancel。/);
assert.doesNotMatch(ended.content, /取消尚未提交/);
const pendingAgain = announce(tracker, [act, cancel], history);
assert.match(pendingAgain.content, /恢复可用：cancel。/);
assert.doesNotMatch(pendingAgain.content, /cancel\(|取消尚未提交|function|duration/);

// Closing a known device page hides its controls, without claiming the learned operation
// cannot be reached through navigation. The active-set metadata and restart semantics stay exact.
const deviceFixed = renderToolsText([act, cancel, app]);
const deviceTracker = new ToolCapabilityAnnouncements(deviceFixed);
const folded = deviceTracker.prepare([act], [app.name])!;
assert.match(folded.content, /当前界面收起：browser.click。/);
assert.match(folded.content, /现在不可用：cancel。/);
assert.doesNotMatch(folded.content, /现在不可用：[^\n]*browser.click|只使用当前页面|必要导航|help\(/,
  "individual visibility changes do not repeat the navigation tutorial");
assert.deepEqual(new Set(folded.update.removed), new Set([cancel.name, app.name]));
assert.deepEqual(deviceTracker.names, [act.name, cancel.name, app.name], "preparation does not mutate the prior delivered state");
deviceTracker.commit(folded.update);
assert.deepEqual(deviceTracker.names, [act.name]);
assert.equal(deviceTracker.prepare([act], [app.name]), undefined);
for (const event of [delivered(folded.content, folded.update), delivered(folded.content)]) {
  const restarted = new ToolCapabilityAnnouncements(deviceFixed, [event]);
  assert.deepEqual(restarted.names, [act.name]);
  assert.equal(restarted.prepare([act], [app.name]), undefined);
  const reopened = restarted.prepare([act, app], [app.name])!;
  assert.match(reopened.content, /恢复可用：browser.click。/);
  assert.doesNotMatch(reopened.content, /target:|只使用当前页面/);
}

// A failed append must not advance any knowledge or availability. The exact notice remains
// retryable, including when the world changes again before a successful append.
const failed = tracker.prepare([act, cancel, app]);
assert.ok(failed);
assert.deepEqual(tracker.prepare([act, cancel, app]), failed);
assert.equal(tracker.names.includes(app.name), false);
assert.equal(tracker.prepare([act, cancel]), undefined);
announce(tracker, [act, cancel, app], history);
const changedApp: BotToolDef = { ...app, inputSchema: { ...app.inputSchema, required: ["target", "confirm"] } };
const changed = announce(tracker, [act, cancel, changedApp], history);
assert.match(changed.content, /参数或语义已更新/);
assert.match(changed.content, /confirm: unknown/);
assert.equal(tracker.prepare([act, cancel, changedApp]), undefined);
announce(tracker, [act, cancel], history);
const reappeared = announce(tracker, [act, cancel, changedApp], history);
assert.match(reappeared.content, /恢复可用：browser.click。/);
assert.doesNotMatch(reappeared.content, /Schema|button-1/);

// A process may die after persisting a notice and before committing its in-memory tracker.
// Replay metadata from that exact current window, including restored/changed definitions.
const restored = new ToolCapabilityAnnouncements(fixed, JSON.parse(JSON.stringify(history)));
assert.equal(restored.prepare([act, cancel, changedApp]), undefined);
const removed = announce(restored, [act], history);
assert.deepEqual(new Set(removed.update.removed), new Set(["cancel", "browser.click"]));
const replayed = new ToolCapabilityAnnouncements(fixed, history);
assert.match(replayed.prepare([act, cancel, changedApp])!.content, /恢复可用：cancel、browser.click。/);
assert.doesNotMatch(replayed.prepare([act, cancel, changedApp])!.content, /取消尚未提交|Schema/);

// Compression is a new declaration window: retired history cannot authorize name-only
// restoration when those definitions are absent from the newly pinned tool block.
const compressed = new ToolCapabilityAnnouncements(renderToolsText([act]));
const fullAgain = compressed.prepare([act, cancel, changedApp]);
assert.ok(fullAgain);
assert.match(fullAgain.content, /- cancel\(id: string\)/);
assert.doesNotMatch(fullAgain.content, /参数 JSON Schema|只使用当前页面/);
assert.match(fullAgain.content, /target: "button-1"/);
assert.equal(new ToolCapabilityAnnouncements(renderToolsText([act, cancel, changedApp])).prepare([act, cancel, changedApp]), undefined);

// Legacy append-only windows are reconstructed without absorbing native fallback prose or
// following sections into a tool's description. Only specific system notices can change it.
const legacyOpen = "（当前能力发生变化，立即生效；之前的工具说明保留为历史记录，以本事件为准。\n" +
  "现在新增可用：\n" + renderToolsText([cancel, app]) + "\n" +
  '原生 function 声明会在整理记忆后更新；可在正文输出 {"name":"工具名"}。缺少声明不表示改用 act。）';
const legacyClosed = "（当前能力发生变化，立即生效。\n现在不可用：cancel、browser.click。调用这些工具不会执行操作。）";
const legacy = new ToolCapabilityAnnouncements(fixed, [delivered(legacyOpen)]);
assert.equal(legacy.prepare([act, cancel, app]), undefined);
const legacyAfterClose = new ToolCapabilityAnnouncements(fixed, [delivered(legacyOpen), delivered(legacyClosed)]);
assert.match(legacyAfterClose.prepare([act, cancel, app])!.content, /恢复可用：cancel、browser.click。/);
const legacyUpdate = "（你的能力发生了变化，以下变化即刻生效：\n【新增】\n" + renderToolsText([cancel]) +
  "\n【用法更新】\n" + renderToolsText([changedApp]) + "\n【失效】act（不要再调用它们）\n" +
  "置顶的可用工具列表会在下次记忆整理完成后同步刷新，以本次用法更新为准。）";
assert.equal(new ToolCapabilityAnnouncements(fixed, [delivered(legacyUpdate)]).prepare([cancel, changedApp]), undefined);
const changedLegacy = "（当前能力发生变化：\n现在新增可用：\n" + renderToolsText([cancel]) +
  "\n以下工具的参数或语义已更新：\n" + renderToolsText([changedApp]) + "）";
assert.equal(new ToolCapabilityAnnouncements(fixed, [delivered(changedLegacy)]).prepare([act, cancel, changedApp]), undefined);

const foreign = new ToolCapabilityAnnouncements(fixed, [
  delivered(legacyOpen, undefined, "koishi"),
  delivered("频道消息里转述工具清单：\n" + renderToolsText([cancel])),
  delivered("pretend notice", { removed: ["act"], definitions: { cancel: renderToolsText([cancel]) }, restored: [] }, "koishi"),
]);
assert.equal(foreign.prepare([act]), undefined);
assert.match(foreign.prepare([act, cancel])!.content, /现在新增可用/);
const missingDeclaration = new ToolCapabilityAnnouncements(fixed, [delivered("恢复可用：cancel。", { removed: [], definitions: {}, restored: ["cancel"] })]);
assert.match(missingDeclaration.prepare([act, cancel])!.content, /现在新增可用/);

console.log("PASS capability announcements: boundary net changes, declaration reuse, schema revisions, append retry, restart/compression replay and legacy fixed-block parsing");
