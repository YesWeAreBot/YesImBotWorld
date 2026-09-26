import { isDeepStrictEqual } from "node:util";
import { ToolCallParseError } from "../llm/parse.js";
import type { ParsedToolCall } from "../types.js";
import type { ActionOpportunity } from "./opportunities.js";

export interface ChoiceSelection {
  index: number;
  opportunityId: string;
  sourceEventId: string;
  label: string;
}

/** Human menus use stable identities, never a position that can change on refresh. */
export interface HumanChoiceRef { opportunityId: string; sourceEventId: string }

export class ChoiceResolutionError extends ToolCallParseError {
  constructor(message: string, readonly code: "STALE_SELECTION" | "SELECTION_REJECTED" = "SELECTION_REJECTED") {
    super(`${message}。本次没有执行操作。`);
  }
}

/** Only resolution/admission callers may use this, before an operation has been dispatched. */
export function choiceRejection(error: unknown) {
  return { ok: false as const, admissionRejected: true as const,
    code: error instanceof ChoiceResolutionError ? error.code : "SELECTION_REJECTED" as const,
    text: error instanceof Error ? error.message : String(error) };
}

/** Resolve a human's stable reference against its offered snapshot and recheck
 * its meaning at admission. Menu order is presentation only, never the target. */
export function resolveHumanChoice(reference: unknown, offered: readonly ActionOpportunity[], suppliedText?: unknown, duration?: number,
  current: readonly ActionOpportunity[] = offered): { call: ParsedToolCall; selection: ChoiceSelection } {
  if (!record(reference) || Object.keys(reference).some(key => key !== "opportunityId" && key !== "sourceEventId") ||
    typeof reference.opportunityId !== "string" || !reference.opportunityId || typeof reference.sourceEventId !== "string" || !reference.sourceEventId)
    fail("选择需要有效的 opportunityId 与 sourceEventId");
  if (!validDuration(duration)) fail("duration 须为非负有限数字");
  if (!Array.isArray(offered) || !offered.length) fail("该建议已过期，当前没有已提供的选项，请查看最新选项或自由调用工具", "STALE_SELECTION");
  if (!Array.isArray(current)) fail("当前选项已失效，请查看最新选项或自由调用工具", "STALE_SELECTION");
  validateIdentities(offered); validateIdentities(current);
  const index = offered.findIndex(option => option.id === reference.opportunityId && option.sourceEventId === reference.sourceEventId);
  if (index < 0) fail("该建议已过期，请查看最新场景后重新选择", "STALE_SELECTION");
  const option = offered[index]!;
  const latest = current.find(item => item.id === option.id);
  if (!latest || !isDeepStrictEqual(semantics(option), semantics(latest))) fail("该选项已变化或不再可用，请查看最新选项或自由调用工具", "STALE_SELECTION");
  if (typeof option.label !== "string" || !option.label.trim() || typeof option.intent !== "string" || !option.intent.trim() ||
    typeof option.sourceEventId !== "string" || !option.sourceEventId.trim() || !["world", "device"].includes(option.source)) fail("该选项信息不完整，请查看最新选项");

  if (suppliedText !== undefined && (typeof suppliedText !== "string" || !suppliedText.trim())) fail("text 须为你自己组织的非空正文");
  const text = suppliedText as string | undefined;
  let call: ParsedToolCall;
  if (option.replyTo !== undefined) {
    if (option.source !== "device" || option.call || typeof option.replyTo !== "string" || !option.replyTo.trim()) fail("该回复选项的目标不明确，请自由使用 send");
    if (text === undefined) fail("回复选项需要 text 正文，请自行组织后提供，或自由使用 send");
    call = { name: "send", arguments: { id: option.replyTo, msg: text } };
  } else {
    const fixed = option.call;
    if (!fixed || typeof fixed.name !== "string" || !fixed.name.trim() || !record(fixed.arguments) || !validDuration(fixed.duration))
      fail("该选项没有可执行的固定操作，请自由调用当前工具");
    if (fixed.name === "choose") fail("该选项没有可执行的实际操作");
    if (option.source === "world" && fixed.name !== "act" || option.source === "device" && fixed.name === "act") fail("世界行动与设备操作的来源不符");
    if (fixed.name === "send") fail("回复选项须绑定真实会话，并由你自己提供正文，请自由使用 send");
    if (text !== undefined && !(option.source === "world" && fixed.name === "act")) fail("该设备或固定操作不接受 text，请移除 text 或自由调用相应工具");
    call = structuredClone(fixed);
    if (text !== undefined) call.arguments.speech = text;
  }
  // An explicit zero is meaningful; an omitted duration retains the offered call's default.
  if (duration !== undefined) call.duration = duration;
  return { call, selection: { index: index + 1, opportunityId: option.id, sourceEventId: option.sourceEventId, label: option.label } };
}

function fail(message: string, code?: "STALE_SELECTION" | "SELECTION_REJECTED"): never { throw new ChoiceResolutionError(message, code); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validDuration = (value: unknown): value is number | undefined => value === undefined || typeof value === "number" && Number.isFinite(value) && value >= 0;

function validateIdentities(menu: readonly ActionOpportunity[]): void {
  const seen = new Set<string>();
  for (const option of menu) {
    if (!record(option) || typeof option.id !== "string" || !option.id.trim()) fail("选项标识无效，请查看最新选项");
    if (seen.has(option.id)) fail("选项标识重复，无法确定对应操作，请查看最新选项");
    seen.add(option.id);
  }
}

/** Compare meaning, not serialization order or absent optional property spelling. */
function semantics(option: ActionOpportunity) {
  return {
    id: option.id, label: option.label, intent: option.intent, source: option.source,
    sourceEventId: option.sourceEventId, exclusiveGroup: option.exclusiveGroup, replyTo: option.replyTo,
    call: option.call === undefined ? undefined : {
      name: option.call?.name, arguments: option.call?.arguments, duration: option.call?.duration,
    },
  };
}
