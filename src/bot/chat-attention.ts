import type { ExperienceMetadata } from "../types.js";

type Chat = ExperienceMetadata["chat"];

/** A transport fact, not an interpretation of prose or a requirement to answer. */
export function explicitlyAddressesSelf(chat: Chat): boolean {
  if (!chat || chat.senderOwn !== false) return false;
  const direction = chat.direction;
  if (!direction) return false;
  if (direction.kind === "direct") return true;
  return !!direction.accountId && (direction.mentionedIds.includes(direction.accountId) ||
    direction.quotedSenderId === direction.accountId);
}

/** Unknown authors stay unknown; @all alone does not pick out the character. */
export function explicitlyAddressesOthers(chat: Chat): boolean {
  const direction = chat?.direction;
  if (!direction || direction.kind === "direct" || !direction.accountId || explicitlyAddressesSelf(chat)) return false;
  return !!direction.quotedSenderId && direction.quotedSenderId !== direction.accountId ||
    direction.mentionedIds.some(id => id !== direction.accountId);
}

/** This retires an automatic topic cue only. Actual sending remains the character's choice. */
export function allowsVoluntaryConversationCue(chat: Chat): boolean {
  return chat?.senderOwn !== true && !explicitlyAddressesOthers(chat);
}
