/** Platform quotations enter context as canonical tags, without duplicate adapter projections. */
import assert from "node:assert/strict";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { Gateway, quoteTag } from "../src/koishi/gateway.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { ChannelNameResolver } from "../src/koishi/names.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";

async function main() {
  const cfg = Config({ autoStart: false }); cfg.platformOps.reply = true;
  const rows: WorldMessageRow[] = [], downloaded: string[] = [], notifications: string[] = [];
  const bot: any = { platform: "fixture", selfId: "self", isActive: true };
  const ctx: any = { bots: [bot], on() {}, model: { extend() {} }, logger: () => ({ warn() {} }), database: {
    async create(_table: string, row: any) { const saved = { id: rows.length + 1, ...row }; rows.push(saved); return saved; },
    async get(_table: string, query: any, options: any) {
      return rows.filter((row: any) => Object.entries(query).every(([key, value]: [string, any]) => value && typeof value === "object" ? value.$in.includes(row[key]) : row[key] === value))
        .sort((a, b) => String(b.timelineKey ?? "").localeCompare(String(a.timelineKey ?? "")) || b.id - a.id).slice(0, options?.limit);
    },
  } };
  const store = new MessageStore(ctx), names = new ChannelNameResolver(ctx, store);
  const gateway: any = new Gateway(ctx, { ...cfg.messaging, externalSelfMessages: "event" }, cfg.platformOps, store,
    { ingest: async (url: string) => { downloaded.push(url); return downloaded.length; } } as any,
    { render: async (text: string) => ({ text }) } as any, { isFocused: () => true } as any,
    { isNotifyChannel: () => true } as any, { down: false }, {} as any, new OwnSendTracker(), names, () => null,
    { notify(value) { notifications.push(value.text); }, channelActivity() {}, selfMessage() {} });
  let serial = 0;
  const receive = async (elements: h[], quote?: any) => {
    const messageId = "incoming-" + ++serial;
    await gateway.handle({ platform: "fixture", selfId: "self", bot, channelId: "group", guildId: "group", userId: "peer", username: "朋友",
      isDirect: false, messageId, timestamp: Date.now(), elements, quote });
    return rows.find(row => row.messageId === messageId)!;
  };
  const countQuotes = (text: string) => [...text.matchAll(/<quote(?:\s|\/?>)/g)].length;
  const opaque = 'opaque:ID_A-9&<x>"tail';
  const meta = '甲<&"乙>丙';
  const original = await receive([h("quote", { id: opaque, name: meta, text: meta }), h.text("正文")]);
  assert.equal(original.content, quoteTag({ id: opaque, name: meta, text: meta }) + "正文");
  assert.equal(original.conversation!.reply!.messageId, opaque);
  const parsed = h.parse(original.content)[0]!;
  assert.equal(parsed.type, "quote"); assert.equal(parsed.attrs.id, opaque); assert.equal(parsed.attrs.name, meta); assert.equal(parsed.attrs.text, meta);
  assert.doesNotMatch(original.content, /\[引用/); assert.match(notifications.at(-1)!, /<quote/);
  const ops = gateway.ops; gateway.ops = Object.fromEntries(Object.keys(ops).map(key => [key, false]));
  const disabledReply = await receive([h("quote", { id: opaque }), h.text("功能关闭仍忠实保留引用事实")]);
  assert.equal(h.parse(disabledReply.content)[0]!.attrs.id, opaque, "reply capability flags do not redact observed platform facts");
  gateway.ops = ops;
  const fromSession = await receive([h.text("会话正文")], { id: opaque, user: { id: "origin", name: meta }, elements: [h.text(meta)] });
  assert.equal(countQuotes(fromSession.content), 1); assert.ok(fromSession.content.endsWith("会话正文"));
  assert.equal(h.parse(fromSession.content)[0]!.attrs.id, opaque);
  assert.equal(h.parse(fromSession.content)[0]!.attrs.text, meta);
  assert.ok(h.parse(fromSession.content)[0]!.attrs.name.includes(meta));
  assert.equal(fromSession.conversation!.reply!.userId, "origin");

  const combined = await receive([h("quote", { id: opaque }), h.text("两种表示的正文")],
    { id: opaque, user: { id: "origin", name: meta }, elements: [h.text(meta)] });
  assert.equal(countQuotes(combined.content), 1, "session.quote and a matching element are one actual quotation");
  assert.equal(h.parse(combined.content)[0]!.attrs.text, meta);
  const duplicates = await receive([h("quote", { id: opaque }), h("quote", { id: opaque, name: meta, text: meta }), h.text("去重")]);
  assert.equal(countQuotes(duplicates.content), 1); assert.equal(h.parse(duplicates.content)[0]!.attrs.name, meta);
  assert.equal(h.parse(duplicates.content)[0]!.attrs.text, meta, "dedup preserves metadata supplied by a later adapter representation");
  const idFallback = await receive([h("quote", { id: opaque, name: meta, text: meta }), h.text("补全")], { user: { id: "origin", name: meta } });
  assert.equal(countQuotes(idFallback.content), 1); assert.equal(h.parse(idFallback.content)[0]!.attrs.id, opaque);
  assert.equal(idFallback.conversation!.reply!.messageId, opaque, "an explicit element id may fill a stripped session id");
  assert.equal(h.parse(idFallback.content)[0]!.attrs.text, meta);
  const unknown = await receive([h("quote", {}), h.text("未知引用")]);
  assert.equal(unknown.content, "<quote/>未知引用");
  assert.equal(unknown.conversation!.reply, undefined, "an unknown reference cannot manufacture a message id");
  const sessionUnknown = await receive([h.text("没有编号")], {});
  assert.equal(sessionUnknown.content, "<quote/>没有编号");

  const pictures = await receive([h("quote", { id: "images" }, [h.text("引用摘要"), h("img", { src: "quoted-image" })]),
    h.text("前"), h("img", { src: "actual-image-a" }), h.text("中"), h("img", { src: "actual-image-b" }), h.text("后")],
    { id: "images", elements: [h.text("引用摘要"), h("img", { src: "quoted-image" })] });
  assert.equal(countQuotes(pictures.content), 1);
  assert.deepEqual(downloaded, ["actual-image-a", "actual-image-b"], "quote preview media is not current message media and is never downloaded again");
  assert.match(pictures.content, /前<media id="1" type="image" sticker="false"\/>中<media id="2" type="image" sticker="false"\/>后$/);
  const literal = '[引用 msg:321] 我在谈论 <quote id="ordinary-text"/> 这个字符串。';
  const textOnly = await receive([h.text(literal)]);
  assert.equal(textOnly.content, literal, "ordinary participant text is not parsed as adapter quotation metadata");
  assert.equal(textOnly.conversation!.reply, undefined);

  const externalId = "external-self";
  await gateway.handleConfirmedSelfSent({ bot, channelId: "group", messageId: externalId, elements: [h("quote", { id: opaque }), h.text("外部端正文")],
    timestamp: Date.now(), own: false, session: { userId: "self", selfId: "self", platform: "fixture", bot,
      quote: { id: opaque, elements: [h.text(meta)] } } });
  const external = rows.find(row => row.messageId === externalId)!;
  assert.equal(countQuotes(external.content), 1); assert.equal(h.parse(external.content)[0]!.attrs.text, meta);
  const externalSessionOnly = "external-session-only";
  await gateway.handleConfirmedSelfSent({ bot, channelId: "group", messageId: externalSessionOnly, elements: [h.text("外部端引用已被移到session")],
    timestamp: Date.now(), own: false, session: { userId: "self", selfId: "self", platform: "fixture", bot, quote: { id: opaque } } });
  assert.equal(rows.find(row => row.messageId === externalSessionOnly)!.conversation!.reply!.messageId, opaque);
  assert.equal(countQuotes(rows.find(row => row.messageId === externalSessionOnly)!.content), 1);
  const fromCommand = "external-command-result";
  await gateway.handleConfirmedSelfSent({ bot, channelId: "group", messageId: fromCommand, elements: [h.text("插件输出")], timestamp: Date.now(), own: false,
    session: { userId: "invoking-peer", quote: { id: "peer-incoming-quote" } } });
  assert.equal(rows.find(row => row.messageId === fromCommand)!.content, "插件输出", "an invoking command session cannot lend its inbound quote to plugin output");
  console.log("PASS quote ingress: canonical tags, adapter dedup, metadata/opaque-id escaping, unknown ids, media order, literal text and external-account echoes");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
