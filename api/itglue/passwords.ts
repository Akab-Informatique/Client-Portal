import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  createPassword,
  findUsersByEmail,
  getOrganization,
  isItGlueConfigured,
  listPasswordsForOrganization,
  mockCreatePassword,
  mockPasswordsForOrg,
  userCanAccessPassword,
  type ItGluePassword,
} from "../_lib/itglue-client.js";

/**
 * GET  /api/itglue/passwords — list (filtered by MyGlue-style access)
 * POST /api/itglue/passwords — create password in organization
 *
 * Shared query/body identity fields:
 *  - organizationId (required)
 *  - itglueUserId, email, role (optional — for access checks)
 *  - q (GET only — name/username search)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") {
      return await handleList(req, res);
    }
    if (req.method === "POST") {
      return await handleCreate(req, res);
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
      configured: isItGlueConfigured(),
      passwords: [],
    });
  }
}

function parseIdentity(req: VercelRequest) {
  const body =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};
  const organizationId = Number(
    String(
      req.query.organizationId ??
        req.query.orgId ??
        body.organizationId ??
        body.orgId ??
        "",
    ).trim(),
  );
  const role = String(
    req.query.role ?? body.role ?? "client",
  ).toLowerCase();
  const isStaff = role === "admin" || role === "technician";
  const email = String(req.query.email ?? body.email ?? "")
    .trim()
    .toLowerCase();
  let itglueUserId: number | null = (() => {
    const raw = String(
      req.query.itglueUserId ??
        req.query.userId ??
        body.itglueUserId ??
        body.userId ??
        "",
    ).trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  return { organizationId, role, isStaff, email, itglueUserId };
}

async function resolveItGlueUser(
  itglueUserId: number | null,
  email: string,
): Promise<{
  itglueUserId: number | null;
  resolvedByEmail: number | null;
  resolveNote: string | null;
}> {
  let resolvedByEmail: number | null = null;
  let resolveNote: string | null = null;
  let id = itglueUserId;
  if (id == null && email && isItGlueConfigured()) {
    try {
      const found = await findUsersByEmail(email);
      if (found.length === 1) {
        id = found[0].id;
        resolvedByEmail = found[0].id;
        resolveNote = `Matched IT Glue user #${found[0].id} by email.`;
      } else if (found.length > 1) {
        resolveNote = `Multiple IT Glue users match ${email}; link the correct user id on the portal user profile.`;
      } else {
        resolveNote = `No IT Glue/MyGlue user found for ${email}.`;
      }
    } catch {
      resolveNote = "Could not auto-match IT Glue user by email.";
    }
  }
  return { itglueUserId: id, resolvedByEmail, resolveNote };
}

function toListItem(p: ItGluePassword) {
  return {
    id: p.id,
    name: p.name,
    username: p.username,
    url: p.url,
    notes: p.notes,
    organizationId: p.organizationId,
    organizationName: p.organizationName,
    categoryId: p.categoryId,
    categoryName: p.categoryName,
    folderId: p.folderId,
    restricted: p.restricted,
    archived: p.archived,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
    hasPassword: true,
  };
}

function toDetail(p: ItGluePassword) {
  return {
    ...toListItem(p),
    password: p.password,
  };
}

async function handleList(req: VercelRequest, res: VercelResponse) {
  const parsed = parseIdentity(req);
  if (!Number.isFinite(parsed.organizationId) || parsed.organizationId <= 0) {
    return res.status(400).json({
      error:
        "Missing IT Glue organization ID. Set it on the client company under Clients → Edit.",
      configured: isItGlueConfigured(),
      passwords: [],
    });
  }

  const q = String(req.query.q ?? req.query.search ?? "").trim();
  const resolved = await resolveItGlueUser(parsed.itglueUserId, parsed.email);
  const itglueUserId = resolved.itglueUserId;
  const organizationId = parsed.organizationId;
  const isStaff = parsed.isStaff;

  if (!isItGlueConfigured()) {
    const mocked = mockPasswordsForOrg(organizationId, itglueUserId).filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q.toLowerCase()) ||
        (p.username || "").toLowerCase().includes(q.toLowerCase()),
    );
    return res.status(200).json({
      configured: false,
      mock: true,
      organizationId,
      itglueUserId,
      organization: { id: organizationId, name: "Demo Organization" },
      passwords: mocked.map(toListItem),
      error:
        "IT Glue API key not configured — showing demo passwords. Add ITGLUE_API_KEY with Password Access.",
    });
  }

  let organizationName: string | null = null;
  try {
    const org = await getOrganization(organizationId);
    organizationName = org?.name ?? null;
  } catch {
    /* optional */
  }

  let listed: ItGluePassword[];
  try {
    listed = await listPasswordsForOrganization({
      organizationId,
      search: q || null,
    });
  } catch (e) {
    return res.status(200).json({
      configured: true,
      mock: false,
      organizationId,
      itglueUserId,
      passwords: [],
      error: e instanceof Error ? e.message : "Failed to list passwords",
    });
  }

  const allowUnscopedStaff = isStaff && itglueUserId == null;
  const visible = listed.filter((p) =>
    userCanAccessPassword(p, {
      itglueUserId,
      organizationId,
      allowUnscopedStaff,
    }),
  );

  const filtered = q
    ? visible.filter(
        (p) =>
          p.name.toLowerCase().includes(q.toLowerCase()) ||
          (p.username || "").toLowerCase().includes(q.toLowerCase()) ||
          (p.url || "").toLowerCase().includes(q.toLowerCase()),
      )
    : visible;

  return res.status(200).json({
    configured: true,
    mock: false,
    organizationId,
    organization: organizationName
      ? { id: organizationId, name: organizationName }
      : { id: organizationId, name: null },
    itglueUserId,
    resolvedByEmail: resolved.resolvedByEmail,
    resolveNote: resolved.resolveNote,
    unscopedStaff: allowUnscopedStaff,
    totalInOrg: listed.length,
    passwords: filtered.map(toListItem),
  });
}

