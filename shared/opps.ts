/**
 * Opportunités: a lead a technician flags for the sales technician.
 * Not the Ventes pipeline (sales_opportunities): this is the intake and the backlog —
 * where an opportunity came from, who handled it, what it became (quote, contract,
 * charge, project) and how it ended (won, lost, canceled).
 */

/** Where the opportunity came from (the log of its origin) */
export const OPP_SOURCES = ["ticket", "sales_call", "tech_call", "onsite", "email", "other"] as const;
export type OppSource = (typeof OPP_SOURCES)[number];

/** What the sales technician has to do: only send a quote, or call the client to make the sale */
export const OPP_HANDLINGS = ["quote_only", "needs_call"] as const;
export type OppHandling = (typeof OPP_HANDLINGS)[number];

/**
 * new = flagged, nobody on it yet; working = a sales technician has it;
 * won / lost / canceled = closed, so archived (never deleted).
 */
export const OPP_STATUSES = ["new", "working", "won", "lost", "canceled"] as const;
export type OppStatus = (typeof OPP_STATUSES)[number];
export const isOpenOpp = (s: string) => s === "new" || s === "working";

export const OPP_LOST_REASONS = ["price", "timing", "incumbent", "no_answer", "other"] as const;

/** What an opportunity can be linked to: what it became */
export const OPP_LINK_KINDS = ["quote", "contract", "charge", "project"] as const;
export type OppLinkKind = (typeof OPP_LINK_KINDS)[number];
