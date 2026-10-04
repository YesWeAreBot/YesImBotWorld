/** A failed request's media presence is not evidence that its modality is unsupported. */
export type MediaRequestFailure =
  | { kind: "audio-format" }
  | { kind: "unsupported-modality"; modalities: ("image" | "audio" | "video")[] }
  | { kind: "payload-too-large" };

/** Only provider rejections and the media types actually sent can authorize a fallback.
 * Format/codec errors retain audio capability; schema, tool and context-limit errors
 * cannot disable unrelated media just because their request happened to contain it.
 */
export function classifyMediaRequestFailure(error: unknown, partTypes: ReadonlySet<string>): MediaRequestFailure | undefined {
  if (!partTypes.size) return;
  const value = error as { message?: unknown; status?: unknown; code?: unknown } | null;
  const message = typeof value?.message === "string" ? value.message : String(error);
  if (value?.status === 413 || /\(413\)/.test(message)) return { kind: "payload-too-large" };
  if (!(value?.status === 400 || /\(400\)/.test(message) || value?.code === "LLM_REMOTE_ERROR" || message.startsWith("LLM_REMOTE_ERROR:"))) return;
  const normalized = message.toLowerCase();
  const rejected = /unsupported|not support|cannot support|can't support|doesn't support|not allowed|invalid|unknown|unrecognized|not implemented|must be|expected|should be|only support|不支持|格式|编码/.test(normalized);
  if (!rejected) return;

  if (partTypes.has("input_audio") && !/(?:audio[ _-]*(?:output|generation)|(?:output|generate|generating)[ _-]*audio)/.test(normalized)) {
    const target = "(?:audio|input_audio)[\\s_.-]*(?:file[\\s_.-]*)?(?:format|codec|encoding)\\b";
    const format = new RegExp(`(?:invalid|unsupported|unknown|unrecognized)[^\\n.;]{0,32}${target}|${target}[^\\n.;]{0,64}(?:not supported|unsupported|not allowed|invalid|must be|expected|should be|only support)`).test(normalized)
      || /音频.{0,8}(?:格式|编码).{0,12}(?:不支持|无效|不正确)|(?:不支持|无效).{0,12}音频.{0,8}(?:格式|编码)/.test(normalized);
    // Pydantic commonly names format as a separate item of input_audio's location path.
    const formatField = /input_audio["'\],\s.]+(?:["']?format\b)/.test(normalized);
    if (format || formatField && /must be|should be|literal_error|expected|unsupported|invalid/.test(normalized)) return { kind: "audio-format" };
  }

  const modalities: ("image" | "audio" | "video")[] = [];
  for (const [modality, part] of [["image", "image_url"], ["audio", "input_audio"], ["video", "video_url"]] as const) {
    if (!partTypes.has(part)) continue;
    if (new RegExp(`\\b${modality}(?:[ _-]+file)?[ _-]+(?:format|codec|encoding|resolution|dimensions|size)\\b`).test(normalized)) continue;
    // Output/synthesis restrictions do not say anything about accepting media input.
    if (new RegExp(`(?:${modality}[ _-]*(?:output|generation)|(?:output|generate|generating)[ _-]*${modality})`).test(normalized) && !normalized.includes(part)) continue;
    const namedPart = new RegExp(`(?:unsupported|unknown|unrecognized|invalid) (?:content[ _-]*part[ _-]*type[ :]*|(?:content|input) type[ :]*|type[ :]*|value[ :]*|["']){0,3}["']?${part}\\b|\\b${part}["']? (?:is |are )?(?:not supported|unsupported|not allowed|not implemented)`);
    const namedModality = new RegExp(`(?:does not|doesn't|cannot|can't|do not) support (?:the )?(?:input )?${modality}s?\\b|(?:unsupported|not supported) ${modality}s?(?:[ _-]+(?:input|inputs|modality|messages?|content))?\\b|\\b${modality}s?(?:[ _-]+(?:input|inputs|modality|messages?|content))? (?:is |are )?(?:not supported|unsupported|not allowed)`);
    const chinese = new RegExp(`不支持(?:原生)?(?:${modality === "audio" ? "音频|语音" : modality === "video" ? "视频" : "图片|图像"})(?:输入)?`);
    if (namedPart.test(normalized) || namedModality.test(normalized) || chinese.test(normalized)) modalities.push(modality);
  }
  return modalities.length ? { kind: "unsupported-modality", modalities } : undefined;
}
