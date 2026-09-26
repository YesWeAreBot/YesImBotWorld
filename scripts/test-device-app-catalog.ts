import assert from "node:assert/strict";
import { Config } from "../src/config.js";
import { deviceAppCatalog } from "../src/webui/app-catalog.js";
import { WorldService } from "../src/service.js";

async function main() {
  const config = Config({ autoStart: false });
  config.world.model = "world-model";
  config.apps.camera.apiKey = "must-not-leak-camera";
  config.apps.assistant.apiKey = "must-not-leak-assistant";
  const installed = [{ id: "clock", name: "时钟", description: "clock", kind: "app" as const, active: false }];
  const ready = deviceAppCatalog(config, installed, true);
  assert.equal(ready.find(app => app.id === "clock")?.status, "ready");
  for (const id of ["camera", "assistant"]) assert.equal(ready.find(app => app.id === id)?.status, "disabled");
  assert.ok(!JSON.stringify(ready).includes("must-not-leak"));
  config.apps.camera.enabled = true;
  assert.equal(deviceAppCatalog(config, installed, true).find(app => app.id === "camera")?.status, "unconfigured");
  config.apps.camera.model = "fixture-image";
  assert.equal(deviceAppCatalog(config, [], false).find(app => app.id === "camera")?.status, "stopped");
  config.apps.assistant.enabled = true;
  config.apps.assistant.name = "星际问答";
  config.apps.assistant.mode = "independent";
  assert.equal(deviceAppCatalog(config, installed, true).find(app => app.id === "assistant")?.status, "unconfigured");
  config.apps.assistant.model = "fixture-assistant";
  config.apps.assistant.baseURL = "https://fixture.invalid/v1";
  const assistant = { id: "assistant", name: "星际问答", description: "assistant", kind: "app" as const, active: true };
  assert.equal(deviceAppCatalog(config, [assistant], true).find(app => app.id === "assistant")?.active, true);
  assert.equal(deviceAppCatalog(config, [assistant], false).find(app => app.id === "assistant")?.active, false);

  // Exercise the actual service response: admin setup entries never enter the installed/tool lists.
  const service: any = Object.create(WorldService.prototype);
  const notifications = { mode: "vibrate", managed: false, unread: 0, count: 0, channels: [] };
  Object.assign(service, { config, worldActive: false, devicePending: 0,
    store: { knownChannels: async () => [], recentChannels: async () => [] },
    notifyMgr: { snapshot: (keys: string[]) => { assert.deepEqual(keys, []); return notifications; } },
    devicesInfo: async () => ({ phone: { channelKey: null, chatOpen: false }, computer: {} }),
    deviceToolDefs: () => [],
  });
  const stopped = await service.deviceSession();
  assert.equal(stopped.running, false);
  assert.deepEqual(stopped.apps, []);
  assert.deepEqual(stopped.tools, []);
  assert.deepEqual(stopped.notifications, notifications);
  assert.ok(stopped.appCatalog.some((entry: any) => entry.id === "clock" && entry.configurable));
  assert.ok(stopped.appCatalog.some((entry: any) => entry.id === "camera" && entry.status === "stopped"));
  assert.ok(!JSON.stringify(stopped).includes("must-not-leak"));
  console.log("PASS real device session catalog: setup while stopped, disabled/unconfigured app discovery, no fake installed tools or credential leaks");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
