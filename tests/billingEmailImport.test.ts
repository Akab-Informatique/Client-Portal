import { describe, expect, it } from "vitest";

const CSV = [
  "\uFEFFClient,Courriel(s) facturation,Source,Envoi courriel activé,Note",
  "Sans courriel,,Aucun,Non,",
  "Acme Inc.,marilyne.rondeau@acme.ca,Destinataire de facture,Oui,",
  "Beta,info@beta.ca; Jean@beta.ca; info@beta.ca,Destinataire de facture,Oui,",
  "Gamma,gamma@gamma.ca,Destinataire de facture,Oui,",
  "Inconnu,x@y.ca,Destinataire de facture,Oui,",
].join("\n");

describe("billing emails: contacts and default billing address from the hand-over sheet", () => {
  it("names, rows, and what is written (dry run first, nothing overwritten)", async () => {
    process.env.NODE_ENV = "test";
    const { initDb, db, schema } = await import("../server/db/index.ts");
    await initDb({ memory: true });
    const { billingRows, contactNameOf, importBillingEmails } = await import("../server/lib/billingEmailImport.ts");
    const { eq } = await import("drizzle-orm");

    expect(contactNameOf("marilyne.rondeau@x.ca")).toEqual({ firstName: "Marilyne", lastName: "Rondeau" });
    expect(contactNameOf("INFO@x.ca")).toEqual({ firstName: "Facturation", lastName: "" });
    expect(contactNameOf("mario@x.ca")).toEqual({ firstName: "Mario", lastName: "" });

    const rows = billingRows(CSV);
    expect(rows.map((r) => [r.client, r.emails])).toEqual([
      ["Acme Inc.", ["marilyne.rondeau@acme.ca"]],
      ["Beta", ["info@beta.ca", "Jean@beta.ca"]],
      ["Gamma", ["gamma@gamma.ca"]],
      ["Inconnu", ["x@y.ca"]],
    ]);

    const d = db();
    const [acme] = await d.insert(schema.clients).values({ name: "Acme inc" }).returning();
    const [beta] = await d.insert(schema.clients).values({ name: "BETA" }).returning();
    const [gamma] = await d.insert(schema.clients).values({ name: "Gamma", invoice: { billingEmail: "ancien@gamma.ca" } }).returning();
    await d.insert(schema.clientContacts).values({ clientId: beta.id, firstName: "Déjà", lastName: "Là", email: "INFO@beta.ca" });

    const dry = await importBillingEmails(rows, { apply: false });
    expect(dry.map((r) => r.status)).toEqual(["done", "done", "kept", "no_match"]);
    expect((await d.select().from(schema.clientContacts).where(eq(schema.clientContacts.clientId, acme.id))).length).toBe(0);

    await importBillingEmails(rows, { apply: true });
    const contactsOf = async (id: string) => (await d.select().from(schema.clientContacts).where(eq(schema.clientContacts.clientId, id))).map((c) => c.email?.toLowerCase()).sort();
    const billing = async (id: string) => (await d.select().from(schema.clients).where(eq(schema.clients.id, id)))[0].invoice?.billingEmail;
    const billingContact = async (id: string) => (await d.select().from(schema.clients).where(eq(schema.clients.id, id)))[0].invoice?.billingContactId;
    expect(await contactsOf(acme.id)).toEqual(["marilyne.rondeau@acme.ca"]);
    expect(await billing(acme.id)).toBe("marilyne.rondeau@acme.ca");
    // the contact with that address was already there: only the other one is made
    expect(await contactsOf(beta.id)).toEqual(["info@beta.ca", "jean@beta.ca"]);
    expect(await billing(beta.id)).toBe("info@beta.ca");
    // the contact is the default billing contact (the one that already existed for Beta)
    const [betaInfo] = await d.select().from(schema.clientContacts).where(eq(schema.clientContacts.firstName, "Déjà"));
    expect(await billingContact(beta.id)).toBe(betaInfo.id);
    expect(await billingContact(acme.id)).toBeTruthy();
    // a billing email already set is kept
    expect(await billing(gamma.id)).toBe("ancien@gamma.ca");

    // run again: nothing new
    const again = await importBillingEmails(rows, { apply: true });
    expect(again.map((r) => r.status)).toEqual(["unchanged", "unchanged", "kept", "no_match"]);
    expect(again.every((r) => !r.contactMade?.length)).toBe(true);
    // overwrite replaces it
    await importBillingEmails(rows, { apply: true, overwrite: true });
    expect(await billing(gamma.id)).toBe("gamma@gamma.ca");
  });
});
