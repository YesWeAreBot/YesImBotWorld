import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AudioNormalizationOptions {
  /** An executable path, never a shell command. Defaults to ffmpeg on PATH. */
  ffmpegPath?: string;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  temporaryRoot?: string;
  signal?: AbortSignal;
}
export class AudioNormalizationError extends Error {
  constructor(readonly code: string, message: string, readonly diagnostic?: string) { super(message); this.name = "AudioNormalizationError"; }
}
const MAX_BYTES = 20 * 1024 * 1024;
// Exclude playlist/manifest demuxers, including concat, HLS, DASH and image2.
// Together with the protocol restriction this prevents an uploaded manifest from
// loading a network URL or arbitrary local media files. No input URL is accepted.
const FORMATS = "aac,ac3,aiff,amr,ape,au,flac,matroska,webm,mov,mp3,ogg,wav,wv";
function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return result;
}

/** Decode the bytes actually received, independent of their advertised MIME or
 * extension. Return a new, seekable PCM16/mono/16kHz WAV; callers keep the source
 * media reference untouched. There is no model request or lossy MIME relabeling. */
export async function normalizeAudio(data: Buffer, options: AudioNormalizationOptions = {}): Promise<Buffer> {
  const maxInput = positive(options.maxInputBytes, MAX_BYTES, "maxInputBytes");
  const maxOutput = positive(options.maxOutputBytes, MAX_BYTES, "maxOutputBytes");
  const timeoutMs = positive(options.timeoutMs, 30_000, "timeoutMs");
  if (!data.length) throw new AudioNormalizationError("AUDIO_EMPTY", "音频内容为空。");
  if (data.length > maxInput) throw new AudioNormalizationError("AUDIO_INPUT_TOO_LARGE", "音频文件超过解码大小限制。");
  if (options.signal?.aborted) throw new AudioNormalizationError("AUDIO_CANCELLED", "音频解码已取消。");
  const directory = await fs.mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "yesimbot-audio-"));
  try {
    const input = path.join(directory, "input.bin"), output = path.join(directory, "output.wav");
    await fs.writeFile(input, data, { mode: 0o600 });
    await runDecoder(options.ffmpegPath ?? "ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-y", "-threads", "1", "-err_detect", "explode",
      "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS,
      "-i", input, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-threads", "1",
      // A seekable file gets final RIFF/data lengths. ffmpeg may overshoot -fs by
      // one audio packet; stat() below rejects a capped/truncated result, never
      // quietly returns its prefix as though the entire source was decoded.
      "-fs", String(maxOutput), "-f", "wav", output,
    ], timeoutMs, options.signal);
    const size = (await fs.stat(output)).size;
    if (size >= maxOutput) throw new AudioNormalizationError("AUDIO_OUTPUT_TOO_LARGE", "解码后的音频超过大小限制，未提交截断内容。");
    const wav = await fs.readFile(output);
    validatePcmWav(wav);
    return wav;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function runDecoder(binary: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new AudioNormalizationError("AUDIO_CANCELLED", "音频解码已取消。");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "", terminal: AudioNormalizationError | undefined;
    let settled = false;
    const abort = () => { terminal ??= new AudioNormalizationError("AUDIO_CANCELLED", "音频解码已取消。"); child.kill("SIGKILL"); };
    const timer = setTimeout(() => { terminal ??= new AudioNormalizationError("AUDIO_TIMEOUT", "音频解码超时。"); child.kill("SIGKILL"); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr.on("data", (chunk: Buffer) => { if (diagnostic.length < 8192) diagnostic += chunk.toString("utf8").slice(0, 8192 - diagnostic.length); });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    child.once("error", error => finish(new AudioNormalizationError("AUDIO_DECODER_UNAVAILABLE", "无法启动 ffmpeg 音频解码器。", error.message)));
    // Wait for the process to close before deleting its private working files.
    child.once("close", code => finish(terminal ?? (code === 0 ? undefined : new AudioNormalizationError("AUDIO_DECODE_FAILED", "无法解码音频内容或文件中没有音轨。", diagnostic))));
  });
}

function validatePcmWav(wav: Buffer): void {
  const invalid = () => new AudioNormalizationError("AUDIO_INVALID_OUTPUT", "音频解码器未产生有效的 PCM16 WAV 音轨。");
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE" || wav.readUInt32LE(4) + 8 !== wav.length) throw invalid();
  let format = false, samples = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString("ascii", offset, offset + 4), size = wav.readUInt32LE(offset + 4), body = offset + 8;
    if (size > wav.length - body) throw invalid();
    if (name === "fmt ") {
      if (size < 16 || wav.readUInt16LE(body) !== 1 || wav.readUInt16LE(body + 2) !== 1 || wav.readUInt32LE(body + 4) !== 16_000 || wav.readUInt16LE(body + 14) !== 16) throw invalid();
      format = true;
    }
    if (name === "data") { if (!size || size % 2) throw invalid(); samples = true; }
    offset = body + size + (size % 2);
  }
  if (!format || !samples) throw invalid();
}
