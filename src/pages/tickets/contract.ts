import type { TFunction } from "i18next";
import { money } from "@/pages/crm/shared";
import type { TicketContract } from "./shared";

/** What a contract means for the hours worked under it, in one line. */
export function contractNote(t: TFunction, lang: string, k: TicketContract | null | undefined): string {
  if (!k) return t("tickets.contractBilling.none");
  // the contract's hourly rate bills the hours; a rate of 0 means they are included
  if (k.billed && k.rateCents != null) return t("tickets.contractBilling.hourlyNote", { rate: money(k.rateCents, lang) });
  if (k.mode === "hourly") return t("tickets.contractBilling.includedNote");
  if (k.mode === "monthly") return t("tickets.contractBilling.monthlyNote", { rate: k.monthlyRateCents != null ? money(k.monthlyRateCents, lang) : "—" });
  if (k.mode === "per_ticket") return t("tickets.contractBilling.ticketNote", { rate: k.ticketRateCents != null ? money(k.ticketRateCents, lang) : "—" });
  if (k.mode === "banked") return t("tickets.contractBilling.bankedNote", { used: k.usedHours ?? 0, total: k.bankedHours ?? 0, left: Math.max(0, (k.bankedHours ?? 0) - (k.usedHours ?? 0)) });
  if (k.mode === "fixed") return t("tickets.contractBilling.fixedNote", { price: k.fixedPriceCents != null ? money(k.fixedPriceCents, lang) : "—" });
  return t("tickets.contractBilling.noneNote");
}
