/**
 * AKAB client support contacts shown in the portal.
 * Update these when phone numbers or hours change.
 */
export const SUPPORT_PHONE_DISPLAY = "1-888-765-8841";
export const SUPPORT_PHONE_TEL = "+18887658841";
export const SUPPORT_HOURS =
  "Business hours · emergencies: call the support line anytime";

/** Standard note posted when a client requests elevation from the portal. */
export function buildElevationNoteBody(opts?: {
  ticketNumber?: string | null;
  userName?: string | null;
  userEmail?: string | null;
}): string {
  const who =
    [opts?.userName?.trim(), opts?.userEmail?.trim()]
      .filter(Boolean)
      .join(" · ") || "Client portal user";
  const ticket = opts?.ticketNumber?.trim() || "this ticket";

  return [
    "[ELEVATION REQUESTED — Client portal]",
    "",
    `${who} requested priority elevation on ${ticket}.`,
    "",
    "Please review and raise priority / escalate per AKAB procedure.",
    "",
    `If this is a true emergency, the client was instructed to call the AKAB support line at ${SUPPORT_PHONE_DISPLAY} rather than waiting on the portal.`,
  ].join("\n");
}

export const ELEVATION_NOTE_TITLE = "Elevation requested (client portal)";
