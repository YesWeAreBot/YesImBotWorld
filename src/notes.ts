import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface NoteTime {
  label: string;
  /** World TU and real Unix milliseconds are separate domains and must never be compared directly. */
  value: number | null;
  clock: "world" | "real";
  source: "recorded" | "file";
}

export interface NoteDocument {
  content: string;
  created: NoteTime | null;
  updated: NoteTime | null;
}

type FileTimes = { birthtimeMs: number; mtimeMs: number };
type NoteClock = { now(): number; clockString(at: number): string };

export function sanitizeNoteTitle(raw: string): string {
  const safe = raw.trim().replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ");
  return Array.from(safe).slice(0, 60).join("").replace(/^[\s.]+/, "").trim();
}

export function noteStamp(clock?: NoteClock | null): NoteTime {
  if (clock) {
    const t = clock.now();
    return { label: `${clock.clockString(t)}（T=${t.toFixed(1)}）`, value: Number(t.toFixed(1)), clock: "world", source: "recorded" };
  }
  const time = Date.now();
  return { label: new Date(time).toISOString(), value: time, clock: "real", source: "recorded" };
}

function timestamp(label: string | undefined, source: string | undefined, fallback?: number): NoteTime | null {
  if (label) {
    const tu = label.match(/\bT\s*=\s*(-?\d+(?:\.\d+)?)/);
    if (tu) return { label, value: Number(tu[1]), clock: "world", source: "recorded" };
    // Only an explicit UTC/offset timestamp establishes a real clock. A legacy calendar label is world time.
    const real = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(label) ? Date.parse(label) : NaN;
    if (Number.isFinite(real)) return { label, value: real, clock: "real", source: source === "file" ? "file" : "recorded" };
    return { label, value: null, clock: "world", source: "recorded" };
  }
  return fallback != null && Number.isFinite(fallback) && fallback > 0
    ? { label: new Date(fallback).toISOString(), value: new Date(fallback).getTime(), clock: "real", source: "file" } : null;
}

/** Read old world frontmatter and ordinary imported Markdown without inventing creation times. */
export function parseNote(raw: string, fileTimes?: FileTimes): NoteDocument {
  const fields: Record<string, string> = {};
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (frontmatter) for (const line of frontmatter[1]!.split(/\r?\n/)) {
    const pair = line.match(/^(created|updated|created_source|updated_source):\s*(.+)$/);
    if (pair) fields[pair[1]!] = pair[2]!.trim();
  }
  return {
    content: (frontmatter ? raw.slice(frontmatter[0].length) : raw).trim(),
    created: timestamp(fields.created, fields.created_source, fileTimes?.birthtimeMs),
    updated: timestamp(fields.updated, fields.updated_source, fileTimes?.mtimeMs),
  };
}

export async function readNoteFile(file: string): Promise<NoteDocument> {
  const [raw, stats] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
  return parseNote(raw, stats);
}

/** Atomic replacement keeps a persisted creation time, including clearly marked imported file metadata. */
export async function saveNoteFile(file: string, content: string, created: NoteTime | null, updated: NoteTime): Promise<void> {
  const stamp = (key: string, time: NoteTime | null) => time
    ? `${key}: ${time.label.replace(/[\r\n]/g, " ")}\n${time.source === "file" ? `${key}_source: file\n` : ""}` : "";
  const raw = `---\n${stamp("created", created)}${stamp("updated", updated)}---\n\n${content.trim()}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, raw); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

/** Known world chronology first, then real/file chronology; missing TU stays explicitly unordered. */
export function compareNotes(a: { title: string; created?: NoteTime | null; updated?: NoteTime | null }, b: { title: string; created?: NoteTime | null; updated?: NoteTime | null }, order: "created" | "updated" = "updated"): number {
  const left = a[order], right = b[order];
  const rank = (time: NoteTime | null | undefined) => !time ? 3 : time.clock === "world" ? (time.value == null ? 1 : 0) : 2;
  return rank(left) - rank(right) || (left?.value != null && right?.value != null ? right.value - left.value : 0) || a.title.localeCompare(b.title);
}

export function noteTimeText(time: NoteTime | null | undefined): string {
  if (!time) return "未记录";
  return `${time.label}${time.clock === "real" ? time.source === "file" ? "（文件时间）" : "（现实时间）" : time.value == null ? "（旧世界时间，未记录 TU）" : ""}`;
}
