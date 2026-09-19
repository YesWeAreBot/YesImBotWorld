/** Isolated HTTP, file-watch and archive regression; no agent, model or live world starts. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WebUIServer } from "../src/webui/server.js";

async function filesLifecycle(base: string): Promise<{ files: WorldFiles; archive: string; original: string }> {
  const files = new WorldFiles(base);
  await files.ensure();
  assert.equal(files.regulationJournal, path.join(base, "regulation.jsonl"));
  const original = JSON.stringify({ id:"old", state:{at:100,learning:{private:"confirmed experience"}} }) + "\n";
  await fs.writeFile(files.regulationJournal, original);
  const archive = await files.snapshot("内在调节存档");
  const archived = path.join(files.archiveDir, archive);
  assert.equal(await fs.readFile(path.join(archived, "regulation.jsonl"), "utf8"), original);
  assert.ok(JSON.parse(await fs.readFile(path.join(archived,"manifest.json"),"utf8")).files.includes("regulation.jsonl"));
  await fs.writeFile(files.regulationJournal, '{"id":"future experience"}\n');
  await files.restoreFrom(archived);
  assert.equal(await fs.readFile(files.regulationJournal, "utf8"), original, "Restoring must roll back both needs and learned expectations");
  const incomplete = Buffer.concat([Buffer.from(original + '{"id":"unfinished","text":"'), Buffer.alloc(130000, 0x61), Buffer.from([0xf0,0x9f])]);
  await fs.writeFile(files.regulationJournal, incomplete);
  const concurrentArchive = path.join(files.archiveDir, await files.snapshot("追加进行中"));
  assert.equal(await fs.readFile(path.join(concurrentArchive,"regulation.jsonl"),"utf8"),original,"Snapshot retains only newline-terminated transactions, even with a large partial UTF-8 tail");
  assert.deepEqual(await fs.readFile(files.regulationJournal),incomplete,"Taking a snapshot must not truncate the live writer's in-progress transaction");
  await files.restoreFrom(concurrentArchive);
  assert.equal(await fs.readFile(files.regulationJournal,"utf8"),original,"Restoring the concurrent snapshot cannot restore a corrupt partial transaction");
  await fs.writeFile(files.regulationJournal,'{"id":"complete-json-but-not-committed"}');
  const firstWriteArchive = path.join(files.archiveDir, await files.snapshot("首条尚未提交"));
  assert.equal(await fs.readFile(path.join(firstWriteArchive,"regulation.jsonl"),"utf8"),"","JSON without its commit newline is excluded even if syntactically valid");
  await files.restoreFrom(firstWriteArchive);
  assert.equal(await fs.readFile(files.regulationJournal,"utf8"),"");
  await files.restoreFrom(archived);
  const legacy = path.join(files.archiveDir, "legacy-without-regulation");
  await fs.mkdir(legacy);
  await files.restoreFrom(legacy);
  assert.equal(await files.exists(files.regulationJournal), false, "Loading an older world cannot inherit unrelated future regulation");
  await files.restoreFrom(archived);
  const before = new Set(await fs.readdir(files.archiveDir));
  await files.reset();
  assert.equal(await files.exists(files.regulationJournal), false, "A new lifetime starts without previous internal state");
  const resetArchive = (await fs.readdir(files.archiveDir)).find(name => !before.has(name));
  assert.ok(resetArchive);
  assert.equal(await fs.readFile(path.join(files.archiveDir,resetArchive,"regulation.jsonl"),"utf8"),original,"Reset preserves the old regulation audit in its snapshot");
  await files.restoreFrom(archived);
  console.log("PASS regulation storage: snapshot, manifest, exact restore, concurrent partial-tail exclusion, legacy absence and reset archive isolation");
  return { files, archive, original };
}

async function httpAndWatch(base: string, files: WorldFiles, archive: string, original: string) {
  const cfg = Config({ autoStart:false });
  cfg.webui = { ...cfg.webui, host:"127.0.0.1",port:0,token:"isolated-regulation-admin" };
  let reads = 0, growthStatusReads = 0, enabled = true;
  const view = () => ({enabled,decisionEnabled:true,worldSecondsPerUnit:30,state:{at:120,needs:{recovery:.2}},recent:[{id:"private-choice",type:"decision",at:120,summary:"private evidence"}]});
  const growthStatus = { pending: 9, deferred: 14, reviews: 2, rejected: 1, failures: 1, lastOutcome: "failed", lastFailure: { at: 32, realAt: 1234, reason: "private timeout detail" }, recentFailures: [{ at: 32, realAt: 1234, reason: "private timeout detail" }], recent: [{ at: 30, records: [], rejected: [{ index: 0, reason: "private validation detail" }] }], backlogs: [] };
  const server: any = new WebUIServer({ config:cfg, files, webuiDir:path.join(base,"webui"),getRegulation:async()=>{reads++;return view();}, getGrowth:async()=>[], getGrowthStatus:async()=>{growthStatusReads++;return growthStatus;} } as never);
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
      assert.equal((await request("/api/regulation",role)).status,403,role+" cannot read an administrator's internal audit");
      assert.equal((await request("/api/regulation",role,"POST")).status,403);
      assert.equal((await request("/api/bot/growth/status",role)).status,403,role+" cannot read rejected growth proposals even with notes permission");
      assert.equal((await request("/api/bot/growth/status",role,"POST")).status,403);
      assert.equal((await request("/api/archive/file?folder="+encodeURIComponent(archive)+"&file=regulation.jsonl",role)).status,403,"Archive grants cannot bypass the internal-audit restriction");
    }
    assert.equal(reads,0,"Unauthorized requests never load private regulation");
    assert.equal(growthStatusReads,0,"Unauthorized requests never read private growth review data");
    const status = await request("/api/bot/growth/status");
    assert.equal(status.status,200); assert.deepEqual(status.body,growthStatus);
    assert.deepEqual((await request("/api/bot/growth")).body,{growth:[]},"The public growth view keeps its existing array shape");
    assert.deepEqual((await request("/api/bot/growth","viewer")).body,{growth:[]},"Notes-authorized visitors retain the growth view without its audit");
    assert.equal((await request("/api/bot/growth/status","admin","POST")).status,405);
    assert.equal(growthStatusReads,1,"The growth status endpoint is read only");
    const result = await request("/api/regulation");
    assert.equal(result.status,200); assert.deepEqual(result.body,view(),"API exposes the direct documented view shape");
    enabled = false;
    assert.deepEqual((await request("/api/regulation")).body,view(),"Disabling simulation keeps existing audit inspectable");
    assert.equal((await request("/api/regulation","admin","POST")).status,405);
    assert.equal(reads,2,"Read-only inspector cannot dispatch a state mutation");
    assert.equal((await request("/api/archive/file?folder="+encodeURIComponent(archive)+"&file=regulation.jsonl")).body.content,original);
    for (const role of ["viewer","operator"]) {
      const listing = await request("/api/archive",role);
      assert.equal(listing.status,200);
      assert.ok(listing.body.snapshots.every((snapshot: any)=>snapshot.files.every((entry: any)=>entry.name!=="regulation.jsonl")),"Journal names and contents remain outside visitor archive projections");
    }
    let finish!: () => void;
    const changed = new Promise<void>(resolve=>{finish=resolve;});
    const frames: string[] = [];
    const client = {lastId:0,res:{write(frame:string){frames.push(frame);if(frame.includes('"file":"regulation"'))finish();},end(){}}};
    server.clients.add(client);
    await fs.appendFile(files.regulationJournal,'{"id":"new-local-update"}\n');
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([changed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("regulation file-watch update was not delivered")),2000);})]); }
    finally { if(timer)clearTimeout(timer);server.clients.delete(client); }
    assert.ok(frames.some(frame=>frame.includes('"channel":"file"')&&frame.includes('"file":"regulation"')));
    assert.ok(frames.every(frame=>!frame.includes("new-local-update")),"Watch notifications contain a refresh signal, not journal content");
    console.log("PASS regulation HTTP: admin-only view and archive access, disabled-state audit, no writes and real journal-watch refresh");
  } finally { await server.stop(); }
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(),"yesimbot-regulation-api-"));
  try { const prepared = await filesLifecycle(base); await httpAndWatch(base,prepared.files,prepared.archive,prepared.original); }
  finally { await fs.rm(base,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
