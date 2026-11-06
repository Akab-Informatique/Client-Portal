import { describe, expect, it } from "vitest";
import { invoiceMatcher, parseAmount, type SearchableInvoice } from "../shared/invoiceSearch.ts";

const inv = (number: string, clientName: string, totalCents: number, balanceCents = totalCents, poNumber: string | null = null): SearchableInvoice => ({ number, clientName, totalCents, balanceCents, poNumber });
const ICODEV = inv("10100", "Icodev Inc.", 103516);
const DAMES = inv("10101", "Les Dames de Paroles", 15000, 0, "BC-778");
const BOUCH = inv("10102", "Boucherie Lévesque", 4599);
const all = [ICODEV, DAMES, BOUCH];
const find = (q: string) => all.filter(invoiceMatcher(q)).map((x) => x.number);

describe("invoice search", () => {
  it("reads amounts the way people type them", () => {
    expect(parseAmount("150")).toBe(15000);
    expect(parseAmount("150,25")).toBe(15025);
    expect(parseAmount("1 035,16 $")).toBe(103516);
    expect(parseAmount("1,035.16")).toBe(103516);
    expect(parseAmount("1.035")).toBe(103500);
    expect(parseAmount("icodev")).toBeNull();
  });
  it("finds a client by name, accents and case ignored, with a typo", () => {
    expect(find("dames")).toEqual(["10101"]);
    expect(find("levesque")).toEqual(["10102"]);
    expect(find("DAMES PAROLE")).toEqual(["10101"]);
    expect(find("icodve")).toEqual(["10100"]);
    expect(find("bouch")).toEqual(["10102"]);
    expect(find("zzz")).toEqual([]);
  });
  it("finds an amount and what is near it", () => {
    expect(find("1035,16")).toEqual(["10100"]);
    expect(find("1035")).toEqual(["10100"]);
    expect(find("150")).toEqual(["10101"]);
    expect(find("46")).toEqual(["10102"]);
    expect(find("45,99 $")).toEqual(["10102"]);
  });
  it("still finds the number and the PO", () => {
    expect(find("10102")).toEqual(["10102"]);
    expect(find("bc-778")).toEqual(["10101"]);
    expect(find("icodev 1035")).toEqual(["10100"]);
  });
});
