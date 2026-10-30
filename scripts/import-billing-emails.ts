// One-off: contacts + billing email of every client, from the hand-over sheet (courriels_facturation.csv).
//   node --import tsx scripts/import-billing-emails.ts <file.csv>            → report only
//   node --import tsx scripts/import-billing-emails.ts <file.csv> --apply    → writes
//   add --overwrite to replace a billing email already set to another address
import fs from "node:fs";
import { initDb, closeDb } from "../server/db/index.ts";
import { billingRows, importBillingEmails } from "../server/lib/billingEmailImport.ts";

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("usage: import-billing-emails.ts <file.csv> [--apply] [--overwrite]");
  process.exit(1);
}
const apply = flags.includes("--apply");
await initDb();
const results = await importBillingEmails(billingRows(fs.readFileSync(file, "utf8")), { apply, overwrite: flags.includes("--overwrite") });
for (const r of results) console.log(`${r.status.padEnd(9)} ${r.client}${r.email ? ` → ${r.email}` : ""}${r.contactMade?.length ? ` (new contact: ${r.contactMade.join(", ")})` : ""}${r.note ? ` [${r.note}]` : ""}`);
const n = (s: string) => results.filter((r) => r.status === s).length;
console.log(`\n${apply ? "APPLIED" : "DRY RUN (nothing written)"}: ${n("done")} set, ${n("unchanged")} already right, ${n("kept")} kept, ${n("no_match")} not found, ${n("ambiguous")} ambiguous`);
await closeDb();