async function handleCreate(req: VercelRequest, res: VercelResponse) {
  const parsed = parseIdentity(req);
  if (!Number.isFinite(parsed.organizationId) || parsed.organizationId <= 0) {
    return res.status(400).json({
      error:
        "Missing IT Glue organization ID. Set it on the client company under Clients → Edit.",
      configured: isItGlueConfigured(),
    });
  }

  const body =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};

  const name = String(body.name ?? "").trim();
  const password = String(body.password ?? "");
  const username =
    body.username == null ? null : String(body.username).trim() || null;
  const url = body.url == null ? null : String(body.url).trim() || null;
  const notes = body.notes == null ? null : String(body.notes).trim() || null;
  const restricted = body.restricted === true || body.restricted === "true";

  if (!name) {
    return res.status(400).json({ error: "Name is required." });
  }
  if (!password) {
    return res.status(400).json({ error: "Password value is required." });
  }

  const resolved = await resolveItGlueUser(parsed.itglueUserId, parsed.email);
  const itglueUserId = resolved.itglueUserId;
  const organizationId = parsed.organizationId;

  // Anyone who can open the vault for this org may create (staff + client users)
  if (!isItGlueConfigured()) {
    try {
      const created = mockCreatePassword(
        {
          name,
          password,
          username,
          url,
          notes,
          restricted,
          organizationId,
        },
        itglueUserId,
      );
      return res.status(201).json({
        configured: false,
        mock: true,
        password: toDetail(created),
      });
    } catch (e) {
      return res.status(400).json({
        error: e instanceof Error ? e.message : "Failed to create password",
        mock: true,
      });
    }
  }

  try {
    const created = await createPassword({
      name,
      password,
      username,
      url,
      notes,
      restricted,
      organizationId,
    });
    return res.status(201).json({
      configured: true,
      mock: false,
      itglueUserId,
      password: toDetail(created),
    });
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : "Failed to create password",
      configured: true,
    });
  }
}
