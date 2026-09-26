/** Retiring the old optimizer preserves history and native prefixes until ordinary compression. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext, REGULATION_RETIREMENT_NOTICE } from "../src/bot/context.js";
import { Config } from "../src/config.js";
import { GrowthLedger } from "../src/bot/growth.js";
import { WorldFiles } from "../src/files.js";
import { WebUIServer } from "../src/webui/server.js";
import type { ChatToolDef } from "../src/llm/chat.js";
const act: ChatToolDef = { type: "function", function: { name: "act", description: "行动", parameters: { type: "object", properties: {} } } };
const rest: ChatToolDef = { type: "function", function: { name: "rest", description: "休息", parameters: { type: "object", properties: {} } } };

async function contextRetirement(base: string) {
  const files = new WorldFiles(base); await files.ensure();
  await files.atomicWrite(files.botDef, "原来的人物设定");
  const fresh = new BotContext(files); await fresh.load();
  assert.equal(await fresh.retireLegacyRegulation(0), undefined);
  await fresh.appendEvent({ id: "ev_regulation_quoted", source: "koishi", worldTime: 1, content: "群友讨论递质与收益", originEventIds: ["real-message"] });
  assert.equal(await fresh.retireLegacyRegulation(1), undefined, "real chat cannot inject a retirement signal or be mistaken for program guidance");
  const tools = await fresh.nativeToolSnapshot("T1", [act]);
  await fresh.persistPinned();
  const original = JSON.parse(await fs.readFile(files.pinned, "utf8"));
  original.pinned.regulationSummary = "旧程序推测现在需要社交";
  original.pinned.growthSummary = "亲历后知道朋友值得信任";
  original.rendered.systemText += "\n\n# 需要与行动取向（整理时的快照）\n旧程序推测现在需要社交";
  await files.atomicWrite(files.pinned, JSON.stringify(original));
  const context = new BotContext(files); await context.load();
  const before = await context.toChatMessages("T2"), oldStream = await fs.readFile(files.stream, "utf8"), revision = context.windowRevision;
  const notice = await context.retireLegacyRegulation(2);
  assert.ok(notice); assert.equal(notice.content, REGULATION_RETIREMENT_NOTICE); assert.deepEqual(notice.originEventIds, []);
  const after = await context.toChatMessages("T3");
  assert.deepEqual(after.slice(0, before.length), before, "retirement only appends and leaves the complete provider prefix unchanged");
  assert.ok((await fs.readFile(files.stream, "utf8")).startsWith(oldStream));
  assert.deepEqual(await context.nativeToolSnapshot("T3", [rest]), tools);
  assert.equal(context.windowRevision, revision);
  assert.equal(await context.retireLegacyRegulation(3), undefined);
  const reload = new BotContext(files); await reload.load();
  assert.equal(await reload.retireLegacyRegulation(4), undefined, "restart does not duplicate a saved retirement");
  assert.deepEqual(await reload.toChatMessages("T4"), after);
  const snapshot = await reload.compressionSnapshot();
  await reload.appendEvent({ id: "real_late_perception", source: "world", worldTime: 5, content: "朋友递给你一杯茶。", originEventIds: ["world-actual"] });
  const growth = new GrowthLedger(base);
  await growth.restorePerceptions(reload.stream);
  await growth.perceive({ id: "ev_regulation_prior", source: "system", worldTime: 4, content: "旧程序诱导社交", originEventIds: [] });
  assert.deepEqual(new Set((await growth.recallEvidence({ n: 50 })).map(e => e.eventId)), new Set(["ev_regulation_quoted", "real_late_perception"]), "retirement and old optimizer notifications cannot enter actual growth evidence; real chat and world perceptions remain");
  const atomic = files.atomicWrite.bind(files); let blocked = true;
  files.atomicWrite = async (file, text) => { if (file === files.pinned && blocked) throw Error("cutover checkpoint blocked"); await atomic(file, text); };
  await assert.rejects(reload.applyCompression({ historySummary: "朋友来看望", memoryDigest: "记住他的关心" }, 6, snapshot), /cutover checkpoint blocked/);
  assert.equal(reload.renderSystemText("T6"), before[0]!.content, "failed compression cannot replace the old committed fixed block");
  blocked = false; await reload.settled();
  assert.equal((reload.pinned as any).regulationSummary, undefined);
  assert.equal(reload.pinned.growthSummary, original.pinned.growthSummary);
  assert.equal(reload.pinned.botDefinition, "原来的人物设定");
  assert.deepEqual(reload.stream.map(e => e.kind === "event" ? e.event.id : e.call.id), ["real_late_perception"]);
  assert.doesNotMatch(String((await reload.toChatMessages("T6"))[0]!.content), /需要与行动取向|旧程序推测/);
  assert.deepEqual(await reload.nativeToolSnapshot("T6", [rest]), [rest]);
  assert.equal(await reload.retireLegacyRegulation(6), undefined, "a clean new window no longer needs retirement notices");

  // A legacy archive may only retain program events, or only a rendered fixed block.
  for (const mode of ["event", "rendered"] as const) {
    const archive = path.join(files.archiveDir, "legacy-" + mode); await fs.mkdir(archive);
    const state = structuredClone(original); delete state.pinned.regulationSummary;
    if (mode === "event") state.rendered.systemText = String(before[0]!.content).split("\n\n# 需要与行动取向")[0];
    await fs.writeFile(path.join(archive, "pinned.json"), JSON.stringify(state));
    const legacyEvent = { kind: "event", event: { id: "ev_regulation_legacy", source: "system", worldTime: 2, content: "现在追求旧需要分数", originEventIds: [] } };
    await fs.writeFile(path.join(archive, "stream.jsonl"), mode === "event" ? JSON.stringify(legacyEvent) + "\n" : "");
    await files.restoreFrom(archive);
    const restored = new BotContext(files); await restored.load();
    assert.ok(await restored.retireLegacyRegulation(7), "restoring " + mode + " legacy state must explicitly retire it");
    assert.equal(await restored.retireLegacyRegulation(8), undefined);
  }
  console.log("PASS retirement context: no fresh-world notice, trusted provenance, immutable prefix and native declarations, single append, restart, compression recovery, growth preservation and old archive retirement");
}

async function filesLifecycle(base: string): Promise<{ files: WorldFiles; archive: string; original: string }> {
  const files = new WorldFiles(base);
  await files.ensure();
  const journal = path.join(base, "regulation.jsonl");
  const original = JSON.stringify({ id:"old", state:{at:100,learning:{private:"confirmed experience"}} }) + "\n";
  await fs.writeFile(journal, original);
  const archive = await files.snapshot("内在调节存档");
  const archived = path.join(files.archiveDir, archive);
  assert.equal(await fs.readFile(path.join(archived, "regulation.jsonl"), "utf8"), original);
  assert.ok(JSON.parse(await fs.readFile(path.join(archived,"manifest.json"),"utf8")).files.includes("regulation.jsonl"));
  await fs.writeFile(journal, '{"id":"future experience"}\n');
  await files.restoreFrom(archived);
  assert.equal(await fs.readFile(journal, "utf8"), original, "Restoring retains only the matching historical audit, without activating it");
  const incomplete = Buffer.concat([Buffer.from(original + '{"id":"unfinished","text":"'), Buffer.alloc(130000, 0x61), Buffer.from([0xf0,0x9f])]);
  await fs.writeFile(journal, incomplete);
  const concurrentArchive = path.join(files.archiveDir, await files.snapshot("追加进行中"));
  assert.equal(await fs.readFile(path.join(concurrentArchive,"regulation.jsonl"),"utf8"),original,"Snapshot retains only newline-terminated transactions, even with a large partial UTF-8 tail");
  assert.deepEqual(await fs.readFile(journal),incomplete,"Taking a snapshot must not truncate the live writer's in-progress transaction");
  await files.restoreFrom(concurrentArchive);
  assert.equal(await fs.readFile(journal,"utf8"),original,"Restoring the concurrent snapshot cannot restore a corrupt partial transaction");
  await fs.writeFile(journal,'{"id":"complete-json-but-not-committed"}');
  const firstWriteArchive = path.join(files.archiveDir, await files.snapshot("首条尚未提交"));
  assert.equal(await fs.readFile(path.join(firstWriteArchive,"regulation.jsonl"),"utf8"),"","JSON without its commit newline is excluded even if syntactically valid");
  await files.restoreFrom(firstWriteArchive);
  assert.equal(await fs.readFile(journal,"utf8"),"");
  await files.restoreFrom(archived);
  const legacy = path.join(files.archiveDir, "legacy-without-regulation");
  await fs.mkdir(legacy);
  await files.restoreFrom(legacy);
  assert.equal(await files.exists(journal), false, "Loading an older world cannot inherit unrelated future regulation");
  await files.restoreFrom(archived);
  const before = new Set(await fs.readdir(files.archiveDir));
  await files.reset();
  assert.equal(await files.exists(journal), false, "A reset keeps obsolete audit outside the new lifetime");
  const resetArchive = (await fs.readdir(files.archiveDir)).find(name => !before.has(name));
  assert.ok(resetArchive);
  assert.equal(await fs.readFile(path.join(files.archiveDir,resetArchive,"regulation.jsonl"),"utf8"),original,"Reset preserves the old regulation audit in its snapshot");
  await files.restoreFrom(archived);
  console.log("PASS retired audit storage: snapshot, manifest, exact restore, concurrent partial-tail exclusion, legacy absence and reset archive isolation");
  return { files, archive, original };
}

async function historicalAuditHttp(base: string, files: WorldFiles, archive: string, original: string) {
  const cfg = Config({ autoStart:false });
  cfg.webui = { ...cfg.webui, host:"127.0.0.1",port:0,token:"isolated-regulation-admin" };
  let growthStatusReads = 0;
  const growthStatus = { pending: 9, deferred: 14, reviews: 2, rejected: 1, failures: 1, lastOutcome: "failed", lastFailure: { at: 32, realAt: 1234, reason: "private timeout detail" }, recentFailures: [{ at: 32, realAt: 1234, reason: "private timeout detail" }], recent: [{ at: 30, records: [], rejected: [{ index: 0, reason: "private validation detail" }] }], backlogs: [] };
  const server: any = new WebUIServer({ config:cfg, files, webuiDir:path.join(base,"webui"),getGrowth:async()=>[], getGrowthStatus:async()=>{growthStatusReads++;return growthStatus;} } as never);
  const roles: Record<string,string> = {};
  for (const preset of ["viewer","player","operator"] as const) {
    assert.ok((await server.visitors.create(preset,"isolated-password",preset)).ok);
    roles[preset] = (await server.visitors.login(preset,"isolated-password")).token;
  }
  try {
    await server.start();
    const url = "http://127.0.0.1:" + server.server.address().port;
    async function request(resource: string, role = "admin", method = "GET") {
      const headers: Record<string,string> = role === "admin" ? { authorization:"Bearer isolated-regulation-admin" } : role === "anonymous" ? {} : {"x-visitor-token":roles[role]!};
      const response = await fetch(url+resource,{headers,method});
      return {status:response.status,body:await response.json() as any};
    }
    assert.equal((await request("/api/regulation","anonymous")).status,401);
    assert.equal((await request("/api/bot/growth/status","anonymous")).status,401);
    for (const role of Object.keys(roles)) {
      assert.equal((await request("/api/regulation",role)).status,404,role+" sees no retired API");
      assert.equal((await request("/api/regulation",role,"POST")).status,403);
      assert.equal((await request("/api/bot/growth/status",role)).status,403,role+" cannot read rejected growth proposals even with notes permission");
      assert.equal((await request("/api/bot/growth/status",role,"POST")).status,403);
      assert.equal((await request("/api/archive/file?folder="+encodeURIComponent(archive)+"&file=regulation.jsonl",role)).status,403,"Archive grants cannot bypass the internal-audit restriction");
    }
    assert.equal(growthStatusReads,0,"Unauthorized requests never read private growth review data");
    const status = await request("/api/bot/growth/status");
    assert.equal(status.status,200); assert.deepEqual(status.body,growthStatus);
    assert.deepEqual((await request("/api/bot/growth")).body,{growth:[]},"The public growth view keeps its existing array shape");
    assert.deepEqual((await request("/api/bot/growth","viewer")).body,{growth:[]},"Notes-authorized visitors retain the growth view without its audit");
    assert.equal((await request("/api/bot/growth/status","admin","POST")).status,405);
    assert.equal(growthStatusReads,1,"The growth status endpoint is read only");
    assert.equal((await request("/api/regulation")).status,404,"The retired model API no longer exists");
    assert.equal((await request("/api/regulation","admin","POST")).status,404);
    assert.equal((await request("/api/archive/file?folder="+encodeURIComponent(archive)+"&file=regulation.jsonl")).body.content,original);
    for (const role of ["viewer","operator"]) {
      const listing = await request("/api/archive",role);
      assert.equal(listing.status,200);
      assert.ok(listing.body.snapshots.every((snapshot: any)=>snapshot.files.every((entry: any)=>entry.name!=="regulation.jsonl")),"Journal names and contents remain outside visitor archive projections");
    }
    console.log("PASS retirement HTTP: removed model API, retained growth permissions and administrator-only historical audit");
  } finally { await server.stop(); }
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(),"yesimbot-retirement-"));
  try {
    await contextRetirement(path.join(base,"context"));
    const filesBase=path.join(base,"files");
    const prepared=await filesLifecycle(filesBase);
    await historicalAuditHttp(filesBase,prepared.files,prepared.archive,prepared.original);
  } finally { await fs.rm(base,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
