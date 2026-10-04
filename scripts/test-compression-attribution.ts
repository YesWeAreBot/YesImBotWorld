import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotContext } from "../src/bot/context.js";
import { WorldFiles } from "../src/files.js";
import { chatAttributionForEvent, isCompressionScaffolding, readChatAttribution, renderChatAttribution, retainChatAttribution } from "../src/bot/compression-attribution.js";
import { COMPRESSION_CHAT_ATTRIBUTION_GUIDANCE, Prompts } from "../src/prompts.js";
import { mediaPart, richPartsText } from "../src/media/presentation.js";
import type { BotEvent, ExperienceMetadata, StreamEntry } from "../src/types.js";

const self = 'chat-user:["qq","self"]';
const alice = 'chat-user:["qq","alice"]';
const bob = 'chat-user:["qq","bob"]';
function event(id: string, text: string, sender = alice, extra: Partial<ExperienceMetadata> = {}, channel = "qq:self:group"): BotEvent {
  return { id: "ev_" + id, source: "koishi", worldTime: 20, content: text, originEventIds: ["chat-message:" + id],
    experience: { agency: "observed", chat: { channelKey: channel, kind: "message", senderId: sender,
      senderOwn: sender === self, direction: { kind: "group", accountId: self, mentionedIds: [], mentionsEveryone: false } }, ...extra } };
}
function entry(event: BotEvent): StreamEntry { return { kind: "event", event }; }
function snapshot(messages: BotEvent[]): BotEvent {
  return { id: "ev_snapshot", source: "tool", worldTime: 22, content: messages.map(item => item.content).join("\n"),
    originEventIds: messages.flatMap(item => item.originEventIds!), experience: { chat: { ...messages.at(-1)!.experience!.chat!, kind: "attention" } },
    parts: messages.map(item => ({ kind: "text", text: item.content + "\n", observedMessage: {
      originEventIds: item.originEventIds!, experience: item.experience!,
    } })) };
}
const question = event("question", "Yeah：首字延迟在哪里调？");
const answer = event("answer", 'MomoiCore：<quote id="question"/>模型配置那里。', bob, {
  chat: { channelKey: "qq:self:group", kind: "message", senderId: bob, senderOwn: false,
    direction: { kind: "group", accountId: self, mentionedIds: [], mentionsEveryone: false, quotedSenderId: alice } },
  responseToRoots: ["chat-message:question"],
});
const selfObserved = event("intrusion", "酷霸：明白了，多谢指点，我找找看。", self);
const confirmed: BotEvent = { ...selfObserved, id: "ev_send", source: "tool", refToolCallId: "tc_send", content: "消息已发到群。",
  contextHint: { text: "" }, experience: { agency: "self", outcome: "completed", action: "向群发送：明白了，多谢指点，我找找看。",
    chat: { ...selfObserved.experience!.chat!, kind: "send" } } };

