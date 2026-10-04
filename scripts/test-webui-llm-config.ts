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
  const received: { url: string; authorization: string; apiKey?: string; version?: string }[] = [];
  const endpoint = http.createServer((req, res) => {
    received.push({ url: req.url ?? "", authorization: req.headers.authorization ?? "",
      ...(req.headers["x-api-key"] ? { apiKey: String(req.headers["x-api-key"]) } : {}),
      ...(req.headers["anthropic-version"] ? { version: String(req.headers["anthropic-version"]) } : {}) });
    const url = new URL(req.url!, "http://fixture.invalid");
    if (url.pathname === "/rejected/models") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Rejected credential: " + (req.headers["x-api-key"] ?? req.headers.authorization) } })); return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/paged/models") {
      res.end(JSON.stringify(url.searchParams.has("after_id")
        ? { data: [{ id: "claude-a" }, { id: "claude-b" }], has_more: false, last_id: "claude-b" }
        : { data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a", next: "https://must-not-contact.invalid/models" })); return;
    }
    if (url.pathname === "/loop/models") {
      res.end(JSON.stringify({ data: [{ id: "same-cursor" }], has_more: true, last_id: "same-cursor" })); return;
    }
    if (url.pathname === "/bounded/models") {
      const index = Number(url.searchParams.get("after_id") || 0) + 1;
      res.end(JSON.stringify({ data: [{ id: "model-" + index }], has_more: true, last_id: String(index) })); return;
    }
    res.end(JSON.stringify({ data: [{ id: "fixture-model-a" }, { id: "fixture-model-b" }] }));
  });
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  const root = "http://127.0.0.1:" + (endpoint.address() as import("node:net").AddressInfo).port;
  const cfg: any = Config({ autoStart: false });
  cfg.webui = { ...cfg.webui, host: "127.0.0.1", port: 0, token: "fixture-admin-token" };
  cfg.bot.baseURL = root + "/bot"; cfg.bot.apiKey = "fixture-bot-key"; cfg.bot.model = "fixture-main";
  const independent = (label: string, apiKey: string) => ({ mode: "independent", baseURL: root + "/" + label, apiKey, model: "fixture-" + label, temperature: .2, maxTokens: 2048, stream: true, disableThinking: true });
  cfg.bot.growth.llm = independent("growth", "fixture-growth-key");
  cfg.apps.assistant = { ...cfg.apps.assistant, ...independent("assistant", "fixture-assistant-key") };
  cfg.apps.camera = { ...cfg.apps.camera, baseURL: root + "/camera", model: "image-model", apiKey: "fixture-camera-key" };
  cfg.bot.regulation = { enabled: true, llm: independent("retired", "fixture-retired-private-key") };
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
    assert.equal(listed.body.value.bot.strictToolLoop, true, "Waiting for the actual tool result is the default");
    assert.equal(listed.body.value.bot.thinkEnabled, true);
    assert.equal(listed.body.value.bot.unrestrictedPhone, true);
    assert.equal(listed.body.value.bot.apiType, "chat-completions");
    assert.equal(listed.body.value.world.apiType, "chat-completions");
    assert.equal(listed.body.value.apps.assistant.apiType, "chat-completions");
    assert.equal(listed.body.value.bot.apiKey, SECRET_MASK);
    assert.equal(listed.body.value.bot.growth.llm.apiKey, SECRET_MASK);
    assert.equal(listed.body.value.apps.camera.apiKey, SECRET_MASK);
    assert.equal(listed.body.value.apps.assistant.apiKey, SECRET_MASK);
    assert.equal("regulation" in listed.body.value.bot, false, "Retired model configuration is not exposed");
    assert.ok(!JSON.stringify(listed.body).includes("fixture-retired-private-key"), "Unknown legacy keys must not bypass schema-based secret masking");
    assert.equal(cfg.bot.regulation.llm.apiKey, "fixture-retired-private-key", "Reading configuration does not mutate the loader-owned source");
    assert.ok(!JSON.stringify(listed.body).includes("fixture-growth-key"));
    listed.body.value.bot.growth.llm.temperature = .6;
    listed.body.value.bot.strictToolLoop = false;
    listed.body.value.bot.thinkEnabled = false;
    listed.body.value.bot.unrestrictedPhone = false;
    listed.body.value.bot.blockingAct = false;
    listed.body.value.bot.sendBlocking = true;
    listed.body.value.bot.regulation = cfg.bot.regulation;
    assert.equal((await request("/api/config", { config: listed.body.value })).status, 200);
    assert.equal(host.config.bot.growth.llm.apiKey, "fixture-growth-key", "Unchanged nested masks restore their own group's key");
    assert.equal(host.config.bot.apiKey, "fixture-bot-key");
    assert.equal(host.config.apps.camera.apiKey, "fixture-camera-key");
    assert.equal(host.config.apps.assistant.apiKey, "fixture-assistant-key");
    assert.equal(host.config.bot.growth.llm.temperature, .6);
    assert.equal(host.config.bot.strictToolLoop, false, "The normal configuration save path preserves the optional concurrent mode");
    assert.equal(host.config.bot.thinkEnabled, false, "Inner speech is independently configurable through the normal UI API");
    assert.equal(host.config.bot.unrestrictedPhone, false, "Strict physical phone constraints remain selectable");
    assert.equal(host.config.bot.blockingAct, false);
    assert.equal(host.config.bot.sendBlocking, true, "Independent fallback policies do not overwrite each other");
    assert.equal("regulation" in host.config.bot, false, "A stale browser cannot persist retired settings on save");

    for (const [group, suffix, expected] of [["bot", "bot", "fixture-bot-key"], ["bot.growth.llm", "growth", "fixture-growth-key"], ["apps.assistant", "assistant", "fixture-assistant-key"], ["apps.camera", "camera", "fixture-camera-key"]]) {
      const result = await request("/api/llm/models", { group, baseURL: root + "/" + suffix, apiKey: SECRET_MASK });
      assert.equal(result.status, 200); assert.deepEqual(result.body.models, ["fixture-model-a", "fixture-model-b"]);
      assert.deepEqual(received.at(-1), { url: "/" + suffix + "/models", authorization: "Bearer " + expected });
    }
    await request("/api/llm/models", { group: "bot.growth.llm", baseURL: root + "/no-key", apiKey: "" });
    assert.equal(received.at(-1)?.authorization, "", "Independent empty keys never fall back to the Bot key");
    await request("/api/llm/models", { group: "bot.growth.llm", baseURL: root + "/draft", apiKey: "fixture-new-key" });
    assert.equal(received.at(-1)?.authorization, "Bearer fixture-new-key", "Connection checks use the unsaved draft key when supplied");
    const calls = received.length;
    assert.equal((await request("/api/llm/models", { group: "bot.growth", baseURL: root, apiKey: SECRET_MASK })).status, 400);
    assert.equal((await request("/api/llm/models", { group: "bot.regulation.llm", baseURL: root, apiKey: SECRET_MASK })).status, 400);
    assert.equal((await request("/api/llm/models", { group: "bot.growth.llm", baseURL: root, apiKey: SECRET_MASK }, false)).status, 401);
    assert.equal(received.length, calls, "Invalid groups and anonymous calls cannot trigger credential-bearing requests");

    host.config.world.apiType = "anthropic"; host.config.world.apiKey = "fixture-world-key";
    const inheritedProtocol = await request("/api/llm/models", { group: "world", baseURL: root + "/v1/messages", apiKey: SECRET_MASK });
    assert.equal(inheritedProtocol.status, 200);
    assert.deepEqual(received.at(-1), { url: "/v1/models", authorization: "", apiKey: "fixture-world-key", version: "2023-06-01" }, "absent draft protocol uses this group's current API, never the Bot protocol");
    const draftProtocol = await request("/api/llm/models", { group: "world", baseURL: root + "/v1/responses", apiKey: "fixture-draft-key", apiType: "responses" });
    assert.equal(draftProtocol.status, 200);
    assert.deepEqual(received.at(-1), { url: "/v1/models", authorization: "Bearer fixture-draft-key" }, "unsaved protocol changes take effect for the probe without changing saved configuration");
    assert.equal(host.config.world.apiType, "anthropic");
    for (const apiType of ["chat-completions", "responses", "anthropic"]) {
      const rootResult = await request("/api/llm/models", { group: "bot", baseURL: root, apiKey: "fixture-root-key", apiType });
      assert.equal(rootResult.status, 200); assert.equal(received.at(-1)!.url, "/v1/models");
      assert.equal(received.at(-1)!.authorization, apiType === "anthropic" ? "" : "Bearer fixture-root-key");
    }
    const pagesBefore = received.length;
    const paged = await request("/api/llm/models", { group: "world", baseURL: root + "/paged/messages", apiKey: SECRET_MASK });
    assert.equal(paged.status, 200); assert.deepEqual(paged.body.models, ["claude-a", "claude-b"]);
    assert.equal(received.length - pagesBefore, 2);
    assert.equal(received.at(-1)!.url, "/paged/models?after_id=claude-a", "pagination changes only the same endpoint's opaque cursor");
    assert.ok(received.slice(pagesBefore).every(entry => entry.apiKey === "fixture-world-key" && entry.version === "2023-06-01"));
    const loopBefore = received.length;
    assert.equal((await request("/api/llm/models", { group: "world", baseURL: root + "/loop", apiKey: SECRET_MASK })).status, 500);
    assert.equal(received.length - loopBefore, 2, "a repeated cursor cannot trigger unbounded requests");
    const boundedBefore = received.length;
    const bounded = await request("/api/llm/models", { group: "world", baseURL: root + "/bounded", apiKey: SECRET_MASK });
    assert.equal(bounded.status, 200); assert.equal(bounded.body.models.length, 5); assert.equal(received.length - boundedBefore, 5);
    const errorResult = await request("/api/llm/models", { group: "world", baseURL: root + "/rejected", apiKey: SECRET_MASK });
    assert.equal(errorResult.status, 500); assert.match(errorResult.body.error, /401/);
    assert.ok(!JSON.stringify(errorResult.body).includes("fixture-world-key"), "upstream credential echoes are redacted before returning errors");
    host.config.captioners.audio.apiType = "anthropic";
    host.config.captioners.audio.api = "transcription";
    assert.equal((await request("/api/llm/models", { group: "captioners.audio", baseURL: root + "/audio", apiKey: "whisper-key" })).status, 200);
    assert.deepEqual(received.at(-1), { url: "/audio/models", authorization: "Bearer whisper-key" }, "Whisper discovery stays independent from the unused conversational API setting");
    const invalidBefore = received.length;
    for (const apiType of ["openai", "messages", false, []]) assert.equal((await request("/api/llm/models", { group: "bot", baseURL: root, apiKey: SECRET_MASK, apiType })).status, 400);
    assert.equal(received.length, invalidBefore);
    for (const bot of ["invalid", 42, []]) {
      assert.equal((await request("/api/config", { config: { ...listed.body.value, bot } })).status, 400,
        "Retired setting cleanup leaves invalid structures to the normal configuration validator");
    }
    const clear = (await request("/api/config")).body.value;
    clear.bot.strictToolLoop = true;
    clear.bot.growth.llm.mode = "inherit";
    assert.equal((await request("/api/config", { config: clear })).status, 200);
    assert.equal(host.config.bot.growth.llm.apiKey, "fixture-growth-key", "Switching to inheritance retains the independent draft key");
    assert.equal(host.config.bot.growth.llm.mode, "inherit");
    assert.equal(host.config.bot.strictToolLoop, true);
    assert.equal(host.config.bot.blockingAct, false, "Enabling strict mode preserves the user's concurrent-mode policy for later");
    assert.equal(host.config.bot.apiKey, "fixture-bot-key");
    clear.bot.growth.llm.apiKey = "";
    assert.equal((await request("/api/config", { config: clear })).status, 200);
    assert.equal(host.config.bot.growth.llm.apiKey, "", "Explicitly clearing an independent key is preserved");
    assert.equal(saves, 3);
    console.log("PASS WebUI independent LLM config: nested masking/save/clear, per-group model lists, draft keys, no inherited credential fallback and admin access");
  } finally {
    await server.stop();
    endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
