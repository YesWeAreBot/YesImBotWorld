import { AsyncLocalStorage } from "node:async_hooks";
import { h, type Bot, type Context } from "koishi";

const sends = new AsyncLocalStorage<object>();

function stickerImages(elements: h[]): h[] {
  return elements.flatMap(element => {
    const subtype = element.attrs.sub_type ?? element.attrs.subType;
    const sticker = (element.type === "img" || element.type === "image")
      && (subtype === 1 || subtype === "1" || subtype === 2 || subtype === "2");
    return [...(sticker ? [element] : []), ...stickerImages(element.children)];
  });
}

/** Keep Koishi's normal send/receipt hooks; repair OneBot's wire-only attribute at
 * the last element boundary. Both h() and session.transform() camelize sub_type,
 * while OneBot/NapCat encoders copy image attrs verbatim and NapCat reads only
 * sub_type. Changing the original element alone is therefore insufficient. */
export async function sendPlatformMessage(
  ctx: Pick<Context, "on">,
  bot: Bot,
  channelId: string,
  content: h.Fragment,
): Promise<string[]> {
  if (bot.platform !== "onebot" || !stickerImages(h.normalize(content)).length) {
    return bot.sendMessage(channelId, content);
  }
  const scope = {};
  let prepared = false;
  const dispose = ctx.on("before-send", session => {
    if (prepared || sends.getStore() !== scope || session.bot.sid !== bot.sid || session.channelId !== channelId) return;
    // Run before other hooks, and consume this scope before any nested sends.
    prepared = true;
    for (const element of stickerImages(session.elements ?? [])) {
      element.attrs.sub_type = Number(element.attrs.sub_type ?? element.attrs.subType);
      delete element.attrs.subType;
    }
  }, true);
  try {
    return await sends.run(scope, () => bot.sendMessage(channelId, content));
  } finally {
    dispose();
  }
}
