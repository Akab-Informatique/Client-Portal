// Builds server/knowledge/portal.json from CLAUDE.md, the portal assistant's documentation.
// Run with `npm run knowledge` (it loads the reviewed access map, server/knowledge/access.ts, through tsx).
//
// Each "## " section is one chunk; a section longer than MAX_CHARS is cut on its top-level "- " bullets.
// Sections with no entry in SECTION_ACCESS are DROPPED here: they never reach the file (default deny).
// Anything that looks like a credential is replaced before the text is written.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_CHARS = 6000;

const { SECTION_ACCESS, restrictionsOf } = await import(pathToFileURL(join(root, "server", "knowledge", "access.ts")).href);

const SECRET = /(sk-ant-[\w-]+|whsec_\w+|(?:sk|rk|pk)_(?:live|test)_\w+|akab_[\w-]{16,}|eyJ[\w-]{20,}|\b[a-f0-9]{40,}\b)/g;

const slug = (s) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/** Splits a long section into parts of at most MAX_CHARS, on its top-level bullets. */
function partsOf(body) {
  if (body.length <= MAX_CHARS) return [body];
  const lines = body.split("\n");
  const firstBullet = lines.findIndex((l) => l.startsWith("- "));
  const intro = firstBullet < 0 ? body : lines.slice(0, firstBullet).join("\n").trim();
  const bullets = [];
  if (firstBullet >= 0) {
    for (const l of lines.slice(firstBullet)) {
      if (l.startsWith("- ")) bullets.push(l);
      else bullets[bullets.length - 1] += `\n${l}`;
    }
  }
  const parts = [];
  let cur = intro;
  for (const b of bullets) {
    if (cur && cur.length + b.length + 2 > MAX_CHARS) {
      parts.push(cur.trim());
      cur = "";
    }
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** A short label for a part: the bold name its first bullet starts with, else its first words. */
function labelOf(part) {
  const first = part.split("\n")[0];
  const bold = first.match(/^- \*\*([^*]+)\*\*/);
  if (bold && /[A-Za-zÀ-ÿ]{3}/.test(bold[1]) && bold[1].length <= 80) return bold[1].replace(/[\s:.]+$/, "").trim();
  return first.replace(/^- /, "").replace(/\*\*/g, "").split(/\s+/).slice(0, 6).join(" ").replace(/[\s:.]+$/, "");
}

const md = readFileSync(join(root, "CLAUDE.md"), "utf8").replace(/\r\n/g, "\n");
const sections = [];
let current = null;
for (const line of md.split("\n")) {
  if (line.startsWith("## ")) {
    current = { heading: line.slice(3).trim(), body: [] };
    sections.push(current);
  } else if (current) current.body.push(line);
}

const chunks = [];
const dropped = [];
for (const s of sections) {
  const requires = SECTION_ACCESS[s.heading] ?? [];
  if (!requires.length) {
    dropped.push(s.heading);
    continue;
  }
  const body = s.body.join("\n").trim();
  const parts = partsOf(body);
  parts.forEach((raw, i) => {
    const text = raw.replace(SECRET, "[retiré]");
    const label = parts.length > 1 ? labelOf(text) : "";
    const title = parts.length > 1 ? `${s.heading} — ${label} (${i + 1}/${parts.length})` : s.heading;
    chunks.push({
      id: `${slug(s.heading)}-${i + 1}`,
      title,
      heading: s.heading,
      text,
      requires,
      restrictTo: restrictionsOf(text),
    });
  });
}

const out = join(root, "server", "knowledge", "portal.json");
writeFileSync(out, JSON.stringify({ source: "CLAUDE.md", chunks }, null, 1) + "\n");
console.log(`[knowledge] ${chunks.length} chunks written to server/knowledge/portal.json`);
console.log(`[knowledge] left out (no access rule, never shown): ${dropped.length} section(s)`);
for (const h of dropped) console.log(`  - ${h}`);
