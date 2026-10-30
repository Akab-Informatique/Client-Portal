import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { ensureSoleContact } from "./contactDefaults.ts";
import { provisionPortalUsers } from "./portalUsers.ts";

/** One line of the hand-over sheet: a client and the address(es) invoices go to. */
export type BillingRow = { client: string; emails: string[] };

export type BillingResult = {
  client: string;
  status: "done" | "unchanged" | "kept" | "no_match" | "ambiguous";
  email?: string;
  contactMade?: string[];
  note?: string;
};

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Minimal CSV reader (quotes, commas, BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (row.push(cell), (cell = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows;
}

/** The sheet's rows that have at least one valid address (duplicates inside a row removed). */
export function billingRows(csv: string): BillingRow[] {
  const [head, ...lines] = parseCsv(csv);
  const ci = head.findIndex((h) => norm(h) === "client");
  const ei = head.findIndex((h) => norm(h).startsWith("courriel"));
  if (ci < 0 || ei < 0) throw new Error("columns Client and Courriel(s) facturation not found");
  const out: BillingRow[] = [];
  for (const l of lines) {
    const seen = new Set<string>();
    const emails = (l[ei] ?? "")
      .split(/[;,\s]+/)
      .map((e) => e.trim())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
      .filter((e) => !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
    if (emails.length && l[ci]?.trim()) out.push({ client: l[ci].trim(), emails });
  }
  return out;
}

const GENERIC = new Set(["info", "admin", "administration", "comptabilite", "comptable", "facturation", "accounting", "finance", "ap", "gestion", "alarme", "reception", "bureau"]);
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** A readable contact name from an address: marilyne.rondeau@… → Marilyne Rondeau; info@… → Facturation. */
export function contactNameOf(email: string): { firstName: string; lastName: string } {
  const local = email.split("@")[0].toLowerCase();
  const parts = local.split(/[._-]+/).filter((p) => /^[a-z]+$/.test(p));
  if (parts.length >= 2) return { firstName: cap(parts[0]), lastName: parts.slice(1).map(cap).join(" ") };
  if (parts.length === 1 && !GENERIC.has(parts[0]) && parts[0].length > 2) return { firstName: cap(parts[0]), lastName: "" };
  return { firstName: "Facturation", lastName: "" };
}

/**
 * For each client of the sheet: makes a contact for every address (unless the client already has a contact with it)
 * and sets the first address as the client's billing email. A billing email already set to something else is kept
 * unless `overwrite`. `apply: false` only reports.
 */
export async function importBillingEmails(rows: BillingRow[], opts: { apply: boolean; overwrite?: boolean }): Promise<BillingResult[]> {
  const d = db();
  const clients = await d.select().from(schema.clients);
  const byName = new Map<string, (typeof clients)[number][]>();
  for (const c of clients) byName.set(norm(c.name), [...(byName.get(norm(c.name)) ?? []), c]);
  const out: BillingResult[] = [];
  for (const r of rows) {
    const hits = byName.get(norm(r.client)) ?? [];
    if (!hits.length) {
      out.push({ client: r.client, status: "no_match" });
      continue;
    }
    // two files with the same name: the active one
    const active = hits.filter((h) => h.active);
    if (hits.length > 1 && active.length !== 1) {
      out.push({ client: r.client, status: "ambiguous", note: `${hits.length} clients with this name` });
      continue;
    }
    const client = active.length === 1 ? active[0] : hits[0];
    const have = await d.select().from(schema.clientContacts).where(eq(schema.clientContacts.clientId, client.id));
    const made: string[] = [];
    let billingContactId: string | undefined = have.find((c) => (c.email ?? "").trim().toLowerCase() === r.emails[0].toLowerCase())?.id;
    for (const email of r.emails) {
      if (have.some((c) => (c.email ?? "").trim().toLowerCase() === email.toLowerCase())) continue;
      made.push(email);
      if (opts.apply) {
        const n = contactNameOf(email);
        const [row] = await d.insert(schema.clientContacts).values({ clientId: client.id, autotaskId: `local-${crypto.randomUUID()}`, firstName: n.firstName, lastName: n.lastName, email, title: "Facturation", syncedAt: new Date() }).returning({ id: schema.clientContacts.id });
        if (email === r.emails[0]) billingContactId = row.id;
      }
    }
    const email = r.emails[0];
    const current = client.invoice?.billingEmail?.trim();
    let status: BillingResult["status"] = "done";
    let note = r.emails.length > 1 ? `other addresses are contacts only: ${r.emails.slice(1).join(", ")}` : undefined;
    if (current && current.toLowerCase() === email.toLowerCase()) status = "unchanged";
    else if (current && !opts.overwrite) {
      status = "kept";
      note = `already ${current}`;
    } else if (opts.apply) {
      await d.update(schema.clients).set({ invoice: { ...client.invoice, billingEmail: email, ...(billingContactId ? { billingContactId } : {}) }, updatedAt: new Date() }).where(eq(schema.clients.id, client.id));
    }
    if (opts.apply && made.length) await provisionPortalUsers(client.id);
    if (opts.apply) await ensureSoleContact(client.id);
    out.push({ client: client.name, status, email, contactMade: made, note });
  }
  return out;
}
