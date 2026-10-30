import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { audit } from "./audit.ts";
import { isOpenStage, OPEN_STAGES, type SalesStage } from "../../shared/sales.ts";
import { lineAmount, recurrenceOf } from "../../shared/quotes.ts";
import { settle } from "../routes/sales.ts";

/**
 * Vente › Soumissions → Vente › Ventes: every quote has an opportunity in the sales pipeline, made when the quote is
 * made (`quotes.opportunity_id`) and kept in step with it:
 * - a draft is a **meeting** (the quote is being prepared), sent = **quote sent** (the quote is dated),
 *   accepted = **won**, declined ("non retenue") = **lost** (reason "other");
 * - the stage only moves forward by itself (a draft put back from "sent" leaves the card where it is), except that a
 *   closed card is opened again when its quote is brought back to a draft or sent, and a card moved by hand to a later
 *   stage is not pulled back;
 * - the amounts follow the quote while the card is open: monthly lines (yearly ones divided by 12) are the recurring
 *   value, the one-time lines the one-time value (before taxes).
 * Never fails the quote: a problem here is logged and the quote goes on.
 */
const STAGE_OF: Record<string, SalesStage> = { draft: "meeting", sent: "quote_sent", accepted: "won", declined: "lost" };
const rank = (s: string) => OPEN_STAGES.indexOf(s as SalesStage);

/** What the quote is worth, before taxes: the recurring part (a month) and the one-time part */
export async function quoteWorth(quoteId: string) {
  const lines = await db().select().from(schema.quoteLines).where(eq(schema.quoteLines.quoteId, quoteId));
  let once = 0;
  let monthly = 0;
  let yearly = 0;
  for (const l of lines) {
    if (l.optional) continue;
    const r = recurrenceOf(l);
    const amount = lineAmount(l);
    if (r === "monthly") monthly += amount;
    else if (r === "yearly") yearly += amount;
    else once += amount;
  }
  return { oneTimeCents: once, monthlyCents: monthly + Math.round(yearly / 12) };
}

const todayQc = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

export async function syncQuoteToPipeline(quoteId: string, actorId: string): Promise<void> {
  try {
    const d = db();
    const [q] = await d.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
    if (!q) return;
    const today = todayQc();
    const [client] = q.clientId ? await d.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, q.clientId)) : [];
    const company = (client?.name ?? q.prospectName ?? "").trim() || q.number;
    const worth = await quoteWorth(q.id);
    const recurring = worth.monthlyCents > 0;
    // the pipeline counts recurring as users × a price per user: one "user" at the quote's monthly price
    const money = { kind: recurring ? ("recurring" as const) : ("one_time" as const), users: recurring ? 1 : null, ratePerUserCents: recurring ? worth.monthlyCents : 15_000, oneTimeCents: worth.oneTimeCents };
    const target = STAGE_OF[q.status] ?? "meeting";
    const note = `${q.number}${q.title ? ` — ${q.title}` : ""}`;

    const [cur] = q.opportunityId ? await d.select().from(schema.salesOpportunities).where(eq(schema.salesOpportunities.id, q.opportunityId)) : [];
    if (!cur) {
      const patch = { stage: target, lostReason: target === "lost" ? ("other" as const) : null, quoteSentOn: q.sentAt ? today : null };
      const [row] = await d
        .insert(schema.salesOpportunities)
        .values({
          source: "other",
          openedOn: today,
          companyName: company,
          clientId: q.clientId,
          contactName: q.contactName,
          contactEmail: q.contactEmail,
          ...money,
          ...settle(null, patch, today),
          notes: note,
          ownerId: q.preparedBy ?? actorId,
          createdBy: actorId,
        })
        .returning({ id: schema.salesOpportunities.id });
      await d.update(schema.quotes).set({ opportunityId: row.id }).where(eq(schema.quotes.id, q.id));
      await audit(actorId, "sales.opportunity_from_quote", row.id, { quote: q.number, stage: target });
      return;
    }

    // the card exists: the stage moves forward (or opens / closes with the quote), the amounts follow while it is open
    const patch: Record<string, unknown> = {};
    const closedTarget = !isOpenStage(target);
    if (closedTarget) {
      if (cur.stage !== target) Object.assign(patch, { stage: target, lostReason: target === "lost" ? "other" : null });
    } else if (!isOpenStage(cur.stage)) {
      // brought back to a draft or sent: the closed card is opened again
      Object.assign(patch, { stage: target });
    } else if (rank(target) > rank(cur.stage)) {
      Object.assign(patch, { stage: target });
    }
    const stillOpen = isOpenStage((patch.stage as string | undefined) ?? cur.stage);
    if (stillOpen) Object.assign(patch, { ...money, companyName: company, clientId: q.clientId, contactName: q.contactName ?? cur.contactName, contactEmail: q.contactEmail ?? cur.contactEmail });
    if (Object.keys(patch).length === 0) return;
    await d
      .update(schema.salesOpportunities)
      .set({ ...settle(cur, patch, today), updatedAt: new Date() })
      .where(eq(schema.salesOpportunities.id, cur.id));
  } catch (e) {
    console.warn("[quotes] pipeline:", e instanceof Error ? e.message : e);
  }
}
