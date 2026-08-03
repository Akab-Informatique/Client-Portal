import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  deletePassword,
  findUsersByEmail,
  getPasswordById,
  isItGlueConfigured,
  mockDeletePassword,
  mockPasswordsForOrg,
  mockUpdatePassword,
  updatePassword,
  userCanAccessPassword,
  type ItGluePassword,
} from "../../_lib/itglue-client.js";

/**
 * GET    /api/itglue/passwords/:id — reveal (includes secret)
 * PATCH  /api/itglue/passwords/:id — update fields
 * DELETE /api/itglue/passwords/:id — delete
 *
 * Query/body: organizationId, itglueUserId, email, role
 * PATCH body also: name, username, password, url, notes, restricted
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "PATCH" || req.method === "PUT")
      return await handleUpdate(req, res);
    if (req.method === "DELETE") return await handleDelete(req, res);

    res.setHeader("Allow", "GET, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
      configured: isItGlueConfigured(),
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
  const orgId =
    Number.isFinite(organizationId) && organizationId > 0
      ? organizationId
      : null;
  const role = String(req.query.role ?? body.role ?? "client").toLowerCase();
  const isStaff = role === "admin" || role === "technician";
  const email = String(req.query.email ?? body.email ?? "")
    .trim()
    .toLowerCase();
  let itglueUserId: number | null = (() => {
    const raw = String(
      req.query.itglueUserId ?? body.itglueUserId ?? "",
    ).trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  return { orgId, role, isStaff, email, itglueUserId };
}

async function resolveUserId(
  itglueUserId: number | null,
  email: string,
  isStaff: boolean,
): Promise<number | null> {
  // Clients: only the explicit MyGlue number on the portal account (no email match)
  if (!isStaff) return itglueUserId;
  if (itglueUserId != null) return itglueUserId;
  if (!email || !isItGlueConfigured()) return null;
  try {
    const found = await findUsersByEmail(email);
    if (found.length === 1) return found[0].id;
  } catch {
    /* ignore */
  }
  return null;
}

function clientMissingMyGlue(isStaff: boolean, itglueUserId: number | null) {
  return !isStaff && itglueUserId == null;
}

function toDetail(p: ItGluePassword) {
  return {
    id: p.id,
    name: p.name,
    username: p.username,
    password: p.password,
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
  };
}

async function assertAccess(
  password: ItGluePassword,
  opts: {
    orgId: number | null;
    itglueUserId: number | null;
    isStaff: boolean;
  },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const allowUnscopedStaff = opts.isStaff && opts.itglueUserId == null;
  const allowed = userCanAccessPassword(password, {
    itglueUserId: opts.itglueUserId,
    organizationId: opts.orgId ?? password.organizationId,
    allowUnscopedStaff,
  });
  if (!allowed) {
    return {
      ok: false,
      status: 403,
      error:
        "This password is restricted and not shared with your MyGlue / IT Glue user.",
    };
  }
  if (
    opts.orgId != null &&
    password.organizationId != null &&
    password.organizationId !== opts.orgId
  ) {
    return {
      ok: false,
      status: 403,
      error: "Password does not belong to this client organization.",
    };
  }
  return { ok: true };
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "Missing password id" });

  const parsed = parseIdentity(req);
  const itglueUserId = await resolveUserId(
    parsed.itglueUserId,
    parsed.email,
    parsed.isStaff,
  );

  if (clientMissingMyGlue(parsed.isStaff, itglueUserId)) {
    return res.status(403).json({
      error:
        "No MyGlue user ID on this portal account. No passwords are available until an administrator links your MyGlue user number.",
      requiresMyGlueUser: true,
    });
  }

  if (!isItGlueConfigured()) {
    if (parsed.orgId == null) {
      return res
        .status(400)
        .json({ error: "Missing organizationId", mock: true });
    }
    const mock = mockPasswordsForOrg(parsed.orgId, itglueUserId).find(
      (p) => p.id === id,
    );
    if (!mock) {
      return res.status(404).json({
        error: "Password not found or not shared with this user (demo).",
        mock: true,
      });
    }
    return res.status(200).json({
      configured: false,
      mock: true,
      password: toDetail(mock),
    });
  }

  const password = await getPasswordById(id, { showPassword: true });
  if (!password) {
    return res.status(404).json({ error: "Password not found in IT Glue." });
  }

  const access = await assertAccess(password, {
    orgId: parsed.orgId,
    itglueUserId,
    isStaff: parsed.isStaff,
  });
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  return res.status(200).json({
    configured: true,
    mock: false,
    itglueUserId,
    password: toDetail(password),
  });
}

