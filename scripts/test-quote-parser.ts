/** Pure quote grammar and read projection boundaries; no platform or model calls. */
import assert from "node:assert/strict";
import { quoteTag, resolveOutgoingQuote, storedQuoteContent } from "../src/koishi/quotes.js";
import { MediaRenderer } from "../src/media/render.js";

async function main() {
  const target = "satori.message_A-9:opaque&part";
  const tag = quoteTag({ id: target });
  for (const [body, reply, expected] of [
    [tag + " \n\t 正文", target, "正文"],
    [tag + "  " + tag + "\n正文", target, "正文"],
    ["甲" + tag + " 乙" + tag + "\n丙", target, "甲乙丙"],
    [quoteTag({ id: target, text: 'id="not-an-id" <media id="12" type="image"/> x > y' }) + "正文", undefined, "正文"],
    [`<quote id='${target}'/>正文`, target, "正文"],
    [`<quote id="${target}"><quote id="nested-preview"/>引用预览</quote>正文`, target, "正文"],
  ] as const) assert.deepEqual(resolveOutgoingQuote(body, reply), { msg: expected, replyTo: target });
  for (const body of ['<quote bad:id="fake"/>正文', '<quote id="real" bad:id="fake"/>正文', '<quote id="real" dangling/>正文',
    '<quote id="real" id="different"/>正文', '<quote id="real"/><quote id="different"/>正文',
    '<quote/>正文', '<quote id="real">未闭合', '</quote>正文']) {
    assert.ok(resolveOutgoingQuote(body).error, `malformed/conflicting quote must fail instead of silently consuming ordinary text: ${body}`);
  }
  for (const text of ['  保留正文缩进', '正文 <quote-example> 不是真正的引用标签', '示例 &lt;quote id="x"/&gt; 原样显示', '[引用 msg:x] 是正文中的字面内容']) {
    assert.deepEqual(resolveOutgoingQuote(text), { msg: text });
    assert.equal(storedQuoteContent({ content: text }), text, "no recorded reply metadata means no conversion of literal content");
  }
  const conversation: any = { reply: { messageId: "old-id" } };
  const old = { content: '[引用 msg:old-id] \n旧正文', conversation };
  assert.equal(storedQuoteContent(old), '<quote id="old-id"/>旧正文');
  assert.equal(old.content, '[引用 msg:old-id] \n旧正文', "legacy projection does not mutate persisted content");
  assert.equal(storedQuoteContent({ content: '[引用 msg:different] 字面正文', conversation }), '[引用 msg:different] 字面正文');
  assert.equal(storedQuoteContent({ content: '<quote-example>文字', conversation }), '<quote id="old-id"/> <quote-example>文字', "lookalike element names cannot hide the recorded actual reply");
  let reads = 0;
  const renderer = new MediaRenderer({ get: async () => { reads++; throw new Error("quote preview must not look up media"); } } as any, {} as any, () => false, 5);
  const preview = quoteTag({ id: target, name: '<media id="99" type="image"/>', text: '<media id="12" type="image"/> &quot; <quote id="wrong"/>' }) + "正文";
  assert.deepEqual(await renderer.render(preview), { text: preview });
  assert.equal(reads, 0, "escaped quote preview tokens cannot impersonate downloaded assets or attach unrelated images");
  assert.deepEqual(resolveOutgoingQuote(preview), { msg: "正文", replyTo: target });
  console.log("PASS quote parser: strict attributes, repeated/conflicting targets, ordinary text, conservative legacy projection and inert multimodal previews");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
