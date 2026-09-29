/** Run the real growth page against an in-memory DOM; no browser, server or model. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { growthViewText, type GrowthView } from "../src/bot/growth.js";

class Element {
  children: Element[] = [];
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  open = false;
  onclick?: () => void;
  ontoggle?: () => void;
  scrollLeft = 0;
  scrollTop = 0;
  private text = "";
  constructor(readonly tagName: string) {}
  set textContent(text: string) { this.text = String(text); this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_: string) { throw new Error("Growth claims and correction reasons must be rendered as text"); }
  appendChild(child: Element) { this.children.push(child); return child; }
  append(...children: Element[]) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children: Element[]) { this.children = []; this.text = ""; this.append(...children); }
  setAttribute(key: string, value: string) {
    if (key === "class") this.className = value;
    else if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  classList = {
    toggle: (name: string, enabled: boolean) => {
      const classes = new Set(this.className.split(" ").filter(Boolean));
      if (enabled) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(" ");
    },
  };
  addEventListener() {}
  focus() {}
  scrollIntoView() {}
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [child, ...child.querySelectorAll("*")]).filter(node =>
      selector === "*" || (selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1)) :
        selector === "[data-growth-claim]" ? !!node.dataset.growthClaim : node.tagName === selector));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}
function el(tag: string, attrs: Record<string, any> = {}, children: Array<Element | null> = []) {
  const node = new Element(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (key === "cls") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("data-")) node.setAttribute(key, value);
    else (node as any)[key] = value;
  });
  children.filter((child): child is Element => child !== null).forEach(child => node.appendChild(child));
  return node;
}
function fixture(claimId: string, extra: Partial<GrowthView> = {}): GrowthView {
  return { claimId, kind: "state", subject: "测试角色", statement: `记录 ${claimId}`, active: true, status: "tentative", records: [], evidence: [], ...extra };
}
const quarantined = fixture("isolated", { needsReview: true, expiresAt: 99999 });
const correction = { type: "growth_corrected" as const, id: "audit-correction", actorId: "fixture", claimId: "corrected", recordId: "original-record", subject: "测试角色", statement: "旧判断", at: 500, evidenceIds: [], reason: "原判断把不同频道的线索混在一起。<img src=invalid>" };
const corrected = fixture("corrected", { active: false, needsReview: true, inactiveReason: "corrected", correction });
const rows = [quarantined, corrected, fixture("current"), fixture("expired", { active: false, inactiveReason: "expired" })];
const status = {
  pending: 0, deferred: 0, reviews: 1, rejected: 0, failures: 0, isolations: 1, corrections: 1, recent: [],
  recentCorrections: [correction],
  recentIsolations: [{ id: "audit-isolation", at: 400, claims: [{ claimId: "isolated", recordId: "old-record", reason: "原记录没有可信频道范围。" }] }],
};

async function page(visitor: boolean) {
  const routes: Record<string, (holder: Element) => () => void> = {}, events: Record<string, () => void> = {};
  const holder = el("main");
  let requests = 0;
  runInNewContext(readFileSync("src/webui/client/world.js", "utf8"), {
    el, document: { createElementNS: (_namespace: string, tag: string) => el(tag), hidden: false },
    window: { addEventListener: (event: string, listener: () => void) => { events[event] = listener; }, removeEventListener() {} },
    setInterval() {}, clearInterval() {}, setTimeout, clearTimeout, isVisitor: () => visitor,
    api: async (_method: string, url: string) => { assert.equal(url, "/api/bot/growth/status"); requests++; return status; },
    Studio: {
      register: (name: string, mount: (holder: Element) => () => void) => { routes[name] = mount; },
      title: () => el("header"), fetchGrowthPage: async (query: any) => {
        const scoped = rows.filter(row => (query.lifecycle === "all" || (query.lifecycle === "active") === (!row.needsReview && row.active && !row.correction)) && (!query.keyword || [row.subject, row.statement].join(" ").includes(query.keyword)));
        const found = scoped.filter(row => query.kind === "all" || query.kind === "long_term" && row.kind !== "state" || query.kind === row.kind);
        return { items: found.slice(query.offset, query.offset + query.limit), total: found.length, offset: query.offset, limit: query.limit, counts: { state: scoped.length } };
      },
      button: (label: string, _icon: unknown, onclick: () => void) => el("button", { text: label, onclick }),
      section: (title: string) => el("h3", { text: title }), empty: (title: string) => el("p", { text: title }),
      error: (_holder: unknown, error: Error) => { throw error; },
    },
  });
  const dispose = routes.growth!(holder);
  await new Promise<void>(done => setImmediate(done));
  const click = async (label: string) => {
    const button = holder.querySelectorAll("button").find(node => node.textContent === label);
    assert.ok(button, `Missing button: ${label}`); button.onclick!(); await new Promise<void>(done => setImmediate(done));
  };
  return { holder, click, dispose, requests: () => requests, refresh: async () => { events["studio:refresh"]!(); await new Promise<void>(done => setImmediate(done)); } };
}

async function main() {
  const p = await page(false);
  assert.equal(p.holder.querySelectorAll(".growth-claim").length, 0, "Historical states are not the default long-term view");
  assert.match(p.holder.querySelector(".growth-empty")!.textContent, /当前筛选没有匹配记录/);
  await p.click("全部类型"); await p.click("全部历史");
  assert.equal(p.holder.querySelectorAll(".growth-claim").length, 4, "All original records remain accessible");
  p.holder.querySelectorAll(".growth-claim").find(node => node.dataset.growthClaim === "isolated")!.onclick!();
  assert.match(p.holder.querySelector(".growth-lifecycle")!.textContent, /^待复核 · 已隔离 · 原记录期限/);
  assert.match(p.holder.querySelector(".growth-claim-isolation")!.textContent, /暂不用于自动回忆及当前行为判断/);
  assert.ok(p.holder.querySelectorAll(".growth-claim")[0]!.className.includes("inactive"));
  assert.match(p.holder.querySelector(".growth-correction-summary")!.textContent, /隔离审计 1 批.*已撤回 1 项/);
  assert.match(p.holder.querySelector(".growth-isolation-audit")!.textContent, /旧版本隔离记录.*audit-isolation/);
  const disclosure = p.holder.querySelector(".growth-review-disclosure")!;
  disclosure.open = true; disclosure.ontoggle!();
  await p.click("当前有效");
  assert.deepEqual(p.holder.querySelectorAll(".growth-claim").map(node => node.dataset.growthClaim), ["current"]);
  assert.equal(p.holder.querySelector(".growth-review-disclosure")!.open, true, "Audit disclosure survives page redraw");
  await p.click("未在沿用");
  assert.deepEqual(p.holder.querySelectorAll(".growth-claim").map(node => node.dataset.growthClaim), ["isolated", "corrected", "expired"]);
  p.holder.querySelectorAll(".growth-claim").find(node => node.dataset.growthClaim === "corrected")!.onclick!();
  assert.equal(p.holder.querySelector(".growth-lifecycle")!.textContent, "已撤回", "Withdrawal takes precedence over quarantine");
  assert.match(p.holder.querySelector(".growth-claim-correction")!.textContent, /不再指导行为.*原判断把不同频道.*original-record.*audit-correction/);
  assert.ok(!p.holder.querySelector("img"), "Untrusted correction text cannot create HTML");
  await p.refresh();
  assert.equal(p.holder.querySelector(".growth-lifecycle")!.textContent, "已撤回");
  p.dispose();

  const visitor = await page(true);
  assert.equal(visitor.requests(), 0, "Visitor page never requests the administrator-only audit endpoint");
  assert.equal(visitor.holder.querySelector(".growth-review-status"), null);
  await visitor.click("全部类型"); await visitor.click("全部历史");
  visitor.holder.querySelectorAll(".growth-claim").find(node => node.dataset.growthClaim === "isolated")!.onclick!();
  assert.match(visitor.holder.querySelector(".growth-lifecycle")!.textContent, /^待复核/);
  visitor.dispose();

  const quote = '我喜欢在窗边读书。<img src=invalid>';
  rows.push(fixture("learned", { kind: "preference", statement: "自然光让我更愿意阅读", insight: {
    dimension: "阅读环境", significance: "安排独处阅读时，会优先寻找自然光充足的位置。", anchors: [{ eventId: "read-by-window", quote }],
  }, evidence: [{ eventId: "read-by-window", actorId: "fixture", source: "world", observedAt: 12, rootEventIds: ["reading-choice"], text: "我拿起书说：" + quote }] }));
  const insightPage = await page(false);
  assert.equal(insightPage.holder.querySelector(".growth-insight-dimension")!.textContent, "阅读环境");
  assert.match(insightPage.holder.querySelector(".growth-insight-significance")!.textContent, /优先寻找自然光/);
  assert.equal(insightPage.holder.querySelector(".growth-insight-quote")!.textContent, quote);
  insightPage.holder.querySelector(".growth-insight-anchor")!.onclick!();
  assert.match(insightPage.holder.querySelector(".growth-evidence-detail")!.textContent, /我拿起书说.*read-by-window/);
  assert.equal(insightPage.holder.querySelector("img"), null, "Evidence quotes remain text, never HTML");
  await insightPage.click("临时状态");
  assert.equal(insightPage.holder.querySelector(".growth-insight"), null, "Old entries without insight do not acquire invented explanations");
  assert.match(insightPage.holder.querySelector(".growth-lifecycle")!.textContent, /期限内 · 仅留档/);
  assert.match(insightPage.holder.querySelector(".growth-detail")!.textContent, /原记录尚在期限内.*不作为长期成长或当前行为依据/);
  insightPage.dispose();

  assert.match(growthViewText(quarantined), /^【待复核，已隔离，不作为当前事实或行动依据】/);
  assert.match(growthViewText(quarantined), /原记录期限/);
  assert.doesNotMatch(growthViewText(quarantined), /仅适用于世界时刻/);
  assert.match(growthViewText(corrected), /^【已撤回，不作为当前事实或行动依据】/);
  assert.match(growthViewText(corrected), /撤回原因：原判断把不同频道/);
  assert.match(growthViewText(rows[3]!), /已过期/);
  assert.doesNotMatch(growthViewText(rows[2]!), /隔离|撤回|已过期/);
  console.log("PASS growth presentation: quarantine/withdrawal labels, filters, reasons, readable insight, clickable literal anchors, audit access and explicit recall text");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
