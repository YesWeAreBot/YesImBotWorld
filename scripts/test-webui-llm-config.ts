/** Separate model groups and masked credentials; only isolated loopback HTTP is used. */
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WebUIServer, SECRET_MASK } from "../src/webui/server.js";

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-model-config-"));
  const received: { url: string; authorization: string }[] = [];
  const endpoint = http.createServer((req, res) => {
    received.push({ url: req.url ?? "", authorization: req.headers.authorization ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fixture-model-a" }, { id: "fixture-model-b" }] }));
  });
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  const root = "http://127.0.0.1:" + (endpoint.address() as import("node:net").AddressInfo).port;
  const cfg: any = Config({ autoStart: false });
  cfg.webui = { ...cfg.webui, host: "127.0.0.1", port: 0, token: "fixture-admin-token" };
  cfg.bot.baseURL = root + "/bot"; cfg.bot.apiKey = "fixture-bot-key"; cfg.bot.model = "fixture-main";
  const independent = (label: string, apiKey: string) => ({ mode: "independent", baseURL: root + "/" + label, apiKey, model: "fixture-" + label, temperature: .2, maxTokens: 2048, stream: true, disableThinking: true });
  cfg.bot.growth.llm = independent("growth", "fixture-growth-key");
  cfg.bot.regulation.llm = independent("regulation", "fixture-regulation-key");
  const files = new WorldFiles(directory); await files.ensure();
  let saves = 0;
  const host: any = { config: cfg, configSchema: Config, files, webuiDir: path.join(directory, "webui"), applyConfig: async (next: any) => { host.config = next; saves++; return { ok: true }; } };
  const server: any = new WebUIServer(host);
  try {
    await server.start();
    // Bind ephemerally, then expose the actual valid port in editable configuration.
    host.config.webui.port = server.server.address().port;
    const url = "http://127.0.0.1:" + server.server.address().port;
    async function request(resource: string, data?: unknown, authorization = true) {
      const response = await fetch(url + resource, { method: data === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization: "Bearer fixture-admin-token" } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json() as any };
    }
    const listed = await request("/api/config");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.value.bot.apiKey, SECRET_MASK);
    assert.equal(listed.body.value.bot.growth.llm.apiKey, SECRET_MASK);
    assert.equal(listed.body.value.bot.regulation.llm.apiKey, SECRET_MASK);
    assert.ok(!JSON.stringify(listed.body).includes("fixture-growth-key"));
    assert.ok(!JSON.stringify(listed.body).includes("fixture-regulation-key"));
    listed.body.value.bot.growth.llm.temperature = .6;
    assert.equal((await request("/api/config", { config: listed.body.value })).status, 200);
    assert.equal(host.config.bot.growth.llm.apiKey, "fixture-growth-key", "Unchanged nested masks restore their own group's key");
    assert.equal(host.config.bot.regulation.llm.apiKey, "fixture-regulation-key");
    assert.equal(host.config.bot.apiKey, "fixture-bot-key");
    assert.equal(host.config.bot.growth.llm.temperature, .6);

    for (const [group, suffix, expected] of [["bot", "bot", "fixture-bot-key"], ["bot.growth.llm", "growth", "fixture-growth-key"], ["bot.regulation.llm", "regulation", "fixture-regulation-key"]]) {
      const result = await request("/api/llm/models", { group, baseURL: root + "/" + suffix, apiKey: SECRET_MASK });
      assert.equal(result.status, 200); assert.deepEqual(result.body.models, ["fixture-model-a", "fixture-model-b"]);
      assert.deepEqual(received.at(-1), { url: "/" + suffix + "/models", authorization: "Bearer " + expected });
    }
    await request("/api/llm/models", { group: "bot.regulation.llm", baseURL: root + "/no-key", apiKey: "" });
    assert.equal(received.at(-1)?.authorization, "", "Independent empty keys never fall back to the Bot key");
    await request("/api/llm/models", { group: "bot.growth.llm", baseURL: root + "/draft", apiKey: "fixture-new-key" });
    assert.equal(received.at(-1)?.authorization, "Bearer fixture-new-key", "Connection checks use the unsaved draft key when supplied");
    const calls = received.length;
    assert.equal((await request("/api/llm/models", { group: "bot.growth", baseURL: root, apiKey: SECRET_MASK })).status, 400);
    assert.equal((await request("/api/llm/models", { group: "bot.regulation.llm.__proto__", baseURL: root, apiKey: SECRET_MASK })).status, 400);
    assert.equal((await request("/api/llm/models", { group: "bot.growth.llm", baseURL: root, apiKey: SECRET_MASK }, false)).status, 401);
    assert.equal(received.length, calls, "Invalid groups and anonymous calls cannot trigger credential-bearing requests");
    const clear = (await request("/api/config")).body.value;
    clear.bot.regulation.llm.apiKey = ""; clear.bot.growth.llm.mode = "inherit";
    assert.equal((await request("/api/config", { config: clear })).status, 200);
    assert.equal(host.config.bot.regulation.llm.apiKey, "", "Explicitly clearing an independent key is preserved");
    assert.equal(host.config.bot.growth.llm.apiKey, "fixture-growth-key", "Switching to inheritance retains the independent draft key");
    assert.equal(host.config.bot.growth.llm.mode, "inherit");
    assert.equal(host.config.bot.apiKey, "fixture-bot-key");
    assert.equal(saves, 2);
    console.log("PASS WebUI independent LLM config: nested masking/save/clear, per-group model lists, draft keys, no inherited credential fallback and admin access");
  } finally {
    await server.stop();
    endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
