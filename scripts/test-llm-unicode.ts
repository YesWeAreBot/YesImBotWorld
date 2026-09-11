import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ChatClient, type ChatMessage } from "../src/llm/chat.js";
import { normalizeChatRequest } from "../src/llm/normalize.js";
import { sliceText, toWellFormedText } from "../src/text.js";
import { debug } from "../src/webui/debug.js";

function slicing() {
  const value = "A😀B😮C";
  assert.equal(sliceText(value, 0, 2), "A", "a head boundary must exclude the entire split emoji");
  assert.equal(sliceText(value, 2), "B😮C", "a tail boundary must not start with a low surrogate");
  assert.equal(sliceText(value, 1, 3), "😀", "complete pairs remain intact");
  assert.equal(sliceText(value, -4), "B😮C");
  assert.equal(sliceText(value, 3, 1), "");
  assert.equal(sliceText(value, 0, Infinity), value);
  assert.equal(sliceText("plain", -3, -1), "ai");
  assert.equal(toWellFormedText("A\uD83DB\uDE00C😀"), "A�B�C😀");
  // Reproduce the production trigger without retaining its private message.
  const message = "x".repeat(23) + "😮";
  assert.equal(message.slice(0, 24), "x".repeat(23) + "\uD83D");
  assert.equal(sliceText(message, 0, 24) + "…", "x".repeat(23) + "…");
}

function nativeArguments() {
  const argumentText = '{ "message": "before\\ud83dafter", "count": 2, "largeId": 9007199254740993 }';
  const input = {
    messages: [{ role: "assistant", content: "", tool_calls: [{
      id: "call_1", type: "function", function: { name: "act", arguments: argumentText },
    }] }],
    tools: [{ type: "function", function: { name: "act", description: "safe😀", parameters: { type: "object" } } }],
  };
  const normalized = normalizeChatRequest(input);
  assert.equal(normalized.repairedStrings, 1);
  assert.equal((normalized.body.messages as typeof input.messages)[0]!.tool_calls[0]!.function.arguments,
    '{ "message": "before�after", "count": 2, "largeId": 9007199254740993 }',
    "unrelated numbers, field order and whitespace survive argument repair exactly");
  assert.equal(input.messages[0]!.tool_calls[0]!.function.arguments, argumentText, "saved tool arguments are untouched");
  assert.equal(normalizeChatRequest(normalized.body).repairedStrings, 0, "normalization is idempotent");

  const valid = { messages: [{ role: "assistant", content: "", tool_calls: [{
    id: "call_ok", type: "function", function: { name: "act", arguments: '{ "msg": "emoji😀", "literal": "\\\\ud83d" }' },
  }] }] };
  assert.deepEqual(normalizeChatRequest(valid), { body: valid, repairedStrings: 0 },
    "valid argument JSON, including literal backslash escapes and whitespace, is byte-for-byte preserved");
}

async function transport() {
  const received: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received.push(body);
    // Fast tokenizers reject these decoded strings. The fixture checks through
    // the runtime's independent Unicode predicate, without any model inference.
    const valid = (value: unknown): boolean => typeof value === "string"
      ? (value as string & { isWellFormed(): boolean }).isWellFormed()
      : Array.isArray(value) ? value.every(valid)
      : value && typeof value === "object" ? Object.values(value).every(valid) : true;
    if (!valid(body)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  try {
    const invalid = "[notice] " + ("x".repeat(23) + "😮").slice(0, 24) + "…";
    const messages: ChatMessage[] = [
      { role: "system", content: "Keep the complete role definition: 你好😀" },
      { role: "user", content: invalid },
      { role: "assistant", content: "", tool_calls: [{ id: "call_2", type: "function", function: { name: "observe", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_2", content: "The scene is unchanged." },
      { role: "user", content: [
        { type: "text", text: "before😀\uDE00after" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        { type: "text", text: "Audio and video remain attached." },
        { type: "input_audio", input_audio: { format: "wav", data: "BB==" } },
        { type: "video_url", video_url: { url: "https://fixture.invalid/example.mp4" } },
      ] },
    ];
    const original = structuredClone(messages);
    // The old wire shape fails without calling a real LLM.
    const rejected = await fetch(baseURL + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /TextEncodeInput/);

    const client = new ChatClient({ baseURL, model: "isolated-unicode-test", stream: false, label: "UnicodeTest" });
    assert.equal((await client.complete(messages)).content, "ok");
    const sent = received[1]!;
    assert.equal(sent.messages[1].content, "[notice] " + "x".repeat(23) + "�…");
    assert.equal(sent.messages[4].content[0].text, "before😀�after");
    assert.deepEqual(sent.messages[4].content.slice(1), original[4]!.content.slice(1), "no modality is disabled or removed");
    assert.deepEqual(sent.messages.slice(2, 4), original.slice(2, 4), "tool result pairing and arguments remain unchanged");
    assert.deepEqual(messages, original, "normalization never overwrites historical context");
    const request = debug.recent(20).find(entry => entry.label === "UnicodeTest·请求发送");
    assert.ok(request);
    assert.equal(JSON.parse(request.detail).unicodeRepairedStrings, 2, "the repair is visible in request diagnostics");
    assert.equal(received.length, 2, "no retry or blind attachment fallback is used");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

async function main() {
  slicing(); nativeArguments(); await transport();
  console.log("PASS LLM Unicode: safe truncation, legacy context repair, native arguments, unchanged multimodal/tool payloads; fake loopback endpoint only.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
