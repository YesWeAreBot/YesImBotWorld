/** Real member-header rendering in a small DOM. No platform, browser, or model calls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Config } from "../src/config.js";
import { resolveGroupMemberTitle } from "../src/koishi/sender-tags.js";
import { introspect, type SchemaNode } from "../src/webui/schema.js";

class Element {
  children: Element[] = [];
  open = false;
  events: Record<string, () => void> = {};
  constructor(readonly tag: string, readonly attrs: Record<string, any> = {}) {
    assert.equal(attrs.html, undefined, "Member metadata must never be interpreted as HTML");
  }
  get textContent(): string { return String(this.attrs.text || "") + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_: string) { throw new Error("No metadata HTML"); }
  appendChild(child: Element) { this.children.push(child); return child; }
  append(...children: Element[]) { children.forEach(child => this.appendChild(child)); }
  addEventListener(event: string, listener: () => void) { this.events[event] = listener; }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  find(cls: string): Element | undefined { return this.all().find(node => String(node.attrs.cls || "").split(" ").includes(cls)); }
}
function el(tag: string, attrs: Record<string, any> = {}, children: Element[] = []) {
  const node = new Element(tag, attrs); node.append(...children); return node;
}
const source = readFileSync("src/webui/client/devices.js", "utf8");
new vm.Script(source);
const sandbox: any = { el, timeLabel: () => "12:34" };
vm.runInNewContext(source.slice(source.indexOf("function chatMemberPresentation("), source.indexOf("function appKind(")), sandbox);
const message = { username: "小明", userId: "123", timestamp: 1, memberMetadata: { role: "owner", specialTitle: '<img src=x onerror="alert(1)">大魔王', levelTitle: "潜水", level: "7" } };
const header = (presentation?: any, expanded = false, onToggle?: (open: boolean) => void): Element => sandbox.chatMemberHeader(message, presentation, expanded, onToggle);

const normal = header();
assert.equal(normal.find("app-message-name")?.textContent, "小明");
assert.equal(normal.find("app-member-badge-title"), undefined);
assert.equal(normal.find("app-member-role-indicator")?.attrs["aria-label"], "群身份：群主");
assert.ok(normal.find("app-member-role-owner"));
assert.equal(normal.find("app-member-details")?.open, false);
assert.equal(normal.find("app-member-details-body")!.textContent, "头衔" + message.memberMetadata.specialTitle);
assert.equal(normal.all().some(node => node.tag === "img"), false);

// A role and a unique platform title are independent facts; source visibility
// never brings back a lower-priority title overwritten by the platform.
for (const role of ["inline", "on_demand", "hidden"]) for (const specialTitle of ["inline", "on_demand", "hidden"]) for (const levelTitle of ["inline", "on_demand", "hidden"]) {
  const modes = { role, specialTitle, levelTitle }, node = header(modes), details = node.find("app-member-details-body")?.textContent || "";
  assert.equal(!!node.find("app-member-badge-title"), specialTitle === "inline");
  assert.equal(details.includes(message.memberMetadata.specialTitle), specialTitle === "on_demand");
  assert.equal(node.textContent.includes(message.memberMetadata.specialTitle), specialTitle !== "hidden");
  assert.equal(details.includes("群身份群主"), role === "on_demand");
  assert.equal(!!node.find("app-member-role-owner"), role === "inline");
  assert.equal(!!node.find("app-member-role-indicator"), role === "inline" && specialTitle !== "inline");
  assert.equal(node.all().some(n => String(n.attrs["aria-label"] || "").includes("群身份：群主")), role === "inline");
  assert.equal(node.textContent.includes("潜水"), false);
  assert.equal(node.textContent.includes("等级 7"), false);
  assert.equal(node.find("app-message-name")?.textContent, "小明");
  assert.ok(node.all().filter(n => n.attrs.cls?.split(" ").includes("app-member-badge-title")).length <= 1);
}
const changes: boolean[] = [], expanded = header(undefined, true, value => changes.push(value));
const details = expanded.find("app-member-details")!;
assert.equal(details.open, true, "A refreshed message preserves the user's expanded member details");
details.open = false; details.events.toggle!(); assert.deepEqual(changes, [false]);
const render = (memberMetadata: any, presentation?: any): Element => sandbox.chatMemberHeader({ username: "昵称", memberMetadata }, presentation);
for (const [role, title] of [["owner", "群主"], ["admin", "管理员"]]) {
  const fallback = render({ role, specialTitle: "", levelTitle: "潜水" });
  assert.equal(fallback.find("app-member-badge-title")?.textContent, title);
  assert.ok(fallback.find("app-member-role-" + role));
  assert.equal(fallback.textContent.includes("潜水"), false);
  const missing = render({ role, levelTitle: "潜水" });
  assert.equal(missing.find("app-member-badge-title"), undefined, "An absent special-title field is not evidence of its absence");
  assert.ok(missing.find("app-member-role-indicator"));
  const quiet = render({ role, specialTitle: "", levelTitle: "潜水" }, { role: "on_demand", levelTitle: "inline" });
  assert.equal(quiet.find("app-member-badge-title"), undefined);
  assert.equal(quiet.find("app-member-details-body")?.textContent, "群身份与头衔" + title);
  const hidden = render({ role, specialTitle: "", levelTitle: "潜水" }, { role: "hidden", levelTitle: "inline" });
  assert.equal(hidden.textContent, "昵称", "Hiding the winning role title cannot expose the overwritten level title");
}
const adminSpecial = render({ role: "admin", specialTitle: "摸鱼冠军", levelTitle: "潜水" }, { specialTitle: "inline" });
assert.equal(adminSpecial.find("app-member-badge-title")?.textContent, "摸鱼冠军");
assert.ok(adminSpecial.find("app-member-role-admin"));
assert.equal(adminSpecial.textContent.includes("管理员"), false, "The role is conveyed through color and accessibility metadata, not a second title");
const neutralSpecial = render({ role: "admin", specialTitle: "摸鱼冠军" }, { role: "hidden", specialTitle: "inline" });
assert.equal(neutralSpecial.find("app-member-badge-title")?.textContent, "摸鱼冠军");
assert.equal(neutralSpecial.find("app-member-role-admin"), undefined);
assert.equal(neutralSpecial.find("app-member-badge-title")?.attrs["aria-label"], "头衔：摸鱼冠军");
const member = render({ role: "member", specialTitle: "" });
assert.equal(member.find("app-member-role-indicator"), undefined, "Ordinary members need no repetitive identity mark");
assert.equal(member.find("app-member-details"), undefined);
const level = render({ role: "member", specialTitle: "", levelTitle: "潜水", level: "7" }, { levelTitle: "inline" });
assert.equal(level.find("app-member-badge-title")?.textContent, "潜水");
assert.equal(level.textContent.includes("7"), false);
assert.equal(render({ role: "member", levelTitle: "潜水" }, { levelTitle: "inline" }).find("app-member-badge-title"), undefined);
assert.equal(render({ specialTitle: "", levelTitle: "潜水" }, { levelTitle: "inline" }).find("app-member-badge-title"), undefined, "A level title alone does not prove this sender is an ordinary member");
const absent = render({});
assert.equal(absent.textContent, "昵称", "Missing platform data is not an inferred role or title");
const numeric = render({ role: "member", specialTitle: "", level: "0" }, { levelTitle: "inline" });
assert.equal(numeric.find("app-member-badge-title"), undefined, "A numeric level is not a platform title");
// The browser's projection must agree with the server's LLM metadata projection.
for (const role of [undefined, "owner", "admin", "member"] as const) {
  for (const specialTitle of [undefined, "", " ", "摸鱼冠军", " 摸鱼冠军 "]) {
    for (const levelTitle of [undefined, "", "潜水", " 潜水 "]) {
      const data = { role, specialTitle, levelTitle, level: "7" }, ui = sandbox.chatMemberPresentation(data), expected = resolveGroupMemberTitle(data);
      assert.deepEqual(ui.title ? { title: ui.title, source: ui.source } : undefined, expected);
    }
  }
}
const css = readFileSync("src/webui/client/devices.css", "utf8");
assert.match(css, /\.app-member-role-owner\s*\{[^}]*background:/);
assert.match(css, /\.app-member-role-admin\s*\{[^}]*background:/);

function find(node: SchemaNode, key: string): SchemaNode | undefined {
  return node.key === key ? node : node.children?.map(child => find(child, key)).find(Boolean);
}
const group = find(introspect(Config), "groupMetadata");
assert.ok(group, "Settings are reachable through the actual WebUI schema");
for (const key of ["role", "specialTitle", "levelTitle"]) {
  const setting = group.children!.find(node => node.key === key)!;
  assert.equal(setting.type, "select");
  assert.deepEqual(setting.options!.map(option => option.value).sort(), ["hidden", "inline", "on_demand"]);
  assert.ok(setting.options!.every(option => option.description), "Choices have readable labels");
}
const legacy = readFileSync("src/webui/client/legacy.js", "utf8");
assert.match(legacy, /messaging: \[[^\n]*'groupMetadata'/, "Group metadata is visible in main messaging settings");
assert.match(source, /messages, chat\.memberPresentation, session\.notifications/, "Changed settings refresh existing WebUI messages");
console.log("PASS member UI: one platform title, independent role color, visibility after title precedence, safe on-demand details, honest missing data, and schema-backed settings");
