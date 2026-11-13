import { readFileSync } from "node:fs";

/**
 * The portal assistant's documentation: the chunks of server/knowledge/portal.json (built from CLAUDE.md by
 * `npm run knowledge`, rules in server/knowledge/access.ts). Retrieval is pure: it only sees the chunks the
 * signed-in user may read, so nothing outside their rights can reach the model.
 */
export type KnowledgeChunk = {
  id: string;
  title: string;
  heading: string;
  text: string;
  /** The user must hold ANY of these rights (empty: never shown) */
  requires: string[];
  /** Each group must be held (ANY inside a group): the narrowing rules of server/knowledge/access.ts */
  restrictTo: string[][];
};

/** Most excerpts sent with one question, and the most characters they may add up to. */
export const MAX_EXCERPTS = 5;
export const MAX_CONTEXT_CHARS = 20_000;

let cached: KnowledgeChunk[] | null = null;
/** The chunks of the generated file (read once). */
export function knowledgeChunks(): KnowledgeChunk[] {
  if (!cached) {
    const raw = JSON.parse(readFileSync(new URL("../knowledge/portal.json", import.meta.url), "utf8")) as { chunks?: KnowledgeChunk[] };
    cached = Array.isArray(raw.chunks) ? raw.chunks : [];
  }
  return cached;
}

/** May a user with these rights read this chunk? Default deny: no rights listed, nothing shown. */
export function canSee(chunk: KnowledgeChunk, perms: readonly string[]): boolean {
  if (!chunk.requires.length) return false;
  if (!chunk.requires.some((r) => perms.includes(r))) return false;
  return chunk.restrictTo.every((group) => group.length > 0 && group.some((r) => perms.includes(r)));
}

const STOP = new Set(
  "le la les un une des du de et ou au aux en a à est sont que qui quoi quel quelle quels quelles comment pour par avec dans sur sous mon ma mes son sa ses ce cet cette ces il elle ils elles on nous vous je tu pas plus ai as avoir être etre faire fait fais quand pourquoi où ou the and or of to in on at by for with from into how what when why where which does is are be this that you can my your our its do did i it an as not".split(
    " ",
  ),
);

/** Lower case, no accents: "Qu'est-ce qu'un crédit ?" → "qu est ce qu un credit". */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The words of a question worth looking for (3+ letters, no stop words), each once. */
export function termsOf(text: string): string[] {
  return [...new Set(normalize(text).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)))];
}

/** A chunk's score: each word in its title counts 4, each word in its text up to 5 times. */
export function scoreChunk(chunk: KnowledgeChunk, terms: readonly string[]): number {
  const title = normalize(chunk.title);
  const body = normalize(chunk.text);
  let score = 0;
  for (const t of terms) {
    if (title.includes(t)) score += 4;
    let n = 0;
    let i = body.indexOf(t);
    while (i >= 0 && n < 5) {
      n++;
      i = body.indexOf(t, i + t.length);
    }
    score += n;
  }
  return score;
}

export type Excerpts = { chunks: KnowledgeChunk[]; context: string };

/**
 * The excerpts for a question: only what `perms` may read, the best-scoring ones first, at most MAX_EXCERPTS and
 * MAX_CONTEXT_CHARS in all. `queries` are the latest turns of the conversation (the question first).
 */
export function selectExcerpts(chunks: readonly KnowledgeChunk[], perms: readonly string[], queries: readonly string[]): Excerpts {
  const terms = termsOf(queries.join(" "));
  if (!terms.length) return { chunks: [], context: "" };
  const ranked = chunks
    .filter((c) => canSee(c, perms))
    .map((c) => ({ c, s: scoreChunk(c, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id))
    .slice(0, MAX_EXCERPTS);
  const picked: KnowledgeChunk[] = [];
  let used = 0;
  for (const { c } of ranked) {
    const room = MAX_CONTEXT_CHARS - used - c.title.length - 16;
    if (room < 400) break;
    const text = c.text.length > room ? c.text.slice(0, room) : c.text;
    picked.push({ ...c, text });
    used += c.title.length + text.length + 16;
  }
  return { chunks: picked, context: picked.map((c) => `### ${c.title}\n${c.text}`).join("\n\n") };
}
