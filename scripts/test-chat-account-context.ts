/** Account changes append to a frozen context; all cognitive requests receive current identity without network calls. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { GrowthLedger } from "../src/bot/growth.js";
import { GrowthRuntime } from "../src/bot/growth-runtime.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ChatMessage } from "../src/llm/chat.js";
import { CHAT_ACCOUNTS_NOTICE_PREFIX, Prompts } from "../src/prompts.js";
import type { BotEvent } from "../src/types.js";
import { WorldAgent } from "../src/world/agent.js";

const logger = { info() {}, warn() {}, error() {} } as any;

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-chat-account-context-"));
  let growth: GrowthRuntime | undefined, world: WorldAgent | undefined;
  try {
    const files = new WorldFiles(base); await files.ensure();
    await files.atomicWrite(files.botDef, "小澈；聊天昵称和角色姓名不必相同。");
    const historical: BotEvent = { id: "ev_7", source: "koishi", worldTime: 1,
      content: "频道旧记录：旧名片（fixture:account-A，本人账号）说：明天整理书架。",
      originEventIds: ["fixture:old-message"], experience: { agency: "observed", outcome: "unknown" } };
    const historicalLine = JSON.stringify({ kind: "event", event: historical }) + "\n";
    await fs.writeFile(files.stream, historicalLine);
    let accounts = "";
    let context = new BotContext(files); await context.load();
    assert.equal(await context.refreshChatAccounts(2), undefined, "an absent provider cannot assert that all accounts disconnected");
    assert.equal(await files.readText(files.stream), historicalLine);
    context.accountsProvider = () => accounts;
    const original = await context.toChatMessages("T2"), originalPinned = structuredClone(context.pinned);

    async function refresh(expected: string, at: number) {
      const beforeMessages = await context.toChatMessages(`T${at}`), beforeBytes = await files.readText(files.stream);
      const event = await context.refreshChatAccounts(at);
      assert.ok(event, "each actual account transition appends a notice");
      assert.equal(event.source, "system"); assert.equal(event.worldTime, at);
      assert.deepEqual(event.originEventIds, [], "identity maintenance cannot create a new chat experience");
      assert.equal(event.experience, undefined); assert.equal(event.refToolCallId, undefined);
      assert.ok(event.content.startsWith(CHAT_ACCOUNTS_NOTICE_PREFIX)); assert.ok(event.content.includes(expected));
      assert.match(event.content, /不证明某条消息由你自主发送/);
      const afterMessages = await context.toChatMessages(`T${at + 1}`);
      assert.deepEqual(afterMessages.slice(0, beforeMessages.length), beforeMessages, "all already-sent model messages retain their bytes");
      assert.deepEqual(context.pinned, originalPinned, "identity updates never rebuild the fixed persona/history block");
      assert.ok((await files.readText(files.stream)).startsWith(beforeBytes), "the durable journal only grows");
      return event;
    }

    await refresh("目前没有确认可用的聊天账号", 3);
    accounts = "fixture:account-A";
    await refresh(accounts, 4);
    const beforeDuplicate = await files.readText(files.stream), beforeDuplicateMessages = await context.toChatMessages("T5");
    accounts = "  fixture:account-A  ";
    assert.deepEqual(await Promise.all([context.refreshChatAccounts(5), context.refreshChatAccounts(6)]), [undefined, undefined]);
    assert.equal(await files.readText(files.stream), beforeDuplicate, "identical identity, time changes and outer whitespace do not duplicate notices");
    assert.deepEqual(await context.toChatMessages("T999"), beforeDuplicateMessages);

    accounts = "fixture:account-A";
    context = new BotContext(files); context.accountsProvider = () => accounts; await context.load();
    assert.equal(await context.refreshChatAccounts(7), undefined, "restart finds the last durable identity notice");
    assert.deepEqual(await context.toChatMessages("T7"), beforeDuplicateMessages, "restart keeps the original rendered system and all old messages");
    accounts = "fixture:account-B";
    await refresh(accounts, 8);
    assert.deepEqual(context.stream.find(entry => entry.kind === "event" && entry.event.id === historical.id), { kind: "event", event: historical },
      "a changed account cannot relabel old own-account messages, nicknames or agency");
    accounts = "";
    const disconnected = await refresh("目前没有确认可用的聊天账号", 9);
    assert.match(disconnected.content, /不否定旧记录中的历史归属/);
    accounts = "fixture:account-A、fixture:account-B";
    const reconnected = await refresh(accounts, 10);
    assert.equal(await context.refreshChatAccounts(11), undefined);
    const noticeIds = context.stream.flatMap(entry => entry.kind === "event" && entry.event.content.startsWith(CHAT_ACCOUNTS_NOTICE_PREFIX) ? [entry.event.id] : []);
    assert.equal(noticeIds.length, 5); assert.equal(new Set(noticeIds).size, 5);
    const afterTransitions = await context.toChatMessages("T11");
    assert.deepEqual(afterTransitions.slice(0, original.length), original, "even several transitions retain the entire pre-upgrade request prefix");
    assert.ok(!String(afterTransitions[0]!.content).includes("fixture:account-B"), "the account is learned via appended context, not a silently edited system prompt");
    context = new BotContext(files); context.accountsProvider = () => accounts; await context.load();
    assert.equal(await context.refreshChatAccounts(12), undefined);
    assert.deepEqual(await context.toChatMessages("T12"), afterTransitions);

    // Independent maintenance requests must carry current account IDs even though the Bot prefix is frozen.
    const event: BotEvent = { id: context.nextEventId(), source: "koishi", worldTime: 13,
      content: "旧名片（fixture:account-A，本人账号）先前发出的消息：明天整理书架。",
      originEventIds: ["fixture:actual-message"], experience: { agency: "observed", outcome: "unknown", episodeId: "fixture:conversation" } };
    await context.appendEvent(event);
    const modelPrefix = await context.toChatMessages("T13"), modelJournal = await files.readText(files.stream);
    const cfg = Config({ autoStart: false });
    cfg.bot.baseURL = "http://unused.invalid/v1"; cfg.bot.model = "offline-fixture"; cfg.bot.apiKey = "";
    cfg.bot.growth = { ...cfg.bot.growth, enabled: true, minEpisodes: 1, reviewIntervalMs: 1, reviewTimeoutMs: 2000, maxInputChars: 64000 };
    const clock = { now: () => 14, unitWorldSeconds: 1, timeLine: () => "T14", syncRealTime: false, realMsUntil: () => 0 } as any;
    const ledger = new GrowthLedger(base); await ledger.perceive(event);
    const evidenceBeforeIdentity = await ledger.stats(); await ledger.perceive(reconnected);
    assert.deepEqual(await ledger.stats(), evidenceBeforeIdentity, "the identity notice cannot supply growth evidence");
    let growthRequest: any;
    growth = new GrowthRuntime(ledger, cfg.bot, clock, context, logger, { infer: async messages => {
      growthRequest = JSON.parse(messages[1]!.content as string);
      return { content: '{"changes":[]}', toolCalls: [] };
    } });
    growth.tick(undefined, true); await growth.settled();
    assert.ok(growthRequest, "the real growth review path reached the deterministic local model");
    assert.equal(growthRequest.chatAccounts, accounts);
    assert.ok(growthRequest.evidence.some((item: any) => item.id === event.id));
    assert.ok(!growthRequest.evidence.some((item: any) => item.id === reconnected.id));


    const compressRequests: ChatMessage[][] = [];
    cfg.world.compressMaxInputChars = 80;
    const prompts = new Prompts();
    world = new WorldAgent(cfg.world, files, clock, logger, prompts);
    (world as any).client = { complete: async (messages: ChatMessage[]) => {
      compressRequests.push(messages);
      assert.ok(messages.some(message => message.role === "system" && String(message.content).includes("已停用或明确撤回的程序性状态估计")),
        "every compression pass, including a custom system prompt, excludes retired program estimates from current motives");
      return { content: "<HISTORY_SUMMARY>自己账号曾说要整理书架。</HISTORY_SUMMARY><MEMORY_DIGEST>区分发送账号与自主选择。</MEMORY_DIGEST>", toolCalls: [] };
    } };
    await world.compress({ persona: context.pinned.persona, historySummary: "旧摘要", memoryDigest: "旧记忆",
      streamText: [event.content, event.content, event.content].join("\n"), timeLine: "T14", chatAccounts: accounts });
    assert.ok(compressRequests.length > 1, "fixture exercises each pass of a split compression");
    for (const messages of compressRequests) assert.ok(String(messages[1]!.content).includes(`<chat_accounts>${accounts}</chat_accounts>`));

    const defaultPasses = compressRequests.length;
    const customTemplate = "原有自定义正文，必须保留。\n人物={{persona}}\n材料={{streamText}}\n旧摘要={{historySummary}}\n旧记忆={{memoryDigest}}\n原有模板结尾。";
    const customSystem = "作者自定义的压缩方式：只整理确实经历过的事。";
    prompts.setOverrides({ bot: {}, world: { compressSystem: customSystem, compressUser: customTemplate } });
    await world.compress({ persona: context.pinned.persona, historySummary: "旧摘要", memoryDigest: "旧记忆",
      streamText: [event.content, event.content, event.content].join("\n"), timeLine: "T14", chatAccounts: accounts });
    const customRequests = compressRequests.slice(defaultPasses);
    assert.equal(customRequests.length, defaultPasses, "a legacy template still receives every compression segment");
    for (const messages of customRequests) {
      assert.ok(String(messages[0]!.content).startsWith(customSystem), "source rules preserve the custom system prompt");
      const text = String(messages[1]!.content);
      assert.ok(text.startsWith(`原有自定义正文，必须保留。\n人物=${context.pinned.persona}\n材料=`));
      assert.ok(text.includes("原有模板结尾。"), "adding required identity does not replace user-authored template content");
      const blocks = [...text.matchAll(/<chat_accounts>\s*([\s\S]*?)\s*<\/chat_accounts>/g)];
      assert.equal(blocks.length, 1); assert.equal(blocks[0]![1]!.trim(), accounts);
    }
    assert.equal(prompts.get().world.compressSystem, customSystem);
    assert.equal(prompts.get().world.compressUser, customTemplate, "the stored author template is not silently migrated");
    assert.equal(await files.readText(files.stream), modelJournal, "cognitive analysis does not append an invented send or relabel past experience");
    assert.deepEqual(await context.toChatMessages("T15"), modelPrefix, "background identity-aware requests leave the working prefix unchanged");
    console.log("PASS chat account context: append-only connection/switch/disconnect, restart and concurrent idempotence, preserved legacy identity/agency, and current account mapping in growth/all default and legacy-template compression passes");
  } finally { growth?.stop(); await growth?.settled(); await world?.runtime.shutdown(); await fs.rm(base, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
