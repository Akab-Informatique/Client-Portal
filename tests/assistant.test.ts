import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_PERMISSIONS, SYSTEM_ROLES, permissionsFor } from "../shared/permissions.ts";
import { RESTRICTIONS, SECTION_ACCESS, restrictionsOf } from "../server/knowledge/access.ts";
import { canSee, knowledgeChunks, normalize, selectExcerpts, termsOf, MAX_CONTEXT_CHARS, MAX_EXCERPTS, type KnowledgeChunk } from "../server/lib/assistantKnowledge.ts";
import { runTool, toolsFor, ToolError } from "../server/lib/assistantTools.ts";

const root = join(import.meta.dirname, "..");
const TECHNICIAN = SYSTEM_ROLES.find((r) => r.slug === "technician")!.permissions as string[];
const STAFF_ALL = permissionsFor("staff") as string[];
const NO_RIGHTS: string[] = [];

/** The headings of CLAUDE.md (after "## "). */
function claudeHeadings(): string[] {
  return readFileSync(join(root, "CLAUDE.md"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim());
}

describe("portal assistant: the documentation's access rules", () => {
  it("every mapped section exists in CLAUDE.md and names real rights", () => {
    const headings = new Set(claudeHeadings());
    for (const [heading, rights] of Object.entries(SECTION_ACCESS)) {
      expect(headings.has(heading), `unknown heading: ${heading}`).toBe(true);
      expect(rights.length, `no right for ${heading}`).toBeGreaterThan(0);
      for (const r of rights) expect(ALL_PERMISSIONS as readonly string[], `unknown right ${r} in ${heading}`).toContain(r);
    }
    for (const r of RESTRICTIONS) for (const k of r.requires) expect(ALL_PERMISSIONS as readonly string[]).toContain(k);
  });

  it("the generated file has an id and a title on every chunk, and only mapped sections", () => {
    const raw = JSON.parse(readFileSync(join(root, "server", "knowledge", "portal.json"), "utf8")) as { chunks: KnowledgeChunk[] };
    expect(raw.chunks.length).toBeGreaterThan(50);
    const ids = new Set<string>();
    for (const c of raw.chunks) {
      expect(c.id).toBeTruthy();
      expect(c.title).toBeTruthy();
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(Object.keys(SECTION_ACCESS)).toContain(c.heading);
      expect(c.requires.length).toBeGreaterThan(0);
    }
  });

  it("the generated file agrees with the access rules (it was rebuilt after the last change)", () => {
    const raw = JSON.parse(readFileSync(join(root, "server", "knowledge", "portal.json"), "utf8")) as { chunks: KnowledgeChunk[] };
    for (const c of raw.chunks) {
      expect(c.requires, `requires of ${c.id}`).toEqual(SECTION_ACCESS[c.heading]);
      expect(c.restrictTo, `restrictions of ${c.id}`).toEqual(restrictionsOf(c.text));
    }
  });

  it("developer-only sections are not in the file at all", () => {
    const raw = readFileSync(join(root, "server", "knowledge", "portal.json"), "utf8");
    const headings = JSON.parse(raw).chunks.map((c: KnowledgeChunk) => c.heading);
    for (const h of ["Branches", "Commands", "Adding a module", "Production"]) expect(headings).not.toContain(h);
  });

  it("no literal credential reaches the file", () => {
    const raw = readFileSync(join(root, "server", "knowledge", "portal.json"), "utf8");
    // credential-shaped values only (CLAUDE.md names the prefixes in prose, which is fine)
    expect(raw).not.toMatch(/sk-ant-[\w-]{10,}|whsec_[A-Za-z0-9]{10,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|akab_[A-Za-z0-9_-]{16,}/);
  });

  it("a chunk with no rights is never shown, whatever the rights", () => {
    const orphan: KnowledgeChunk = { id: "x", title: "Orphan", heading: "Orphan", text: "banque d'heures", requires: [], restrictTo: [] };
    expect(canSee(orphan, STAFF_ALL)).toBe(false);
    expect(selectExcerpts([orphan], STAFF_ALL, ["banque d'heures"]).chunks).toEqual([]);
  });

  it("an HR chunk is never returned to someone without hr.manage, and is to an administrator", () => {
    const chunks = knowledgeChunks();
    const hr = chunks.filter((c) => c.restrictTo.some((g) => g.includes("hr.manage")));
    expect(hr.length).toBeGreaterThan(0);
    const question = "salaire taux horaire paie banque de vacances dossier RH";
    const forTech = selectExcerpts(chunks, TECHNICIAN, [question]);
    expect(forTech.chunks.every((c) => !c.restrictTo.some((g) => g.includes("hr.manage")))).toBe(true);
    expect(forTech.chunks.every((c) => !hr.some((h) => h.id === c.id))).toBe(true);
    const forAdmin = selectExcerpts(chunks, STAFF_ALL, [question]);
    expect(forAdmin.chunks.some((c) => hr.some((h) => h.id === c.id))).toBe(true);
  });

  it("a section for administrators only is hidden from a technician", () => {
    const chunks = knowledgeChunks();
    const secret = chunks.find((c) => c.requires.length === 1 && c.requires[0] === "admin.integrations");
    expect(secret).toBeTruthy();
    expect(canSee(secret!, TECHNICIAN)).toBe(false);
    expect(canSee(secret!, ["admin.integrations"])).toBe(true);
  });

  it("the excerpts are capped in number and in size", () => {
    const chunks = knowledgeChunks();
    const r = selectExcerpts(chunks, STAFF_ALL, ["tickets billets pipeline tâches projets factures contrats clients banque heures"]);
    expect(r.chunks.length).toBeLessThanOrEqual(MAX_EXCERPTS);
    expect(r.context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + 200);
  });

  it("words are matched without accents or case, and stop words are ignored", () => {
    expect(normalize("Crédit Été")).toBe("credit ete");
    const terms = termsOf("Qu'est-ce que la banque d'heures ?");
    expect(terms).toContain("banque");
    expect(terms).toContain("heures");
    expect(terms).not.toContain("que");
    expect(terms).not.toContain("est");
  });

  it("the best match comes first: a title hit beats a passing mention", () => {
    const a: KnowledgeChunk = { id: "a", title: "Banque d'heures des clients", heading: "A", text: "Texte sur la banque.", requires: ["crm.view"], restrictTo: [] };
    const b: KnowledgeChunk = { id: "b", title: "Autre sujet", heading: "B", text: "banque heures banque heures", requires: ["crm.view"], restrictTo: [] };
    const r = selectExcerpts([b, a], ["crm.view"], ["banque d'heures"]);
    expect(r.chunks[0].id).toBe("a");
  });
});

describe("portal assistant: the live-data tools", () => {
  it("the tool list holds only the tools the person may use", () => {
    const noProjects = TECHNICIAN.filter((p) => p !== "projects.view");
    const names = toolsFor(noProjects).map((t) => t.name);
    expect(names).toContain("my_tasks");
    expect(names).toContain("my_tickets");
    expect(names).not.toContain("my_projects");
    expect(toolsFor(NO_RIGHTS)).toEqual([]);
  });

  it("a tool refuses a person without its right, even when called directly", async () => {
    const auth = { user: { id: "00000000-0000-0000-0000-000000000000", name: "X" }, permissions: NO_RIGHTS } as never;
    await expect(runTool("my_projects", { auth })).rejects.toBeInstanceOf(ToolError);
    await expect(runTool("my_projects", { auth })).rejects.toThrow("forbidden");
  });

  it("an unknown tool is refused", async () => {
    const auth = { user: { id: "x" }, permissions: STAFF_ALL } as never;
    await expect(runTool("drop_everything", { auth })).rejects.toThrow("unknown_tool");
  });

  it("the assistant itself is a right of its own, given to technicians and administrators", () => {
    expect(TECHNICIAN).toContain("assistant.use");
    expect(STAFF_ALL).toContain("assistant.use");
    expect(SYSTEM_ROLES.find((r) => r.slug === "viewer")!.permissions).not.toContain("assistant.use");
  });
});
