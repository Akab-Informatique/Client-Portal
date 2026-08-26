/**
 * Load per-company Graph credentials from Postgres and open sealed secrets.
 * Never expose opened secrets to the browser — only use inside /api/sharepoint/*.
 */

import { getPool } from "./pg.js";
import { openSecret } from "./secret-box.js";
import type { GraphCredentialOverride } from "./graph-client.js";

export async function loadCompanyGraphAuth(
  companyId: number,
): Promise<GraphCredentialOverride | null> {
  if (!Number.isFinite(companyId) || companyId <= 0) return null;
  const p = getPool();
  const r = await p.query(
    `SELECT sharepoint_tenant_id, sharepoint_client_id, sharepoint_client_secret
     FROM companies WHERE id = $1 LIMIT 1`,
    [companyId],
  );
  const row = r.rows[0] as
    | {
        sharepoint_tenant_id?: string | null;
        sharepoint_client_id?: string | null;
        sharepoint_client_secret?: string | null;
      }
    | undefined;
  if (!row) return null;
  const sealed = row.sharepoint_client_secret;
  const opened =
    sealed && String(sealed).trim() && String(sealed).trim() !== "configured"
      ? openSecret(String(sealed))
      : null;
  return {
    tenantId: row.sharepoint_tenant_id ?? null,
    clientId: row.sharepoint_client_id ?? null,
    clientSecret: opened,
  };
}
