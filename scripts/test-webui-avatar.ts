import assert from "node:assert/strict";
import { BotIdentityResolver, platformAvatar } from "../src/webui/avatar.js";

async function main() {
  let calls = 0;
  const a = { platform: "onebot", selfId: "first", isActive: true, user: { name: "First", avatar: "https://avatar.invalid/a.png" }, getLogin: async () => { calls++; return {}; } };
  const b = { platform: "onebot", selfId: "second", isActive: true, getLogin: async () => { calls++; return { user: { name: "Second", avatar: "https://avatar.invalid/b.png" } }; } };
  const resolver = new BotIdentityResolver();
  assert.equal((await resolver.resolve([a, b]))?.avatar, a.user.avatar);
  assert.equal(calls, 0, "Koishi's already-known avatar must not trigger profile requests");
  const [one, two] = await Promise.all([resolver.resolve([a, b], "onebot@second:room"), resolver.resolve([a, b], "onebot@second:room")]);
  assert.equal(one?.selfId, "second"); assert.deepEqual(one, two); assert.equal(calls, 1, "Concurrent overview reads coalesce per account");
  await resolver.resolve([b]); assert.equal(calls, 1, "Cache prevents profile fetches on every UI refresh");
  b.isActive = false;
  assert.equal((await resolver.resolve([a, b], "onebot@second:room"))?.selfId, "second", "An explicit offline account must not silently switch avatar");
  a.user.avatar = "https://avatar.invalid/new.png";
  assert.equal((await resolver.resolve([a]))?.avatar, a.user.avatar, "Koishi login updates are immediately reflected");
  const adapter = { platform: "satori", selfId: "self", isActive: true, getLogin: async () => ({}), getUser: async (id: string) => { assert.equal(id, "self"); return { name: "Self", avatar: "https://avatar.invalid/self.png" }; } };
  assert.equal((await resolver.resolve([adapter]))?.name, "Self");
  const stuck = { platform: "offline", selfId: "self", isActive: true, getLogin: () => new Promise<never>(() => {}) };
  assert.equal((await new BotIdentityResolver(5).resolve([stuck]))?.avatar, null, "An unresponsive adapter cannot stall the overview");
  for (const unsafe of ["javascript:alert(1)", "file:///etc/passwd", "https://secret:token@avatar.invalid/a", "data:image/svg+xml,abc", "not-a-url"]) assert.equal(platformAvatar(unsafe), null);
  assert.equal(await resolver.resolve([]), null);
  console.log("PASS platform avatars: Koishi login/profile fallback, correct account, coalescing/cache, updates, bounded failures and safe URLs");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