async function main() {
  const projected = chatAttributionForEvent(snapshot([question, answer, selfObserved]));
  assert.equal(projected.length, 3);
  assert.equal(projected[0]!.sender, alice);
  assert.equal(projected[1]!.sender, bob);
  assert.equal(projected[1]!.quotedSender, alice);
  assert.deepEqual(projected[1]!.responseToRoots, ["chat-message:question"]);
  assert.equal(projected[2]!.ownership, "own-account");
  assert.equal(projected[2]!.agency, "unknown", "self-account ownership does not establish which human/plugin generated a message");
  assert.ok(projected.every(row => row.eventId === "ev_snapshot"));
  const actual = retainChatAttribution(projected, [entry(confirmed), entry(snapshot([question, answer, selfObserved]))]);
  assert.equal(actual.length, 3, "notification, send confirmation and reread share original message roots");
  assert.equal(actual[2]!.kind, "sent");
  assert.equal(actual[2]!.agency, "self");
  assert.equal(actual[2]!.text.trim(), selfObserved.content);
  assert.equal(actual[2]!.textKind, "message");
  assert.equal(actual[2]!.textEventId, "ev_snapshot", "the observed body retains its source separately from sending confirmation");
  const quotedOwnRow: BotEvent = { ...selfObserved, experience: { ...selfObserved.experience,
    chat: { ...selfObserved.experience!.chat!, direction: { kind: "group", accountId: self, mentionedIds: [], mentionsEveryone: false, quotedSenderId: alice } },
    responseToRoots: ["chat-message:question"] } };
  for (const records of [[quotedOwnRow, confirmed], [confirmed, quotedOwnRow]]) {
    const withQuote = retainChatAttribution([], records.map(entry));
    assert.equal(withQuote[0]!.kind, "sent");
    assert.equal(withQuote[0]!.quotedSender, alice, "a send receipt and platform echo complement attribution regardless of arrival order");
    assert.deepEqual(withQuote[0]!.responseToRoots, ["chat-message:question"]);
    assert.equal(withQuote[0]!.text, quotedOwnRow.content);
    assert.equal(withQuote[0]!.textKind, "message");
    assert.equal(withQuote[0]!.textEventId, quotedOwnRow.id);
  }

  const batches = [event("text-before", "第一句", self), event("sticker-middle", "一个已发送表情包", self), event("text-after", "第二句", self)];
  const batchReceipt: BotEvent = { ...confirmed, id: "batch-confirmation", originEventIds: batches.flatMap(row => row.originEventIds!),
    content: "平台确认三批已发送。", experience: { ...confirmed.experience, action: "向群发送了消息：第一句，一个表情包，第二句" } };
  const onlyReceipt = retainChatAttribution([], [entry(batchReceipt)]);
  assert.equal(onlyReceipt.length, 3);
  assert.ok(onlyReceipt.every(row => row.textKind === "receipt" && row.text === batchReceipt.content));
  assert.doesNotMatch(renderChatAttribution(onlyReceipt), /已看见的消息原文|第一句/,
    "a multi-ID confirmation cannot make several copies of the attempted full body into message turns");
  for (const records of [[batchReceipt, ...batches], [...batches, batchReceipt]]) {
    const merged = retainChatAttribution([], records.map(entry));
    assert.deepEqual(merged.map(row => row.text), batches.map(row => row.content));
    assert.ok(merged.every(row => row.kind === "sent" && row.agency === "self" && row.textKind === "message"));
    assert.deepEqual(merged.map(row => row.textEventId), batches.map(row => row.id));
    assert.deepEqual(retainChatAttribution(readChatAttribution(merged), [entry(batchReceipt), ...batches.map(entry)]), merged,
      "persistence and repeated readback preserve distinct messages without downgrading confirmed agency");
  }

  const failed = { ...confirmed, id: "ev_failed", originEventIds: [], content: "没有发出，权限不足", experience: { ...confirmed.experience, outcome: "failed" as const } };
  assert.deepEqual(chatAttributionForEvent(failed), []);
  const partial = { ...confirmed, id: "ev_partial", originEventIds: ["chat-message:partial"], content: "只有第一段获得发送确认，后续结果未知。",
    experience: { ...confirmed.experience, outcome: "unknown" as const, action: "尝试发送全部正文：不应当记成全部发出" } };
  assert.equal(chatAttributionForEvent(partial)[0]!.kind, "partial");
  assert.doesNotMatch(chatAttributionForEvent(partial)[0]!.text, /不应当记成全部发出/);
  const imposed = { ...confirmed, id: "ev_imposed", experience: { ...confirmed.experience, agency: "imposed" as const, action: "身体或设备发生了非自主变化" } };
  assert.equal(chatAttributionForEvent(imposed)[0]!.agency, "imposed");
  assert.equal(chatAttributionForEvent(imposed)[0]!.textKind, "receipt");
  assert.doesNotMatch(renderChatAttribution(chatAttributionForEvent(imposed)), /身体或设备发生了非自主变化|已看见的消息原文/);
  const imposedAndObserved = retainChatAttribution([], [entry(imposed), entry(selfObserved)]);
  assert.equal(imposedAndObserved[0]!.agency, "imposed");
  assert.equal(imposedAndObserved[0]!.text, selfObserved.content);

  const image = mediaPart({ id: 31, type: "image", mime: "image/png", file: "/fixture/image.png" }, { summary: "路边的树" });
  const audio = mediaPart({ id: 32, type: "audio", mime: "audio/wav", file: "/fixture/audio.wav" });
  const imageAfter = mediaPart({ id: 33, type: "image", mime: "image/png", file: "/fixture/after.png" });
  const mixedParts = [{ kind: "text" as const, text: "甲" }, image, { kind: "text" as const, text: "乙" }, audio,
    { kind: "text" as const, text: "丙" }, imageAfter, { kind: "text" as const, text: "丁" }];
  const mediaEvent = { ...event("mixed", richPartsText(mixedParts)), parts: mixedParts };
  const mediaReference = chatAttributionForEvent(mediaEvent)[0]!;
  assert.equal(mediaReference.mediaIdentity, true);
  assert.match(mediaReference.text, /甲<media ref="media:31"[^>]*>文字摘要（可能有误）：路边的树<\/media>乙<media ref="media:32"[^>]*><\/media>丙<media ref="media:33"[^>]*><\/media>丁/,
    "ordered media identity and existing summaries survive without inventing an audio transcript");
  assert.doesNotMatch(renderChatAttribution([mediaReference]), /未展开|无法查看|暂无文字摘要|已看见的消息原文/,
    "attribution is not a claim about what native media the current request contains or can understand");
  assert.match(renderChatAttribution([mediaReference]), /消息文字与媒体身份记录/);
  const markedMedia = { ...snapshot([mediaEvent]), parts: mixedParts.map(part => ({ ...part, observedMessage: {
    originEventIds: mediaEvent.originEventIds!, experience: mediaEvent.experience!,
  } })) };
  assert.equal(chatAttributionForEvent(markedMedia)[0]!.text, mediaReference.text,
    "per-message snapshot projection must not copy its fallback mediaText status into retained identity");
  const oldMediaReference = { ...mediaReference, mediaIdentity: undefined, text: "甲（未展开原始媒体）" };
  const migratedMedia = retainChatAttribution([oldMediaReference], [entry(mediaEvent)])[0]!;
  assert.equal(migratedMedia.text, mediaReference.text, "a new trusted projection improves the next compression's old media reference");
  assert.equal(oldMediaReference.text, "甲（未展开原始媒体）", "a new compression reference never rewrites prior persisted records or frozen prompts");
  assert.deepEqual(readChatAttribution([mediaReference]), [mediaReference]);
  assert.throws(() => readChatAttribution([{ ...mediaReference, mediaIdentity: "yes" }]), /损坏/);
  assert.throws(() => readChatAttribution([{ ...mediaReference, kind: "sent", textKind: "receipt" }]), /损坏/);
  const userProse = event("literal-media-wording", "此处仅保留媒体身份与文字摘要，未展开原始媒体");
  assert.equal(chatAttributionForEvent(userProse)[0]!.text, userProse.content, "real speakers' words are not stripped by matching a rendering phrase");
  assert.deepEqual(chatAttributionForEvent({ ...question, source: "world" }), []);
  assert.deepEqual(chatAttributionForEvent({ ...question, experience: { agency: "observed", situation: "手机震动" } }), []);
  assert.deepEqual(chatAttributionForEvent({ ...question, experience: { chat: { ...question.experience!.chat!, kind: "notice" } } }), []);
  const spoof = { ...snapshot([question, answer]), originEventIds: ["chat-message:question"] };
  assert.deepEqual(chatAttributionForEvent(spoof), [], "invalid ownership marks cannot assign all rows to the final speaker");

  const long = event("long", "A".repeat(500) + "，刚才只是反话，实际没有解决问题。");
  const longReference = chatAttributionForEvent(long)[0]!;
  assert.match(longReference.text, /正文较长，未复制/);
  assert.doesNotMatch(longReference.text, /AAAA/, "a truncated quote cannot silently turn a negation into an affirmative memory");
  const many = Array.from({ length: 100 }, (_, index) => entry(event("row" + index, "完整的简短原文。", alice, {}, "group" + index % 4)));
  const bounded = retainChatAttribution([], many);
  assert.ok(bounded.length <= 12);
  assert.ok(renderChatAttribution(bounded).length <= 4000);
  assert.ok(bounded.some(row => row.root === "chat-message:row99"));
  assert.deepEqual(readChatAttribution(bounded), bounded);
  assert.throws(() => readChatAttribution([{ ...bounded[0], text: "x".repeat(5000) }]), /损坏/);
  assert.throws(() => readChatAttribution([{ ...bounded[0], textKind: "action" }]), /损坏/);
  assert.throws(() => readChatAttribution([{ ...bounded[0], textEventId: undefined }]), /损坏/);
  assert.throws(() => readChatAttribution([{ ...bounded[0], textKind: "receipt" }]), /损坏/,
    "an observed-message record cannot silently become a transport receipt after persistence corruption");
  const oneChannel = retainChatAttribution([], many.map(item => entry({ ...(item as { event: BotEvent }).event,
    experience: { chat: { channelKey: "group", kind: "message", senderId: alice } } })));
  assert.ok(oneChannel.length <= 6);

  const menu: BotEvent = { id: "ev_menu", source: "system", content: "（当前可考虑的行动机会；建议回复技术问题并取得成功）", originEventIds: [], worldTime: 21 };
  assert.equal(isCompressionScaffolding(menu), true);
  assert.equal(isCompressionScaffolding({ ...menu, source: "koishi" }), false);
  assert.equal(isCompressionScaffolding({ ...menu, refToolCallId: "tc_pending", toolProgress: "pending" }), false);
  assert.equal(isCompressionScaffolding({ ...menu, content: "send(id,msg) 用法", toolTutorial: true }), true);
  assert.equal(isCompressionScaffolding({ ...menu, content: "send(id,msg) 用法", toolTutorial: true, refToolCallId: "tc_help" }), false);

  const dir = await fs.mkdtemp(join(tmpdir(), "yesimbot-compression-attribution-"));
  try {
    const files = new WorldFiles(dir); await files.ensure(); await files.atomicWrite(files.botDef, "酷霸，是个喜欢做饭的学生。");
    const context = new BotContext(files, ""); await context.load();
    const initialMessages = await context.toChatMessages("T20");
    const initialSystem = String(initialMessages[0]!.content);
    assert.equal(initialSystem.split("酷霸，是个喜欢做饭的学生。").length - 1, 1, "identical owner-authored persona is not duplicated");
    await context.appendEvent(snapshot([question, answer, selfObserved]));
    await context.appendEvent(menu);
    await context.appendEvent({ id: "ev_toolchange", source: "system", originEventIds: [], content: "工具用法很长但不是一次交流",
      toolAvailability: { removed: [], definitions: { send: "send(id,msg)" }, restored: [] }, worldTime: 23 });
    await context.appendToolCall({ id: "tc_send", role: "agent", name: "send", arguments: { id: "qq:self:group", msg: "明白了，多谢指点，我找找看。" }, issuedAt: 24, expectedAt: 24 });
    await context.appendEvent(confirmed);
    await context.appendEvent(failed);
    await context.appendEvent({ ...menu, id: "ev_pending", refToolCallId: "tc_waiting", toolProgress: "pending", content: "仍在等待真实执行结果。" });
    const beforeMessages = await context.toChatMessages("T25");
    assert.equal(beforeMessages[0]!.content, initialMessages[0]!.content, "new reference logic cannot rewrite the active frozen prefix");
    const snap = await context.compressionSnapshot();
    assert.doesNotMatch(snap.text, /建议回复技术问题并取得成功|工具用法很长但不是一次交流/);
    assert.match(snap.text, /没有发出，权限不足/);
    assert.match(snap.text, /仍在等待真实执行结果/);
    assert.match(snap.text, /quotedSender/);
    assert.match(snap.text, /"kind":"sent","agency":"self"/, "an earlier observed echo may not hide later confirmed sending provenance");
    assert.match(snap.text, /首字延迟在哪里调/);
    assert.deepEqual(await context.toChatMessages("T26"), beforeMessages, "compression projection is a read and keeps every cached byte");

    // A later append belongs to the next window and must not be silently pulled into this cutover.
    await context.appendEvent(event("later", "刚刚新的发言。"));
    const write = files.atomicWrite.bind(files); let failOnce = true;
    files.atomicWrite = async (file, body) => { if (file === files.pinned && failOnce) { failOnce = false; throw Error("fixture attribution cutover"); } return write(file, body); };
    await assert.rejects(context.applyCompression({ historySummary: "角色自称参与了讨论，是否帮助了别人未知。", memoryDigest: "话题是首字延迟，问题属于 Yeah。" }, 26, snap), /fixture attribution cutover/);
    const reloaded = new BotContext(files, ""); await reloaded.load();
    assert.deepEqual(reloaded.stream.map(item => item.kind === "event" ? item.event.id : item.call.id), ["ev_later"]);
    const recovered = await reloaded.toChatMessages("T27");
    const recoveredSystem = String(recovered[0]!.content);
    assert.match(recoveredSystem, /原始归属核对/);
    assert.match(recoveredSystem, /本人发送已确认/);
    assert.match(recoveredSystem, /引用作者=/);
    assert.doesNotMatch(recoveredSystem, /chat-message:later/, "only the summarized prefix contributes attribution");
    assert.ok(recoveredSystem.indexOf("原始归属核对") > recoveredSystem.indexOf("# 记忆摘要"));
    const pinned = JSON.parse(await files.readText(files.pinned));
    assert.equal(pinned.chatAttribution.length, 3);
    const restarted = new BotContext(files, ""); await restarted.load();
    assert.deepEqual(await restarted.toChatMessages("T99"), recovered, "restart preserves the committed prompt including grounded attribution");
    const text = restarted.serializeForCompression();
    assert.match(text, /此前已看过的聊天归属参考（不是新消息）/);
    assert.match(text, /首字延迟在哪里调/);
    await restarted.applyCompression({ historySummary: "话题仍在继续。", memoryDigest: "保留不同发言者。" }, 100);
    assert.equal(JSON.parse(await files.readText(files.pinned)).chatAttribution.length, 4, "subsequent compression merges roots without inventing new turns");

    // Distinct authored texts are not removed by the render-time identity deduplication.
    const custom = new BotContext(files, ""); custom.pinned.botDefinition = "原本身份"; custom.pinned.persona = "另行指定的身份说明";
    const customPrompt = custom.renderSystemText("T0");
    assert.match(customPrompt, /原本身份/); assert.match(customPrompt, /另行指定的身份说明/);
    assert.ok(new Prompts().world.compressSystem.includes(COMPRESSION_CHAT_ATTRIBUTION_GUIDANCE));

    const mediaFiles = new WorldFiles(join(dir, "media")); await mediaFiles.ensure();
    const mediaContext = new BotContext(mediaFiles, ""); await mediaContext.load();
    mediaContext.attachmentLoader = async ref => ref.type === "audio"
      ? { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } }
      : { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } };
    await mediaContext.appendEvent(markedMedia);
    const renderedMedia = await mediaContext.toChatMessages("T20");
    const mediaCut = await mediaContext.compressionSnapshot();
    assert.deepEqual(await mediaContext.toChatMessages("T21"), renderedMedia, "attribution projection preserves the native active-window prefix byte-for-byte");
    await mediaContext.applyCompression({ historySummary: "收到混合消息。", memoryDigest: "不猜测语音内容。" }, 22, mediaCut);
    const mediaSystem = String((await mediaContext.toChatMessages("T22"))[0]!.content);
    assert.match(mediaSystem, /消息文字与媒体身份记录/);
    assert.doesNotMatch(mediaSystem, /未展开原始媒体|暂无文字摘要/);
    const mediaRestart = new BotContext(mediaFiles, ""); await mediaRestart.load();
    assert.deepEqual(await mediaRestart.toChatMessages("T23"), await mediaContext.toChatMessages("T22"),
      "neutral media references preserve their exact newly committed prefix across restart");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  console.log("PASS compression attribution: quoted authors, send confirmation vs intent, bounded source references, nonfactual menus, immutable prefixes and durable recovery");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
