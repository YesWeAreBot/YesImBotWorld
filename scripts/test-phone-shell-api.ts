/** Phone-shell routes use service transactions; all requests stay on isolated loopback HTTP. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WebUIServer } from "../src/webui/server.js";

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-phone-shell-api-"));
  const config = Config({ autoStart: false });
  config.webui = { ...config.webui, host: "127.0.0.1", port: 0, token: "fixture-admin-token" };
  const files = new WorldFiles(directory);
  await files.ensure();
  const original = "<main>original shell</main>";
  const generated = "<main>generated shell</main>";
  await files.writePhoneShell(original);
  let generationCalls = 0;
  const saved: string[] = [];
  let generate: () => Promise<{ content: string; phone: { width: number; height: number } }> = async () => {
    throw new Error("generation must not run before administrator request");
  };
  let save: (content: string) => Promise<void> = content => files.writePhoneShell(content);
  const host: any = {
    config, configSchema: Config, files, webuiDir: path.join(directory, "webui"),
    regeneratePhoneShell: async () => { generationCalls++; return generate(); },
    savePhoneShell: async (content: string) => { saved.push(content); await save(content); },
  };
  const server: any = new WebUIServer(host);
  const lifecycle: string[] = [];
  server.sendEvent = (event: { channel: string; event?: string }) => {
    if (event.channel === "lifecycle") lifecycle.push(event.event!);
  };
  try {
    await server.start();
    const base = "http://127.0.0.1:" + server.server.address().port;
    const route = "/api/state/phone-shell";
    async function request(method: string, suffix = "", auth: string | null = "admin", body?: unknown) {
      const response = await fetch(base + route + suffix, {
        method,
        headers: {
          "content-type": "application/json",
          ...(auth === "admin" ? { authorization: "Bearer fixture-admin-token" }
            : auth ? { "x-visitor-token": auth } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as any };
    }

    assert.deepEqual(await request("GET"), { status: 200, body: { content: original } });
    assert.equal((await request("POST", "/generate", null)).status, 401);
    assert.equal((await request("PUT", "", null, { content: "unauthenticated" })).status, 401);
    for (const preset of ["viewer", "player", "operator", "custom"] as const) {
      assert.deepEqual(await server.visitors.create(preset, "fixture-password", preset), { ok: true });
      const { token } = await server.visitors.login(preset, "fixture-password");
      assert.equal((await request("POST", "/generate", token)).status, 403, preset + " cannot generate");
      assert.equal((await request("PUT", "", token, { content: preset })).status, 403, preset + " cannot save");
      const read = await request("GET", "", token);
      assert.equal(read.status, preset === "custom" ? 403 : 200, "Reading retains world_status authorization");
      if (read.status === 200) assert.equal(read.body.content, original);
    }
    assert.equal(generationCalls, 0);
    assert.deepEqual(saved, []);
    assert.deepEqual(lifecycle, []);

    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    generate = async () => {
      entered();
      await waiting;
      await files.writePhoneShell(generated);
      return { content: generated, phone: { width: 390, height: 844 } };
    };
    const pending = request("POST", "/generate");
    await started;
    assert.deepEqual(lifecycle, [], "No success is broadcast before the service transaction completes");
    assert.equal(await files.readPhoneShell(), original);
    release();
    assert.deepEqual(await pending, {
      status: 200, body: { ok: true, content: generated, phone: { width: 390, height: 844 } },
    });
    assert.equal(generationCalls, 1);
    assert.deepEqual(lifecycle, ["phoneShell"]);
    assert.equal((await request("GET")).body.content, generated);

    generate = async () => { throw new Error("fixture generation failed"); };
    assert.deepEqual(await request("POST", "/generate"), {
      status: 500, body: { error: "fixture generation failed" },
    });
    assert.equal(generationCalls, 2);
    assert.equal(await files.readPhoneShell(), generated, "Failed generation leaves the committed resource intact");
    assert.deepEqual(lifecycle, ["phoneShell"], "Failure emits no success lifecycle event");

    const edited = "<main>hand-edited shell</main>";
    assert.deepEqual(await request("PUT", "", "admin", { content: edited }), { status: 200, body: { ok: true } });
    assert.deepEqual(saved, [edited], "PUT delegates to the service lifecycle guard");
    assert.equal(await files.readPhoneShell(), edited);
    assert.deepEqual(lifecycle, ["phoneShell", "phoneShell"]);
    save = async () => { throw new Error("fixture save failed"); };
    assert.deepEqual(await request("PUT", "", "admin", { content: "rejected" }), {
      status: 500, body: { error: "fixture save failed" },
    });
    assert.deepEqual(saved, [edited, "rejected"]);
    assert.equal(await files.readPhoneShell(), edited);
    assert.deepEqual(lifecycle, ["phoneShell", "phoneShell"]);
    console.log("PASS phone-shell API: administrator generation/save, pending and failed transactions, success broadcasts, anonymous/visitor denial and read grants");
  } finally {
    await server.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
