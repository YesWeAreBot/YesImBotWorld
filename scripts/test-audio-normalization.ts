import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AudioNormalizationError, normalizeAudio } from "../src/media/audio.js";

function wave(rate = 8000): Buffer {
  const count = Math.floor(rate / 10), data = Buffer.alloc(44 + count * 2);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) data.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 8192), 44 + index * 2);
  return data;
}
const hasCode = (code: string) => (error: unknown) => error instanceof AudioNormalizationError && error.code === code;
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "test-audio-normalization-"));
  const temporaryRoot = path.join(directory, "decode"); await fs.mkdir(temporaryRoot);
  const source = wave(), original = Buffer.from(source);
  const clean = async () => assert.deepEqual(await fs.readdir(temporaryRoot), [], "temporary input/output must be removed on every path");
  async function executable(name: string, body: string) {
    const file = path.join(directory, name);
    await fs.writeFile(file, `#!${process.execPath}\n${body}`, { mode: 0o700 }); return file;
  }
  try {
    await assert.rejects(normalizeAudio(Buffer.alloc(0), { temporaryRoot }), hasCode("AUDIO_EMPTY"));
    await assert.rejects(normalizeAudio(source, { temporaryRoot, maxInputBytes: 1 }), hasCode("AUDIO_INPUT_TOO_LARGE"));
    await assert.rejects(normalizeAudio(source, { temporaryRoot, ffmpegPath: path.join(directory, "missing") }), hasCode("AUDIO_DECODER_UNAVAILABLE"));
    await clean();
    const sleeping = await executable("sleeping-decoder", "setInterval(() => {}, 1000);\n");
    await assert.rejects(normalizeAudio(source, { temporaryRoot, ffmpegPath: sleeping, timeoutMs: 50 }), hasCode("AUDIO_TIMEOUT"));
    await clean();
    const controller = new AbortController();
    const interrupted = normalizeAudio(source, { temporaryRoot, ffmpegPath: sleeping, signal: controller.signal });
    const aborting = setTimeout(() => controller.abort(), 25);
    await assert.rejects(interrupted, hasCode("AUDIO_CANCELLED")); clearTimeout(aborting); await clean();
    const bad = await executable("bad-decoder", "process.stderr.write('no usable audio stream'); process.exit(1);\n");
    await assert.rejects(normalizeAudio(source, { temporaryRoot, ffmpegPath: bad }), hasCode("AUDIO_DECODE_FAILED"));
    await clean();
    const invalid = await executable("invalid-output", "require('node:fs').writeFileSync(process.argv.at(-1), 'not a wav');\n");
    await assert.rejects(normalizeAudio(source, { temporaryRoot, ffmpegPath: invalid }), hasCode("AUDIO_INVALID_OUTPUT"));
    await clean();
    const valid = await executable("valid-output", `
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
assert.ok(!args[args.indexOf('-format_whitelist') + 1].split(',').some(format => ['hls','concat','dash','image2'].includes(format)));
assert.equal(args[args.indexOf('-map') + 1], '0:a:0');
require('node:fs').writeFileSync(args.at(-1), Buffer.from('${wave(16000).toString("base64")}', 'base64'));
`);
    const normalized = await normalizeAudio(source, { temporaryRoot, ffmpegPath: valid });
    assert.equal(normalized.readUInt32LE(24), 16000); assert.deepEqual(source, original); await clean();
    await assert.rejects(normalizeAudio(source, { temporaryRoot, ffmpegPath: valid, maxOutputBytes: 100 }), hasCode("AUDIO_OUTPUT_TOO_LARGE"));
    await clean();
    const ffmpeg = process.env.YESIMBOT_TEST_FFMPEG ?? "ffmpeg";
    let available = true;
    try { execFileSync(ffmpeg, ["-version"], { stdio: "ignore", timeout: 5000 }); } catch { available = false; }
    if (available) {
      const rawWav = await normalizeAudio(source, { temporaryRoot, ffmpegPath: ffmpeg });
      assert.equal(rawWav.toString("ascii", 0, 4), "RIFF"); assert.notDeepEqual(rawWav, source, "8kHz input is actually resampled, not relabeled");
      const input = path.join(directory, "source.wav"); await fs.writeFile(input, source);
      const encoders = execFileSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 5000 });
      const fixtures = [["source.aac", "aac", "adts"], ["source.webm", "libopus", "webm"], ["source.m4a", "aac", "ipod"], ["source.mp3", "libmp3lame", "mp3"]];
      for (const [codec, name] of [["libopencore_amrnb", "source-nb.amr"], ["libvo_amrwbenc", "source-wb.amr"]]) {
        if (encoders.includes(codec!)) fixtures.push([name!, codec!, "amr"]);
        else console.log(`SKIP ${codec} synthetic fixture: encoder unavailable`);
      }
      for (const [name, codec, format] of fixtures) {
        const encoded = path.join(directory, name!);
        const bitrate = codec === "libopencore_amrnb" ? ["-b:a", "12.2k"] : codec === "libvo_amrwbenc" ? ["-b:a", "23.85k", "-ar", "16000"] : [];
        execFileSync(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", input, "-c:a", codec!, ...bitrate, "-f", format!, encoded], { timeout: 5000 });
        const bytes = await fs.readFile(encoded), result = await normalizeAudio(bytes, { temporaryRoot, ffmpegPath: ffmpeg });
        assert.equal(result.toString("ascii", 0, 4), "RIFF"); assert.equal(result.toString("ascii", 8, 12), "WAVE");
        assert.ok(result.length > 44); assert.notDeepEqual(result, bytes);
        if (format === "amr") await assert.rejects(normalizeAudio(bytes.subarray(0, bytes.length - 1), { temporaryRoot, ffmpegPath: ffmpeg }), hasCode("AUDIO_DECODE_FAILED"), "an incomplete final AMR frame is not a complete voice recording");
      }
      await assert.rejects(normalizeAudio(Buffer.from("corrupt audio"), { temporaryRoot, ffmpegPath: ffmpeg }), hasCode("AUDIO_DECODE_FAILED"));
      await assert.rejects(normalizeAudio(source.subarray(0, source.length - 1), { temporaryRoot, ffmpegPath: ffmpeg }), hasCode("AUDIO_DECODE_FAILED"), "a corrupt last PCM frame must not be silently dropped");
      await assert.rejects(normalizeAudio(Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile://${input}\n#EXT-X-ENDLIST\n`), { temporaryRoot, ffmpegPath: ffmpeg }), hasCode("AUDIO_DECODE_FAILED"));
      await assert.rejects(normalizeAudio(source, { temporaryRoot, ffmpegPath: ffmpeg, maxOutputBytes: 100 }), hasCode("AUDIO_OUTPUT_TOO_LARGE"));
      await clean();
      console.log("PASS real ffmpeg WAV resampling, AAC/WebM/MP4/MP3 and available AMR conversion, corrupt/truncated input, manifest rejection and output cap");
    } else console.log("SKIP real codec roundtrips: ffmpeg unavailable; process contract and cleanup regressions still run");
    assert.deepEqual(source, original);
    console.log("PASS audio normalization: bounded private decoding, cancellation/timeouts, decoder failures, PCM validation and original media preservation");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
