/** Request shape, identity bindings and admission errors; local fixtures and injected inference only. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { GrowthLedger, type PerceivedEvidence } from "../src/bot/growth.js";
import { GrowthRuntime } from "../src/bot/growth-runtime.js";
import { GrowthSubjectReferences, growthProposalSchema, parseGrowthChange, parseGrowthChanges } from "../src/bot/growth-proposal.js";
import type { BotModelConfig } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ChatCompleteOptions } from "../src/llm/chat.js";

const originalId = 'chat-user:["fixture","account:[\\\"quoted\\\"]"]';
const peerQuote = "下次调试卡住可以来找我，我们一起看日志。";
const originalText = `${peerQuote} 原文提到 s1 和 ${originalId}，这些文字不是身份结构字段。`;
const insight = { dimension: "技术求助的信任", significance: "以后遇到调试困难时可以尝试向对方求助，但不能预设对方随时有空。",
  anchors: [{ eventId: "peer-event", quote: peerQuote }] };
const proposal = { kind: "relationship", subject: "技术朋友", statement: "调试遇到困难时，可以向对方询问是否方便一起看日志。",
  evidenceIds: ["peer-event"], subjectId: "s1", insight };

function shapesAndReferences() {
  const references = new GrowthSubjectReferences();
  assert.equal(references.reference(originalId), "s1");
  assert.equal(references.reference(originalId), "s1");
  assert.equal(references.reference("other"), "s2");
  const visible = references.visible([originalId]);
  assert.equal(parseGrowthChange(proposal, visible).subjectId, originalId);
  assert.equal(proposal.subjectId, "s1", "decoding must not mutate the model response");
  assert.throws(() => parseGrowthChange({ ...proposal, subjectId: "s2" }, visible), /身份短号/);
  assert.throws(() => parseGrowthChange({ ...proposal, subjectId: originalId }, visible), /身份短号/);
  const next = new GrowthSubjectReferences();
  const nextVisible = next.visible(["next-request-person"]);
  assert.equal(parseGrowthChange(proposal, nextVisible).subjectId, "next-request-person");
  assert.equal(parseGrowthChange(proposal, visible).subjectId, originalId, "another request cannot rewrite an in-flight request's bindings");
  assert.throws(() => parseGrowthChange({ ...proposal, subjectId: "s2" }, nextVisible), /身份短号/);

  const malformed: [unknown, RegExp][] = [
    [{ ...proposal, kind: 1 }, /kind 必须为字符串/],
    [{ ...proposal, statement: undefined }, /statement 缺失/],
    [{ ...proposal, subjectId: {} }, /subjectId 必须为字符串/],
    [{ ...proposal, evidenceIds: "peer-event" }, /evidenceIds 必须为数组/],
    [{ ...proposal, evidenceIds: [3] }, /evidenceIds\[0\] 必须为字符串/],
    [{ ...proposal, insight: "invalid" }, /insight 必须为对象/],
    [{ ...proposal, insight: { ...insight, significance: undefined } }, /insight.significance 缺失/],
    [{ ...proposal, insight: { ...insight, anchors: "invalid" } }, /insight.anchors 必须为/],
    [{ ...proposal, insight: { ...insight, anchors: [{ eventId: "peer-event", quote: 1 }] } }, /quote 必须为字符串/],
    [{ ...proposal, expiresAt: Number.POSITIVE_INFINITY }, /expiresAt/],
    [{ ...proposal, statement: "a".repeat(1201) }, /statement 须为/],
    [{ ...proposal, surprising: true }, /未定义字段 surprising/],
  ];
  for (const [value, reason] of malformed) assert.throws(() => parseGrowthChange(value, visible), reason);
  assert.deepEqual(parseGrowthChanges({ content: '{"changes":[]}', toolCalls: [] }), []);
  assert.throws(() => parseGrowthChanges({ content: '{"changes":"[]"}', toolCalls: [] }), /changes 必须为数组/);
  assert.throws(() => parseGrowthChanges({ content: '{"changes":', toolCalls: [] }), /完整有效的 JSON/);
  assert.throws(() => parseGrowthChanges({ content: '{"changes":[]}', toolCalls: [{ id: "x", type: "function", function: { name: "send", arguments: "{}" } }] }), /不能调用工具/);
  const schema: any = growthProposalSchema({ evidenceIds: new Set(["peer-event"]), editableClaims: new Set(["existing"]), subjectReferences: visible });
  const item = schema.properties.changes.items;
  assert.deepEqual(item.properties.subjectId.enum, ["s1"]);
  assert.deepEqual(item.properties.evidenceIds.items.enum, ["peer-event"]);
  assert.deepEqual(item.properties.claimId.enum, ["existing"]);
  assert.equal(item.properties.insight.properties.anchors.items.properties.quote.maxLength, 500);
  assert.equal(item.additionalProperties, false);
  const noRefs: any = growthProposalSchema({ evidenceIds: new Set(["peer-event"]), editableClaims: new Set(), subjectReferences: new Map() });
  assert.equal(noRefs.properties.changes.items.properties.subjectId, undefined);
  assert.equal(noRefs.properties.changes.items.properties.claimId, undefined);
}

async function runtimeBindings() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-growth-proposal-"));
  let runtime: GrowthRuntime | undefined;
  try {
    const files = new WorldFiles(base); await files.ensure();
    await fs.writeFile(files.botDef, "小澈根据实际交流逐步了解朋友。", "utf8");
    const context = new BotContext(files); await context.load();
    const chat = { kind: "message" as const, channelKey: "fixture@self:group", senderId: originalId, senderOwn: false,
      direction: { kind: "group" as const, accountId: "chat-user:own-account", mentionedIds: [originalId], mentionsEveryone: false, quotedSenderId: "chat-user:unseen-author" } };
    const evidence: PerceivedEvidence = { eventId: "peer-event", actorId: "bot", source: "koishi", observedAt: 10,
      text: originalText, rootEventIds: ["chat-message:peer-event"],
      experience: { agency: "observed", outcome: "completed", opportunity: false, episodeId: "peer-episode", subjectIds: [originalId],
        action: originalText, situation: originalId, chat },
      messages: [{ chat, text: originalText, rootEventIds: ["chat-message:peer-event"] }] };
    const ledger = new GrowthLedger(base);
    await fs.writeFile(ledger.file, JSON.stringify({ type: "perceived", evidence }) + "\n");
    const cfg = { baseURL: "http://growth-injected.invalid", model: "fixture", growth: {
      enabled: true, minEpisodes: 1, reviewIntervalMs: 1, reviewTimeoutMs: 5000, maxInputChars: 24000,
    } } as BotModelConfig;
    let round = 0, at = 20, realAt = 100;
    const requests: any[] = [], options: ChatCompleteOptions[] = [];
    runtime = new GrowthRuntime(ledger, cfg, { now: () => at, unitWorldSeconds: 1 }, context, { warn() {} }, {
      realNow: () => realAt,
      infer: async (messages, _signal, opts) => {
        assert.ok(opts); options.push(opts);
        const payload = JSON.parse(messages[1]!.content as string); requests.push(payload);
        const item = payload.evidence.find((item: any) => item.id === "peer-event");
        assert.equal(item.experience.subjectIds[0], "s1");
        assert.equal(item.experience.chat.senderId, "s1");
        assert.equal(item.messages[0].chat.senderId, "s1");
        assert.deepEqual(item.experience.chat.direction, { kind: "group", accountId: "s2", mentionedIds: ["s1"], mentionsEveryone: false, quotedSenderId: "s3" });
        assert.deepEqual(item.messages[0].chat.direction, item.experience.chat.direction);
        if (opts.responseSchema) assert.deepEqual((opts.responseSchema.schema as any).properties.changes.items.properties.subjectId.enum, ["s1"],
          "mention/account/quote identities are factual context, not newly admitted relationship subjects");
        assert.equal(item.messages[0].text, originalText);
        assert.equal(item.experience.situation, originalId);
        assert.ok(item.experience.action.startsWith(peerQuote));
        if (round++) {
          assert.equal(payload.existing[0].subjectId, "s1");
          assert.equal(payload.existing[0].scope.subjectId, "s1");
          return { content: '{"changes":[]}', toolCalls: [] };
        }
        return { content: JSON.stringify({ changes: [
          proposal,
          { ...proposal, subjectId: "s999" },
          { ...proposal, insight: { ...insight, anchors: "invalid" } },
          { ...proposal, evidenceIds: ["unseen"] },
          { ...proposal, insight: { ...insight, anchors: [{ eventId: "peer-event", quote: "不存在的原文" }] } },
        ] }), toolCalls: [] };
      },
    });
    runtime.tick(); await runtime.settled();
    assert.equal(options[0]!.responseFormat, "json_schema");
    assert.equal(options[0]!.responseSchemaInPrompt, false);
    assert.equal(options[0]!.responseSchema?.name, "growth_review");
    assert.equal(options[0]!.tools, undefined); assert.equal(options[0]!.toolChoice, undefined);
    const review = (await ledger.reviewStatus()).recent[0]!;
    assert.equal(review.records.length, 1, JSON.stringify(review.rejected));
    assert.equal(review.records[0]!.subjectId, originalId);
    assert.equal(review.records[0]!.insight!.anchors[0]!.quote, peerQuote);
    assert.deepEqual(review.rejected!.map(item => item.index), [1, 2, 3, 4]);
    assert.match(review.rejected![0]!.reason, /身份短号/);
    assert.match(review.rejected![1]!.reason, /insight.anchors 必须为/);
    assert.match(review.rejected![2]!.reason, /未展示的证据/);
    assert.match(review.rejected![3]!.reason, /逐字引用/);
    assert.equal((await ledger.recallEvidence({ eventIds: [evidence.eventId] }))[0]!.text, originalText);

    const followup = { ...evidence, eventId: "followup", observedAt: 21, rootEventIds: ["chat-message:followup"],
      experience: { ...evidence.experience, episodeId: "followup-episode" } };
    await ledger.perceive({ id: followup.eventId, source: "koishi", worldTime: 21, content: originalText,
      originEventIds: followup.rootEventIds, experience: followup.experience });
    for (const responseFormat of ["json_object", "text"] as const) {
      cfg.growth!.responseFormat = responseFormat;
      at++; realAt += 10; runtime.tick(undefined, true); await runtime.settled();
      assert.equal(options.at(-1)!.responseFormat, responseFormat);
      // Empty proposals are valid; make a new event to exercise the next mode.
      await ledger.perceive({ id: "later-" + responseFormat, source: "koishi", worldTime: at, content: originalText,
        originEventIds: ["chat-message:later-" + responseFormat], experience: { ...followup.experience, episodeId: "later-" + responseFormat } });
    }
  } finally {
    runtime?.stop(); await runtime?.settled();
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function main() {
  shapesAndReferences(); await runtimeBindings();
  console.log("PASS growth proposal: bounded JSON schema, per-request identity references, original prose preservation and distinct shape/evidence errors");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
