/** Growth filters are forwarded before paging; raw time and invalid query values cannot change the ledger view. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WebUIServer } from "../src/webui/server.js";

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "growth-http-"));
  const calls: unknown[] = [];
  const item = { claimId: "old-preference", kind: "preference", subject: "早年偏好" };
  let legacy = false;
  const server = new WebUIServer({
    config: Config({ autoStart: false }), files: { base }, webuiDir: path.join(base, "webui"),
    getGrowth: async (query: unknown) => { calls.push(query); return legacy ? [] : { items: [item], total: 74, offset: 30, limit: 30, counts: { relationship: 0, commitment: 0, preference: 74, state: 90, habit: 0, trait: 0 } }; },
  } as never);
  const get = async (url: string) => {
    let status = 0, body = "";
    await (server as any).handle({ method: "GET", url, headers: {} }, { writeHead(code: number) { status = code; }, end(data: string) { body = String(data); } });
    return { status, body: JSON.parse(body) };
  };
  try {
    const result = await get("/api/bot/growth?kind=preference&keyword=" + encodeURIComponent("早年 偏好") + "&lifecycle=all&offset=30&limit=30&at=999999");
    assert.equal(result.status, 200);
    assert.deepEqual(calls[0], { kind: "preference", keyword: "早年 偏好", lifecycle: "all", offset: 30, limit: 30 });
    assert.deepEqual(result.body.growth, [item]);
    assert.equal(result.body.page.total, 74, "The HTTP layer retains the ledger's full filtered total, not the returned page size");
    assert.equal(result.body.page.counts.state, 90, "Other kinds remain counted outside the selected-kind page");
    await get("/api/bot/growth?limit=200");
    assert.deepEqual(calls.at(-1), { limit: 100 });
    await get("/api/bot/growth"); assert.deepEqual(calls.at(-1), {}, "Default scope belongs to the ledger, not a preliminary recall(n=50)");
    const before = calls.length;
    for (const query of ["kind=nope", "lifecycle=expired", "offset=-1", "offset=1.5", "limit=0", "limit=NaN", "offset=999999999999999999999"]) {
      assert.equal((await get("/api/bot/growth?" + query)).status, 400, query);
    }
    assert.equal(calls.length, before, "Malformed paging does not invoke the ledger");
    legacy = true;
    assert.deepEqual((await get("/api/bot/growth")).body, { growth: [] }, "Legacy test hosts retain the existing array envelope");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
  console.log("PASS growth HTTP: filter forwarding, explicit full counts, bounded paging, trusted clock, invalid-query rejection and array compatibility");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
