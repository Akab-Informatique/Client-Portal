import { and, eq, like, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { archiveProjects, importArchiveProject } from "./projBilling.ts";
import { syncBillablesNow } from "./billables.ts";

/**
 * TEMPORARY (Admin › Facturation): checks that the work to bill of the archive projects (time on milestones sent to approval,
 * the price sold) came over to the new format and is in Accounting › Approbation, and puts right what did not.
 * Nothing is deleted: lines are renamed (`prtime:` → `projtime:`), their kind changed (milestone → project) and missing lines made by the usual copy.
 */

type LineRow = { id: string; sourceId: string | null; kind: string; status: string; amountCents: number; description: string; ticketNumber: string | null; date: string };

const entryOf = (sourceId: string | null) => (sourceId && /^prtime:/.test(sourceId) ? sourceId.slice("prtime:".length) : null);

export async function checkProjectsMigration() {
  const d = db();
  const archive = await archiveProjects();
  const notImported = archive.filter((p) => !p.imported).map((p) => ({ number: p.number, name: p.name }));

  const lines: LineRow[] = await d
    .select({ id: schema.billingItems.id, sourceId: schema.billingItems.sourceId, kind: schema.billingItems.kind, status: schema.billingItems.status, amountCents: schema.billingItems.amountCents, description: schema.billingItems.description, ticketNumber: schema.billingItems.ticketNumber, date: schema.billingItems.date })
    .from(schema.billingItems)
    .where(or(eq(schema.billingItems.kind, "milestone"), like(schema.billingItems.sourceId, "prtime:%"), like(schema.billingItems.sourceId, "projtime:%")));
  // the entries behind the old-style lines: has the project been brought over (proj_id set)?
  const entries = new Map((await d.select({ id: schema.timesheetEntries.id, projId: schema.timesheetEntries.projId }).from(schema.timesheetEntries).where(sql`${schema.timesheetEntries.projectId} is not null or ${schema.timesheetEntries.projId} is not null`)).map((e) => [e.id, e.projId]));
  const toRename = lines.filter((l) => entryOf(l.sourceId) && entries.get(entryOf(l.sourceId)!) != null);
  const wrongKind = lines.filter((l) => l.kind === "milestone" && /^(prtime|projtime):/.test(l.sourceId ?? ""));
  const stillArchive = lines.filter((l) => entryOf(l.sourceId) && entries.get(entryOf(l.sourceId)!) == null && entries.has(entryOf(l.sourceId)!));
  const inNew = lines.filter((l) => l.sourceId?.startsWith("projtime:"));

  // billable time on a brought-over project with no line yet (the next copy makes them)
  const billable = await d
    .select({ id: schema.timesheetEntries.id })
    .from(schema.timesheetEntries)
    .where(sql`${schema.timesheetEntries.projId} is not null and ${schema.timesheetEntries.billableX100} > 0 and ${schema.timesheetEntries.ticketTimeId} is null`);
  const have = new Set(lines.map((l) => l.sourceId));
  const missing = billable.filter((e) => !have.has(`projtime:${e.id}`) && !have.has(`prtime:${e.id}`));

  // the price sold still keyed on an archive id of a project that was brought over
  const imported = new Map(archive.filter((p) => p.imported && p.newId).map((p) => [p.id, p.newId!]));
  const sale = await d.select({ id: schema.billingItems.id, sourceId: schema.billingItems.sourceId, status: schema.billingItems.status }).from(schema.billingItems).where(like(schema.billingItems.sourceId, "project:%"));
  const saleToMove = sale.filter((s) => [...imported.keys()].some((oldId) => s.sourceId?.startsWith(`project:${oldId}`)));

  const sum = (rows: LineRow[], status: string) => ({ count: rows.filter((r) => r.status === status).length, cents: rows.filter((r) => r.status === status).reduce((n, r) => n + r.amountCents, 0) });
  const sample = (rows: LineRow[]) => rows.slice(0, 40).map((r) => ({ number: r.ticketNumber, description: r.description.slice(0, 90), status: r.status, kind: r.kind, amountCents: r.amountCents, date: r.date }));
  return {
    archiveProjects: archive.length,
    notImported,
    toRename: toRename.length,
    wrongKind: wrongKind.length,
    stillArchive: stillArchive.length,
    inNewFormat: { pending: sum(inNew, "pending"), approved: sum(inNew, "approved"), posted: sum(inNew, "posted"), excluded: sum(inNew, "excluded") },
    missingLines: missing.length,
    saleToMove: saleToMove.length,
    sample: sample([...new Map([...toRename, ...wrongKind].map((l) => [l.id, l])).values()]),
    ok: notImported.length === 0 && toRename.length === 0 && wrongKind.length === 0 && saleToMove.length === 0 && missing.length === 0,
  };
}

export async function repairProjectsMigration() {
  const d = db();
  const errors: string[] = [];
  let imported = 0;
  // 1. archive projects that are still to be brought over
  for (const p of (await archiveProjects()).filter((x) => !x.imported)) {
    try {
      await importArchiveProject(p.id, "00000000-0000-0000-0000-000000000000");
      imported++;
    } catch (e) {
      errors.push(`${p.number}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // 2. lines still keyed on the old way for an entry that now belongs to a new-format project
  const old = await d.select({ id: schema.billingItems.id, sourceId: schema.billingItems.sourceId }).from(schema.billingItems).where(like(schema.billingItems.sourceId, "prtime:%"));
  let renamed = 0;
  let clashes = 0;
  for (const l of old) {
    const eid = entryOf(l.sourceId)!;
    const [e] = await d.select({ projId: schema.timesheetEntries.projId }).from(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, eid));
    if (!e?.projId) continue;
    const [dup] = await d.select({ id: schema.billingItems.id }).from(schema.billingItems).where(eq(schema.billingItems.sourceId, `projtime:${eid}`));
    if (dup) {
      clashes++;
      continue;
    }
    await d.update(schema.billingItems).set({ sourceId: `projtime:${eid}`, kind: "project" }).where(eq(schema.billingItems.id, l.id));
    renamed++;
  }
  // 3. lines of the removed "Jalons" tab: they are project time now
  const kinds = await d.update(schema.billingItems).set({ kind: "project" }).where(and(eq(schema.billingItems.kind, "milestone"), or(like(schema.billingItems.sourceId, "prtime:%"), like(schema.billingItems.sourceId, "projtime:%")))).returning({ id: schema.billingItems.id });
  // 4. the price sold follows the project
  let moved = 0;
  for (const p of (await archiveProjects()).filter((x) => x.imported && x.newId)) {
    const sale = await d.select({ id: schema.billingItems.id, sourceId: schema.billingItems.sourceId }).from(schema.billingItems).where(like(schema.billingItems.sourceId, `project:${p.id}%`));
    for (const s of sale) {
      await d.update(schema.billingItems).set({ sourceId: s.sourceId!.replace(p.id, p.newId!) }).where(eq(schema.billingItems.id, s.id));
      moved++;
    }
  }
  // 5. the usual copy makes the lines that were missing
  await syncBillablesNow();
  return { imported, renamed, clashes, kindChanged: kinds.length, saleMoved: moved, errors, after: await checkProjectsMigration() };
}