async function handleUpdate(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "Missing password id" });

  const parsed = parseIdentity(req);
  if (parsed.orgId == null) {
    return res.status(400).json({ error: "Missing organizationId" });
  }

  const body =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};

  const patch: {
    name?: string;
    username?: string | null;
    password?: string | null;
    url?: string | null;
    notes?: string | null;
    restricted?: boolean;
  } = {};

  if (body.name !== undefined) patch.name = String(body.name ?? "").trim();
  if (body.username !== undefined) {
    patch.username =
      body.username == null ? null : String(body.username).trim() || null;
  }
  if (body.password !== undefined) {
    // Empty string means "leave unchanged" on update
    const secret = String(body.password ?? "");
    if (secret.length > 0) patch.password = secret;
  }
  if (body.url !== undefined) {
    patch.url = body.url == null ? null : String(body.url).trim() || null;
  }
  if (body.notes !== undefined) {
    patch.notes =
      body.notes == null ? null : String(body.notes).trim() || null;
  }
  if (body.restricted !== undefined) {
    patch.restricted = body.restricted === true || body.restricted === "true";
  }

  if (
    patch.name === undefined &&
    patch.username === undefined &&
    patch.password === undefined &&
    patch.url === undefined &&
    patch.notes === undefined &&
    patch.restricted === undefined
  ) {
    return res.status(400).json({ error: "No fields to update." });
  }
  if (patch.name !== undefined && !patch.name) {
    return res.status(400).json({ error: "Name cannot be empty." });
  }

  const itglueUserId = await resolveUserId(
    parsed.itglueUserId,
    parsed.email,
    parsed.isStaff,
  );

  if (clientMissingMyGlue(parsed.isStaff, itglueUserId)) {
    return res.status(403).json({
      error:
        "No MyGlue user ID on this portal account. No passwords are available until an administrator links your MyGlue user number.",
      requiresMyGlueUser: true,
    });
  }

  if (!isItGlueConfigured()) {
    try {
      // Access check against current mock state
      const current = mockPasswordsForOrg(parsed.orgId, itglueUserId).find(
        (p) => p.id === id,
      );
      if (!current) {
        return res.status(404).json({
          error: "Password not found or not shared with this user (demo).",
          mock: true,
        });
      }
      const updated = mockUpdatePassword(
        id,
        parsed.orgId,
        patch,
        itglueUserId,
      );
      return res.status(200).json({
        configured: false,
        mock: true,
        password: toDetail(updated),
      });
    } catch (e) {
      return res.status(400).json({
        error: e instanceof Error ? e.message : "Failed to update password",
        mock: true,
      });
    }
  }

  // Live: load + authorize, then patch
  let current: ItGluePassword | null;
  try {
    current = await getPasswordById(id, { showPassword: false });
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : "Failed to load password",
    });
  }
  if (!current) {
    return res.status(404).json({ error: "Password not found in IT Glue." });
  }

  const access = await assertAccess(current, {
    orgId: parsed.orgId,
    itglueUserId,
    isStaff: parsed.isStaff,
  });
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  try {
    const updated = await updatePassword(id, {
      ...patch,
      organizationId: parsed.orgId,
    });
    return res.status(200).json({
      configured: true,
      mock: false,
      itglueUserId,
      password: toDetail(updated),
    });
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : "Failed to update password",
      configured: true,
    });
  }
}

async function handleDelete(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "Missing password id" });

  const parsed = parseIdentity(req);
  if (parsed.orgId == null) {
    return res.status(400).json({ error: "Missing organizationId" });
  }

  const itglueUserId = await resolveUserId(
    parsed.itglueUserId,
    parsed.email,
    parsed.isStaff,
  );

  if (clientMissingMyGlue(parsed.isStaff, itglueUserId)) {
    return res.status(403).json({
      error:
        "No MyGlue user ID on this portal account. No passwords are available until an administrator links your MyGlue user number.",
      requiresMyGlueUser: true,
    });
  }

  if (!isItGlueConfigured()) {
    try {
      const current = mockPasswordsForOrg(parsed.orgId, itglueUserId).find(
        (p) => p.id === id,
      );
      if (!current) {
        return res.status(404).json({
          error: "Password not found or not shared with this user (demo).",
          mock: true,
        });
      }
      mockDeletePassword(id, parsed.orgId, itglueUserId);
      return res.status(200).json({
        configured: false,
        mock: true,
        deleted: true,
        id,
      });
    } catch (e) {
      return res.status(400).json({
        error: e instanceof Error ? e.message : "Failed to delete password",
        mock: true,
      });
    }
  }

  let current: ItGluePassword | null;
  try {
    current = await getPasswordById(id, { showPassword: false });
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : "Failed to load password",
    });
  }
  if (!current) {
    return res.status(404).json({ error: "Password not found in IT Glue." });
  }

  const access = await assertAccess(current, {
    orgId: parsed.orgId,
    itglueUserId,
    isStaff: parsed.isStaff,
  });
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  try {
    await deletePassword(id, parsed.orgId);
    return res.status(200).json({
      configured: true,
      mock: false,
      deleted: true,
      id,
    });
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : "Failed to delete password",
      configured: true,
    });
  }
}
