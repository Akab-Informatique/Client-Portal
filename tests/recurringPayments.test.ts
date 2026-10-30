import { describe, expect, it } from "vitest";
import { occurrences, parseAmount, parseSheet } from "../server/lib/recurringPayments.ts";

const SHEET = [
  "Date de facture\tFournisseur\tMontant\tCompte \tPayé par\tFréquence\tNotes",
  "\tMasse salariale\t2 400,00 $\tCompte A\tVirement\tHebdomadaire\t",
  "1er\tLoyer\t2293.75\tCompte A\tPrélèvement\tMensuel\t",
  "\tAssurance\t225\tCompte A\tPrélèvement\tMensuel\t",
  "15ie\tAbonnement\t40\tCarte\tPrélèvement\t\tBNI",
  "Annuel\tChambre de commerce\t172\tCarte\tCarte\tAnnuel\t",
  "\tMembre sans prix\t?\tCompte A\tVirement\tAnnuel\t",
  "\tTOTAL\t999\t\t\t\t",
].join("\n");

describe("recurring payments: the spreadsheet pasted in", () => {
  it("amounts: dollars with a comma, a space or a sign; none when unknown", () => {
    expect(parseAmount("2 400,00 $")).toBe(240000);
    expect(parseAmount("114.98")).toBe(11498);
    expect(parseAmount("?")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });

  it("a line with no day takes the day of the line above; no frequency is monthly; totals are left out", () => {
    const { rows, skipped } = parseSheet(SHEET);
    expect(skipped).toBe(1);
    expect(rows.map((r) => [r.name, r.frequency, r.dayOfMonth, r.weekday, r.amountCents])).toEqual([
      ["Masse salariale", "weekly", null, 5, 240000],
      ["Loyer", "monthly", 1, null, 229375],
      ["Assurance", "monthly", 1, null, 22500],
      ["Abonnement", "monthly", 15, null, 4000],
      ["Chambre de commerce", "yearly", null, null, 17200],
      ["Membre sans prix", "yearly", null, null, null],
    ]);
    expect(rows[3]).toMatchObject({ account: "Carte", method: "Prélèvement", notes: "BNI" });
  });

  it("the days a payment falls on: monthly (short months use their last day), weekly, yearly", () => {
    expect(occurrences({ frequency: "monthly", dayOfMonth: 31, weekday: null, month: null }, "2027-01-15", "2027-03-31")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
    expect(occurrences({ frequency: "monthly", dayOfMonth: 10, weekday: null, month: null }, "2027-01-11", "2027-02-09")).toEqual([]);
    expect(occurrences({ frequency: "weekly", dayOfMonth: null, weekday: 5, month: null }, "2027-01-01", "2027-01-22")).toEqual(["2027-01-01", "2027-01-08", "2027-01-15", "2027-01-22"]);
    expect(occurrences({ frequency: "yearly", dayOfMonth: 20, weekday: null, month: 6 }, "2027-01-01", "2028-12-31")).toEqual(["2027-06-20", "2028-06-20"]);
    // what is not known yet falls nowhere
    expect(occurrences({ frequency: "yearly", dayOfMonth: 20, weekday: null, month: null }, "2027-01-01", "2027-12-31")).toEqual([]);
    expect(occurrences({ frequency: "monthly", dayOfMonth: null, weekday: null, month: null }, "2027-01-01", "2027-12-31")).toEqual([]);
  });
});
