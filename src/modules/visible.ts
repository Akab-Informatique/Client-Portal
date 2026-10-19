import type { PermissionKey } from "@shared/permissions";
import type { Me } from "@/lib/types";
import type { NavModule } from "./registry";

/**
 * May this person see the module in the sidebar (and the command palette)?
 * Its right, the opt-in when it has one, and its rule — unless they hold its
 * other right (managers see the timesheet even when they fill none).
 */
export function moduleVisible(m: NavModule, me: Me, can: (p: PermissionKey) => boolean): boolean {
  if (m.orRight && can(m.orRight)) return true;
  if (m.permission && !can(m.permission)) return false;
  if (m.optIn && !me.preferences[m.optIn]) return false;
  if (m.rule === "timesheetRequired" && !me.timesheetRequired) return false;
  return true;
}
