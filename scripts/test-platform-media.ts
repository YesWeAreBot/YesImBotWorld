/** Real Koishi normalization, Session.transform and before-send lifecycle; transport is offline. */
import assert from "node:assert/strict";
import { App, Bot, MessageEncoder, Universal, h, type Context } from "koishi";
import { sendPlatformMessage } from "../src/koishi/platform-media.js";

interface WireMessage { id: string; channel: string; direct: boolean; elements: { type: string; data: Record<string, any> }[] }
const transported: WireMessage[] = [];
const data = "data:image/png;base64,AQ==";
const photo = () => h("img", { src: data });
const sticker = (subtype = 1) => h("img", { src: data, sub_type: subtype, summary: "[动画表情]" });
const text = (session: any) => session.elements?.filter((element: h) => element.type === "text").map((element: h) => element.attrs.content).join("");
const images = (message: WireMessage) => message.elements.filter(element => element.type === "image").map(element => element.data);
function repaired(image: Record<string, any>, subtype = 1) {
  assert.equal(image.sub_type, subtype, "NapCat reads the exact snake_case protocol field");
  assert.equal("subType" in image, false, "camelCase must not survive into the wire payload");
  assert.equal(image.summary, "[动画表情]"); assert.equal(image.file, "base64://AQ==");
}
function untouched(image: Record<string, any>) { assert.equal("sub_type" in image, false); }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

class LocalEncoder extends MessageEncoder {
  private elements: WireMessage["elements"] = [];
  async prepare() { this.session.event.channel!.type = this.channelId.startsWith("private:") ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT; }
  async visit(element: h) {
    if (element.type === "text") { this.elements.push({ type: "text", data: { text: element.attrs.content } }); return; }
    if (element.type !== "img" && element.type !== "image") { await this.render(element.children); return; }
    // This is intentionally the adapter's original attrs-copy behavior, without an alias fallback.
    const attrs = { ...element.attrs, file: element.attrs.src || element.attrs.url };
    delete attrs.src; delete attrs.url;
    const prefix = /^data:([\w/.+-]+);base64,/.exec(attrs.file);
    if (prefix) attrs.file = "base64://" + attrs.file.slice(prefix[0].length);
    this.elements.push({ type: "image", data: attrs });
  }
  async flush() {
    if (this.elements.some(element => element.data.text === "FAIL")) throw new Error("offline transport failure");
    if (!this.elements.length) return;
    const id = `message-${transported.length + 1}`;
    transported.push({ id, channel: this.channelId, direct: this.session.isDirect, elements: this.elements.splice(0) });
    this.results.push({ id });
  }
}
class LocalBot extends Bot {
  static MessageEncoder = LocalEncoder;
  constructor(ctx: App) { super(ctx, {}); this.platform = "onebot"; this.selfId = "fixture-account"; this.status = Universal.Status.ONLINE; }
  dispose() { if (this.ctx.bots) return super.dispose(); }
}

async function main() {
  const app = new App(); app.plugin(LocalBot); await app.start();
  const bot = app.bots[0]!;
  let installed = 0, active = 0;
  const ctx = { on(...args: any[]) {
    installed++; active++;
    const dispose = (app.on as Function).apply(app, args);
    return () => { active--; dispose(); };
  } } as Pick<Context, "on">;
  const label = (value: string, image = sticker()) => [h.text(value), image];
  try {
    assert.equal(sticker().attrs.subType, 1, "real Koishi h() reproduces the original attribute normalization");
    await bot.sendMessage("group", sticker());
    assert.equal(images(transported.at(-1)!)[0]!.subType, 1);
    untouched(images(transported.at(-1)!)[0]!);

    for (const channel of ["group", "private:peer"]) {
      const original = [photo(), sticker(), photo()];
      const ids = await sendPlatformMessage(ctx, bot, channel, original);
      const message = transported.at(-1)!;
      assert.deepEqual(ids, [message.id]); assert.equal(message.direct, channel.startsWith("private:"));
      const result = images(message); assert.equal(result.length, 3);
      untouched(result[0]!); repaired(result[1]!); untouched(result[2]!);
      assert.equal(original[1]!.attrs.subType, 1, "the caller's elements are not rewritten");
      assert.equal("sub_type" in original[1]!.attrs, false);
      assert.equal(active, 0);
    }
    await sendPlatformMessage(ctx, bot, "group", sticker(2)); repaired(images(transported.at(-1)!)[0]!, 2);

    // Two tracked sends and an unrelated raw send share the exact bot/channel while one is paused.
    const entered = gate(), resume = gate();
    const releaseHook = app.on("before-send", async session => { if (text(session) === "slow") { entered.release(); await resume.promise; } });
    const slow = sendPlatformMessage(ctx, bot, "group", label("slow")); await entered.promise;
    assert.equal(active, 1);
    await sendPlatformMessage(ctx, bot, "group", label("concurrent")); repaired(images(transported.at(-1)!)[0]!);
    assert.equal(active, 1);
    await bot.sendMessage("group", label("unrelated"));
    untouched(images(transported.at(-1)!)[0]!); assert.equal(images(transported.at(-1)!)[0]!.subType, 1);
    resume.release(); await slow; repaired(images(transported.at(-1)!)[0]!);
    releaseHook(); assert.equal(active, 0);

    // Once the outer session is prepared, later hooks may recursively send without inheriting it.
    const removeNested = app.on("before-send", async session => { if (text(session) === "outer") await bot.sendMessage("group", label("nested")); });
    const beforeNested = transported.length;
    await sendPlatformMessage(ctx, bot, "group", label("outer")); removeNested();
    assert.equal(transported.length, beforeNested + 2);
    untouched(images(transported[beforeNested]!)[0]!);
    assert.equal(images(transported[beforeNested]!)[0]!.subType, 1);
    repaired(images(transported[beforeNested + 1]!)[0]!); assert.equal(active, 0);

    const cancel = app.on("before-send", session => text(session) === "CANCEL" ? true : undefined);
    const beforeCancel = transported.length;
    assert.deepEqual(await sendPlatformMessage(ctx, bot, "group", label("CANCEL")), []);
    assert.equal(transported.length, beforeCancel); assert.equal(active, 0); cancel();
    await assert.rejects(sendPlatformMessage(ctx, bot, "group", label("FAIL")), /offline transport failure/);
    assert.equal(active, 0);
    await bot.sendMessage("group", sticker()); untouched(images(transported.at(-1)!)[0]!);

    const previousInstalled = installed;
    await sendPlatformMessage(ctx, bot, "group", photo());
    bot.platform = "fixture";
    await sendPlatformMessage(ctx, bot, "group", sticker());
    assert.equal(installed, previousInstalled, "ordinary images and other platforms do not install a hook");
    assert.equal(images(transported.at(-1)!)[0]!.subType, 1); untouched(images(transported.at(-1)!)[0]!);
    assert.equal(active, 0);
    console.log("PASS platform media: real h/Session transform, exact OneBot snake_case wire field, photo/sticker/photo, group/private, concurrent and nested send isolation, cancellations/errors cleanup and unaffected platforms");
  } finally { await app.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
