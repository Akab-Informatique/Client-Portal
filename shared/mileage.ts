/**
 * A mileage expense (déplacement): an expense type counted in km. The employee says where from and where to
 * and the kilometres; the screens show the distance paid, never the amount in money.
 */
export const isMileageUnit = (unit: string | null | undefined): boolean => (unit ?? "").trim().toLowerCase() === "km";

/** "Joliette → Montréal" (what the line says when no note is written) */
export const tripLabel = (from: string | null | undefined, to: string | null | undefined): string => `${(from ?? "").trim()} → ${(to ?? "").trim()}`;
