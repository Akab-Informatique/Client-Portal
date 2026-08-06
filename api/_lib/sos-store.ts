/**
 * Persist SOS requests in Postgres (production) or a process-local fallback.
 * Browser PGlite cannot be written from serverless API routes, so production
 * always uses Postgres via POSTGRES_* / DATABASE_URL.
 */
import { getPool, isPostgresConfigured, runMigrations } from "./pg.js";

export type SosRequestRow = {
  id: number;
  company_id: number;
  company_name: string;
  user_id: number;
  user_name: string;
  user_email: string;
  issue: string | null;
  status: string;
  splashtop_session_id: string | null;
  sos_code: string | null;
  support_portal_link: string | null;
  channel_id: string | null;
  error_message: string | null;
  expires_at: string | null;
  closed_at: string | null;
  closed_by_user_id: number | null;
  last_polled_at: string | null;
  remote_snapshot: string | null;
  created_at: string;
};

/** In-memory fallback when Postgres is not configured (local demo only). */
const mem: SosRequestRow[] = [];
let memSeq = 1;

function mapRow(r: Record<string, unknown>): SosRequestRow {
  return {
    id: Number(r.id),
    company_id: Number(r.company_id),
    company_name: String(r.company_name ?? ""),
    user_id: Number(r.user_id),
    user_name: String(r.user_name ?? ""),
    user_email: String(r.user_email ?? ""),
    issue: r.issue != null ? String(r.issue) : null,
    status: String(r.status ?? "open"),
    splashtop_session_id:
      r.splashtop_session_id != null ? String(r.splashtop_session_id) : null,
    sos_code: r.sos_code != null ? String(r.sos_code) : null,
    support_portal_link:
      r.support_portal_link != null ? String(r.support_portal_link) : null,
    channel_id: r.channel_id != null ? String(r.channel_id) : null,
    error_message: r.error_message != null ? String(r.error_message) : null,
    expires_at: r.expires_at != null ? String(r.expires_at) : null,
    closed_at: r.closed_at != null ? String(r.closed_at) : null,
    closed_by_user_id:
      r.closed_by_user_id != null ? Number(r.closed_by_user_id) : null,
    last_polled_at: r.last_polled_at != null ? String(r.last_polled_at) : null,
    remote_snapshot:
      r.remote_snapshot != null ? String(r.remote_snapshot) : null,
    created_at:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at ?? new Date().toISOString()),
  };
}

async function withPg<T>(
  fn: (client: {
    query: (
      text: string,
      params?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[] }>;
  }) => Promise<T>,
): Promise<T | null> {
  try {
    await runMigrations();
    const pool = getPool();
    if (!pool) return null;
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  } catch {
    return null;
  }
}

export async function insertSosRequest(input: {
  company_id: number;
  company_name: string;
  user_id: number;
  user_name: string;
  user_email: string;
  issue?: string | null;
  status: string;
  splashtop_session_id?: string | null;
  sos_code?: string | null;
  support_portal_link?: string | null;
  channel_id?: string | null;
  error_message?: string | null;
  expires_at?: string | null;
}): Promise<SosRequestRow> {
  const viaPg = await withPg(async (client) => {
    const r = await client.query(
      `INSERT INTO sos_requests (
        company_id, company_name, user_id, user_name, user_email, issue, status,
        splashtop_session_id, sos_code, support_portal_link, channel_id,
        error_message, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        input.company_id,
        input.company_name,
        input.user_id,
        input.user_name,
        input.user_email,
        input.issue ?? null,
        input.status,
        input.splashtop_session_id ?? null,
        input.sos_code ?? null,
        input.support_portal_link ?? null,
        input.channel_id ?? null,
        input.error_message ?? null,
        input.expires_at ?? null,
      ],
    );
    return mapRow(r.rows[0]);
  });
  if (viaPg) return viaPg;

  const row: SosRequestRow = {
    id: memSeq++,
    company_id: input.company_id,
    company_name: input.company_name,
    user_id: input.user_id,
    user_name: input.user_name,
    user_email: input.user_email,
    issue: input.issue ?? null,
    status: input.status,
    splashtop_session_id: input.splashtop_session_id ?? null,
    sos_code: input.sos_code ?? null,
    support_portal_link: input.support_portal_link ?? null,
    channel_id: input.channel_id ?? null,
    error_message: input.error_message ?? null,
    expires_at: input.expires_at ?? null,
    closed_at: null,
    closed_by_user_id: null,
    last_polled_at: null,
    remote_snapshot: null,
    created_at: new Date().toISOString(),
  };
  mem.unshift(row);
  return row;
}

export async function getSosRequestById(
  id: number,
): Promise<SosRequestRow | null> {
  const viaPg = await withPg(async (client) => {
    const r = await client.query(`SELECT * FROM sos_requests WHERE id = $1`, [
      id,
    ]);
    return r.rows[0] ? mapRow(r.rows[0]) : null;
  });
  if (viaPg !== null) return viaPg;
  return mem.find((m) => m.id === id) ?? null;
}

export async function listOpenSosRequests(opts?: {
  userId?: number;
  limit?: number;
}): Promise<SosRequestRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  const openStatuses = ["open", "waiting", "ready", "connected"];

  const viaPg = await withPg(async (client) => {
    if (opts?.userId != null) {
      const r = await client.query(
        `SELECT * FROM sos_requests
         WHERE user_id = $1 AND status = ANY($2::text[])
         ORDER BY created_at DESC
         LIMIT $3`,
        [opts.userId, openStatuses, limit],
      );
      return r.rows.map(mapRow);
    }
    const r = await client.query(
      `SELECT * FROM sos_requests
       WHERE status = ANY($1::text[])
       ORDER BY created_at DESC
       LIMIT $2`,
      [openStatuses, limit],
    );
    return r.rows.map(mapRow);
  });
  if (viaPg) return viaPg;

  let rows = mem.filter((m) => openStatuses.includes(m.status));
  if (opts?.userId != null) rows = rows.filter((m) => m.user_id === opts.userId);
  return rows.slice(0, limit);
}

export async function listRecentSosRequests(opts?: {
  limit?: number;
}): Promise<SosRequestRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const viaPg = await withPg(async (client) => {
    const r = await client.query(
      `SELECT * FROM sos_requests ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map(mapRow);
  });
  if (viaPg) return viaPg;
  return mem.slice(0, limit);
}

export async function updateSosRequest(
  id: number,
  patch: Partial<{
    status: string;
    sos_code: string | null;
    support_portal_link: string | null;
    splashtop_session_id: string | null;
    channel_id: string | null;
    error_message: string | null;
    expires_at: string | null;
    closed_at: string | null;
    closed_by_user_id: number | null;
    last_polled_at: string | null;
    remote_snapshot: string | null;
  }>,
): Promise<SosRequestRow | null> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return getSosRequestById(id);

  const viaPg = await withPg(async (client) => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const k of keys) {
      sets.push(`${k} = $${i++}`);
      vals.push(patch[k] ?? null);
    }
    vals.push(id);
    const r = await client.query(
      `UPDATE sos_requests SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    return r.rows[0] ? mapRow(r.rows[0]) : null;
  });
  if (viaPg !== null) return viaPg;

  const idx = mem.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  mem[idx] = { ...mem[idx], ...patch };
  return mem[idx];
}
