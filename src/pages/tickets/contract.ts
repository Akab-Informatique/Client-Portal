import type { TFunction } from "i18next";
import { money } from "@/pages/crm/shared";
import type { TicketContract } from "./shared";

/** What a contract means for the hours worked under it, in one line. */
export function contractNote(t: TFunction, lang: string, k: TicketContract | null | undefined): string {
  if (!k) return t("tickets.contractBilling.none");
  if (k.mode === "hourly") return t("tickets.contractBilling.hourlyNote", { rate: k.rateCents != null ? money(k.rateCents, lang) : "—" });
  if (k.mode === "monthly") return t("tickets.contractBilling.monthlyNote", { rate: k.monthlyRateCents != null ? money(k.monthlyRateCents, lang) : "—" });
  if (k.mode === "per_ticket") return t("tickets.contractBilling.ticketNote", { rate: k.ticketRateCents != null ? money(k.ticketRateCents, lang) : "—" });
  return t("tickets.contractBilling.noneNote");
}
