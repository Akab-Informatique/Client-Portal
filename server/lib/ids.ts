/**
 * Ids the portal gives to what it makes itself (once Autotask is not the
 * reference any more), kept apart from Autotask's so the two can never meet:
 * numbers (tickets, clients) from 1,000,000,000 up, text ids ("local-…") for
 * contacts and contracts. A sync with Autotask never touches them.
 */
export const NATIVE_ID_START = 1_000_000_000;
export const LOCAL_PREFIX = "local-";
export const isLocalId = (id: string | null | undefined) => (id ?? "").startsWith(LOCAL_PREFIX);
