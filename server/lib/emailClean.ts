/**
 * An email's plain text without what the mail systems add around it, for a ticket description or note: the phishing-filter
 * banner (Inky: "Mise en garde : Externe … Protection par le service de Cyber Sécurité d'AKAB"), `<mailto:…>` / `<https://…>` /
 * `<tel:…>` written after a name or a link, very long tracking links, "[Logo image]" placeholders and confidentiality notices.
 * Nothing the person wrote is touched.
 */
const IMAGE_LINE = /^\s*\[(?:logo |footer |signature )?image(?: [^\]]*)?\]\s*$|^\s*\[cid:[^\]]*\]\s*$/i;
const NOTICE_LINE = /^\s*(?:confidentiality notice|avis de confidentialit[ée]|this e-?mail and any attachments|ce courriel et ses pi[èe]ces jointes|ce message peut contenir)\b/i;

export function cleanEmailText(input: string): string {
  let lines = input.replace(/\r\n/g, "\n").split("\n");
  // the filter banner: from "Mise en garde / Caution : Externe" to its last line (the AKAB protection line)
  const start = lines.findIndex((l) => /^\s*(?:mise en garde|caution)\s*:/i.test(l));
  if (start >= 0) {
    let end = -1;
    for (let i = start; i < Math.min(lines.length, start + 25); i++) {
      if (/cyber s[ée]curit[ée] d['’]akab|akab informatique\.?\s*<?akab\.ca>?\s*$/i.test(lines[i])) {
        end = i;
        break;
      }
    }
    if (end >= 0) {
      // the line just before the banner is the mail system's preview of the body: it is repeated below
      const before = start > 0 && lines[start - 1].trim().length > 40 ? start - 1 : start;
      lines = [...lines.slice(0, before), ...lines.slice(end + 1)];
    }
  }
  const text = lines
    .filter((l) => !IMAGE_LINE.test(l))
    .join("\n")
    // an address or a name followed by its link in angle brackets: "name@x.ca<mailto:name@x.ca>", "T: 228<tel:228>"
    .replace(/<(?:mailto|tel|https?|ftp):[^>\s]*>/gi, "")
    // a very long link (tracking, filter report) is shortened to its site
    .replace(/https?:\/\/[^\s<>)\]]{90,}/gi, (u) => {
      try {
        return `[lien : ${new URL(u).hostname}]`;
      } catch {
        return "[lien]";
      }
    });
  // the confidentiality notice at the end (and what follows it)
  const out = text.split("\n");
  const n = out.findIndex((l, i) => NOTICE_LINE.test(l) && i > out.length * 0.4);
  const kept = n >= 0 ? out.slice(0, n) : out;
  return kept
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
