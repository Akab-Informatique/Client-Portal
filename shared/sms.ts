/**
 * Text message length, as VoIP.ms (and phones) count it: 160 characters per
 * text in the basic SMS alphabet (GSM-7), but only 70 as soon as one character
 * is outside it (ê, â, ô, î, û, ’, emoji…), which French often has.
 * Used by the server to cut messages and by the browser for the counter.
 */

/** GSM-7 basic set: one unit each */
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
/** GSM-7 extension: two units each */
const GSM_EXT = new Set("^{}\\[~]|€\f");

export const SMS_GSM_MAX = 160;
export const SMS_UNICODE_MAX = 70;

const isGsm = (text: string) => [...text].every((ch) => GSM_BASIC.has(ch) || GSM_EXT.has(ch));

/** Units a part may hold, and what one character costs */
function measure(text: string) {
  if (isGsm(text)) return { max: SMS_GSM_MAX, cost: (ch: string) => (GSM_EXT.has(ch) ? 2 : 1) };
  // UCS-2: characters beyond the basic plane (emoji) take two
  return { max: SMS_UNICODE_MAX, cost: (ch: string) => ch.length };
}

/** Split a text into parts that each fit in one text (cut at a space when possible). */
export function splitSms(text: string): string[] {
  const rest = text.trim();
  if (!rest) return [];
  const { max, cost } = measure(rest);
  const chars = [...rest];
  const parts: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let units = 0;
    let end = start;
    while (end < chars.length && units + cost(chars[end]) <= max) units += cost(chars[end++]);
    if (end < chars.length) {
      // back to the last space, unless that leaves the part too short
      const space = chars.lastIndexOf(" ", end);
      if (space > start && space - start >= (end - start) * 0.6) end = space;
    }
    const part = chars.slice(start, end).join("").trim();
    if (part) parts.push(part);
    start = end;
    while (chars[start] === " ") start++;
  }
  return parts;
}

/** How many texts a message will take (at least one) */
export const smsPartCount = (text: string) => Math.max(1, splitSms(text).length);
