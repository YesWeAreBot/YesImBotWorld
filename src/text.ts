/** Replace only isolated UTF-16 surrogate code units; valid Unicode is unchanged. */
export function toWellFormedText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/**
 * String.slice with UTF-16 indices, excluding a whole character when either
 * boundary falls inside its surrogate pair. Does not split an emoji in half.
 */
export function sliceText(text: string, start = 0, end = text.length): string {
  const index = (value: number): number => {
    const integer = Number.isNaN(value) ? 0 : Math.trunc(value);
    return integer < 0 ? Math.max(text.length + integer, 0) : Math.min(integer, text.length);
  };
  const insidePair = (at: number): boolean => {
    const before = text.charCodeAt(at - 1), after = text.charCodeAt(at);
    return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
  };
  const from = index(start), to = index(end);
  return text.slice(insidePair(from) ? from + 1 : from, insidePair(to) ? to - 1 : to);
}
