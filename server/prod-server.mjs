/**
 * AKAB Portal — production Node server (self-host)
 *
 * Serves the Vite build from /dist and mounts /api/* handlers from /api
 * (same Vercel-style req/res shape used in development).
 *
 * Usage:
 *   npm run build
 *   npm start
 *
 * Env: copy .env.example → .env (or inject via your process manager).
 */

import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const apiDir = path.join(root, "api");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

// ---------------------------------------------------------------------------
// Load .env without $ expansion (Autotask secrets often contain $ and #)
//
// Docker Compose may inject env_file values AFTER expanding $VAR inside them
// (depending on Compose version / quoting). That corrupts AUTOTASK_SECRET and
// causes permanent 401s after every upgrade rebuild.
//
// Fix: mount .env into the container and re-read secrets here WITHOUT expansion.
// For secret-like keys the file ALWAYS wins over whatever Compose injected.
// ---------------------------------------------------------------------------
const FILE_WINS_ENV =
  /^(AUTOTASK_|MICROSOFT_|ITGLUE_|SMTP_|GITHUB_|SESSION_|OPENAI_|ANTHROPIC_|SPLASHTOP_|COOKIE_|DATTO_)/i;

function loadEnvFileNoExpand(filePath, { secretsWin = true } = {}) {
  if (!fs.existsSync(filePath)) return 0;
  let loaded = 0;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1);
    // Peel one matching quote layer (single preferred for secrets)
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    const isSecret = FILE_WINS_ENV.test(key);
    if (process.env[key] === undefined || (secretsWin && isSecret)) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return loaded;
}

const envCandidates = [
  path.join(root, ".env"),
  path.join(root, ".env.local"),
  path.join(root, ".env.production"),
  path.join(root, ".env.production.local"),
  // Compose may mount the host file here explicitly
  "/run/akab/env",
];
let envFilesLoaded = 0;
for (const p of envCandidates) {
  envFilesLoaded += loadEnvFileNoExpand(p, { secretsWin: true });
}
if (envFilesLoaded > 0) {
  console.log(
    `[akab-env] loaded ${envFilesLoaded} key(s) from .env without $ expansion (secrets win over Compose)`,
  );
}

// ---------------------------------------------------------------------------
// Register tsx ONCE so we can import api/**/*.ts at runtime
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
let tsxReady = false;
async function ensureTsx() {
  if (tsxReady) return;
  try {
    require("tsx/cjs");
  } catch {
    /* optional */
  }
  try {
    const { register } = await import("tsx/esm/api");
    register();
  } catch {
    /* may already be preloaded via: node --import tsx */
  }
  tsxReady = true;
}

// Cache compiled handlers — NEVER bust cache with ?t= (that re-transpiles every
// request and hangs the portal under load / on slow VPS disks).
const handlerCache = new Map();

async function importTs(filePath) {
  const hit = handlerCache.get(filePath);
  if (hit) return hit;
  await ensureTsx();
  const pending = import(pathToFileURL(filePath).href)
    .then((mod) => {
      handlerCache.set(filePath, mod);
      return mod;
    })
    .catch((err) => {
      handlerCache.delete(filePath);
      throw err;
    });
  handlerCache.set(filePath, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Native health / db-ping (NO TypeScript import) — always answers fast
// ---------------------------------------------------------------------------
function envClean(v) {
  if (!v) return "";
  let s = String(v).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  return s;
}

function nativePgConfig() {
  const host = envClean(process.env.POSTGRES_HOST);
  const database =
    envClean(process.env.POSTGRES_DB) || envClean(process.env.POSTGRES_DATABASE);
  const user = envClean(process.env.POSTGRES_USER);
  const password = envClean(process.env.POSTGRES_PASSWORD);
  if (host && database && user) {
    return {
      host,
      port: Number(envClean(process.env.POSTGRES_PORT) || "5432") || 5432,
      database,
      user,
      password,
      passwordSet: Boolean(password),
      source: "postgres_env",
    };
  }
  return null;
}

async function nativeDbPing(timeoutMs = 4000) {
  const cfg = nativePgConfig();
  if (!cfg) {
    return {
      ok: false,
      configured: false,
      error: "POSTGRES_* not set",
    };
  }
  if (!cfg.passwordSet) {
    return {
      ok: false,
      configured: true,
      host: cfg.host,
      database: cfg.database,
      user: cfg.user,
      passwordSet: false,
      error: "POSTGRES_PASSWORD is empty",
    };
  }

  let pg;
  try {
    pg = (await import("pg")).default;
  } catch (err) {
    return {
      ok: false,
      configured: true,
      error: `pg module missing: ${err instanceof Error ? err.message : err}`,
    };
  }

  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
  });

  const started = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      (async () => {
        await client.connect();
        const r = await client.query(
          `SELECT current_database() AS database, current_user AS user,
                  (SELECT COUNT(*)::int FROM information_schema.tables
                    WHERE table_schema='public' AND table_name='users') AS has_users`,
        );
        const row = r.rows[0] || {};
        let userCount = null;
        if (Number(row.has_users) > 0) {
          const c = await client.query(`SELECT COUNT(*)::int AS n FROM users`);
          userCount = Number(c.rows[0]?.n ?? 0);
        }
        return {
          ok: true,
          configured: true,
          host: cfg.host,
          database: row.database || cfg.database,
          user: row.user || cfg.user,
          passwordSet: true,
          userCount,
          latencyMs: Date.now() - started,
          source: cfg.source,
        };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`native DB ping timed out after ${timeoutMs}ms`)),
          timeoutMs + 500,
        );
      }),
    ]);
    return result;
  } catch (err) {
    return {
      ok: false,
      configured: true,
      host: cfg.host,
      database: cfg.database,
      user: cfg.user,
      passwordSet: true,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      source: cfg.source,
    };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

/** Fast paths that never import TypeScript handlers. */
async function handleNativeApi(req, res, url) {
  const p = url.pathname.replace(/\/$/, "") || "/";

  if (p === "/api/health" && (req.method === "GET" || req.method === "HEAD")) {
    const checkDb =
      url.searchParams.get("db") === "1" ||
      String(url.searchParams.get("db") || "").toLowerCase() === "true";
    const cfg = nativePgConfig();
    // Public liveness — no host/user/password diagnostics
    const base = {
      ok: true,
      service: "akab-portal",
      postgresConfigured: Boolean(cfg),
      ts: new Date().toISOString(),
      native: true,
    };
    if (!checkDb) {
      sendJson(res, 200, base);
      return true;
    }
    const ping = await nativeDbPing(4000);
    sendJson(res, ping.ok ? 200 : 503, {
      ...base,
      ok: ping.ok,
      postgresOk: ping.ok,
      userCount: ping.userCount ?? null,
      latencyMs: ping.latencyMs ?? null,
      error: ping.ok ? null : "Database unavailable",
    });
    return true;
  }

  // Ultra-fast DB readiness for browser boot — no migrations, no tsx
  if (
    (p === "/api/db/ping" || p === "/api/db/status") &&
    (req.method === "GET" || req.method === "HEAD")
  ) {
    // Only use native path when migrate is NOT requested
    const wantMigrate =
      url.searchParams.get("migrate") === "1" ||
      String(url.searchParams.get("migrate") || "").toLowerCase() === "true";

    if (!wantMigrate || p === "/api/db/ping") {
      const cfg = nativePgConfig();
      if (!cfg) {
        sendJson(res, 200, {
          mode: "none",
          configured: false,
          ok: false,
          error: "Database not configured",
          native: true,
        });
        return true;
      }
      const ping = await nativeDbPing(4000);
      // Public boot payload — no host/user/passwordSet
      sendJson(res, 200, {
        mode: "postgres",
        configured: true,
        ok: Boolean(ping.ok),
        userCount: ping.userCount ?? null,
        latencyMs: ping.latencyMs ?? null,
        error: ping.ok ? null : "Database unavailable",
        native: true,
      });
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// API route resolution (mirrors vite-plugins/appbuilder-api-dev-server.ts)
// ---------------------------------------------------------------------------
function resolveApiHandler(rel) {
  const exact = [
    path.join(apiDir, `${rel}.ts`),
    path.join(apiDir, rel, "index.ts"),
    path.join(apiDir, `${rel}.js`),
  ];
  for (const f of exact) {
    if (fs.existsSync(f)) return { file: f, params: {} };
  }
  const parts = rel.split("/").filter(Boolean);
  return walkDynamic(apiDir, parts, {});
}

function walkDynamic(dir, parts, params) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  if (parts.length === 0) {
    const indexTs = path.join(dir, "index.ts");
    if (fs.existsSync(indexTs)) return { file: indexTs, params };
    return null;
  }
  const [head, ...rest] = parts;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  if (rest.length === 0) {
    const exactFile = entries.find(
      (e) => e.isFile() && (e.name === `${head}.ts` || e.name === `${head}.js`),
    );
    if (exactFile) return { file: path.join(dir, exactFile.name), params };
  }

  const exactDir = entries.find((e) => e.isDirectory() && e.name === head);
  if (exactDir) {
    const hit = walkDynamic(path.join(dir, exactDir.name), rest, params);
    if (hit) return hit;
  }

  if (rest.length === 0) {
    const dynFile = entries.find(
      (e) => e.isFile() && /^\[[^\]]+\]\.(ts|js)$/.test(e.name),
    );
    if (dynFile) {
      const m = dynFile.name.match(/^\[([^\]]+)\]\.(ts|js)$/);
      if (m) {
        return {
          file: path.join(dir, dynFile.name),
          params: { ...params, [m[1]]: head },
        };
      }
    }
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(/^\[([^\]]+)\]$/);
    if (!m) continue;
    const hit = walkDynamic(path.join(dir, e.name), rest, {
      ...params,
      [m[1]]: head,
    });
    if (hit) return hit;
  }
  return null;
}

function createVercelRes(res) {
  let statusCode = 200;
  const api = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(c) {
      statusCode = c;
      res.statusCode = c;
    },
    status(code) {
      statusCode = code;
      res.statusCode = code;
      return api;
    },
    setHeader(name, value) {
      res.setHeader(name, value);
      return api;
    },
    getHeader(name) {
      return res.getHeader(name);
    },
    json(data) {
      if (!res.getHeader("Content-Type")) {
        res.setHeader("Content-Type", "application/json");
      }
      res.statusCode = statusCode;
      res.end(JSON.stringify(data));
      return api;
    },
    send(data) {
      res.statusCode = statusCode;
      // Binary payloads (PDF, files): never JSON-stringify Buffers/TypedArrays
      if (
        Buffer.isBuffer(data) ||
        data instanceof Uint8Array ||
        (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer)
      ) {
        const buf = Buffer.isBuffer(data)
          ? data
          : Buffer.from(
              data instanceof ArrayBuffer ? new Uint8Array(data) : data,
            );
        if (!res.getHeader("Content-Type")) {
          res.setHeader("Content-Type", "application/octet-stream");
        }
        if (!res.getHeader("Content-Length")) {
          res.setHeader("Content-Length", String(buf.byteLength));
        }
        res.end(buf);
      } else if (typeof data === "object" && data !== null) {
        if (!res.getHeader("Content-Type")) {
          res.setHeader("Content-Type", "application/json");
        }
        res.end(JSON.stringify(data));
      } else {
        res.end(data == null ? "" : String(data));
      }
      return api;
    },
    end(data) {
      res.statusCode = statusCode;
      if (
        Buffer.isBuffer(data) ||
        data instanceof Uint8Array ||
        (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer)
      ) {
        const buf = Buffer.isBuffer(data)
          ? data
          : Buffer.from(
              data instanceof ArrayBuffer ? new Uint8Array(data) : data,
            );
        res.end(buf);
      } else if (typeof data === "object" && data !== null) {
        if (!res.getHeader("Content-Type")) {
          res.setHeader("Content-Type", "application/json");
        }
        res.end(JSON.stringify(data));
      } else {
        res.end(data);
      }
      return api;
    },
    write(chunk) {
      if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } else {
        res.write(chunk);
      }
      return api;
    },
    writeHead(code, headers) {
      statusCode = code;
      res.writeHead(code, headers);
      return api;
    },
  };
  return api;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
  };
  return map[ext] || "application/octet-stream";
}

function safeJoin(base, reqPath) {
  const decoded = decodeURIComponent(reqPath.split("?")[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(base, cleaned);
  if (!full.startsWith(base)) return null;
  return full;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function handleApi(req, res, url) {
  const rel = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  const resolved = resolveApiHandler(rel);
  if (!resolved) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "API route not found" }));
    return;
  }

  const body = ["GET", "HEAD"].includes(req.method || "GET")
    ? undefined
    : await readBody(req);

  const query = {};
  url.searchParams.forEach((value, key) => {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  });
  for (const [k, v] of Object.entries(resolved.params)) {
    if (query[k] === undefined) query[k] = v;
  }

  const vercelReq = Object.assign(req, {
    query,
    body,
    cookies: {},
  });
  const vercelRes = createVercelRes(res);

  try {
    const mod = await importTs(resolved.file);
    const handler = mod.default;
    if (typeof handler !== "function") {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "API handler has no default export" }));
      return;
    }
    await handler(vercelReq, vercelRes);
  } catch (err) {
    if (res.headersSent) return;
    console.error("[api]", url.pathname, err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: err instanceof Error ? err.message : "API handler error",
      }),
    );
  }
}

function handleStatic(req, res, url) {
  if (!fs.existsSync(distDir)) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Build missing. Run: npm run build");
    return;
  }

  let filePath = safeJoin(distDir, url.pathname === "/" ? "/index.html" : url.pathname);
  if (!filePath) {
    res.statusCode = 400;
    res.end("Bad path");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback
    filePath = path.join(distDir, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const stat = fs.statSync(filePath);
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType(filePath));
  res.setHeader("Content-Length", stat.size);
  if (url.pathname.startsWith("/assets/")) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else if (filePath.endsWith("index.html")) {
    res.setHeader("Cache-Control", "no-cache");
  }
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      // Native health/ping first — never depends on tsx or migrations.
      // Without this, a stuck tsx import makes Docker HEALTHCHECK fail and
      // the browser shows "/api/db/status timed out. App container may be down."
      try {
        const nativeHandled = await handleNativeApi(req, res, url);
        if (nativeHandled) return;
      } catch (nativeErr) {
        console.error("[api-native]", url.pathname, nativeErr);
        if (!res.headersSent) {
          sendJson(res, 200, {
            ok: false,
            error:
              nativeErr instanceof Error
                ? nativeErr.message
                : "Native API handler error",
            native: true,
          });
          return;
        }
      }
      await handleApi(req, res, url);
      return;
    }
    handleStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AKAB Portal listening on http://${HOST}:${PORT}`);
  console.log(`  static: ${distDir}`);
  console.log(`  api:    ${apiDir}`);
  console.log(`  node:   ${process.version}`);

  // Non-blocking Autotask env sanity (never logs secret value)
  try {
    const ic = String(process.env.AUTOTASK_INTEGRATION_CODE || "").trim();
    const un = String(process.env.AUTOTASK_USERNAME || "").trim();
    const sec = String(process.env.AUTOTASK_SECRET || "").trim();
    if (!ic || !un || !sec) {
      console.log(
        "  autotask: NOT configured (set AUTOTASK_INTEGRATION_CODE / USERNAME / SECRET in .env)",
      );
    } else {
      console.log(
        `  autotask: configured — usernameLen=${un.length} secretLen=${sec.length}` +
          (/@/.test(un) ? " usernameLooksLikeEmail=true" : "") +
          (sec.includes("$") ? " secretHas$=true" : "") +
          (sec.includes("#") ? " secretHas#=true" : ""),
      );
    }
  } catch {
    /* ignore */
  }

  // Listen first; migrate in background so /api/health never blocks on DB
  import(pathToFileURL(path.join(apiDir, "_lib/pg.ts")).href)
    .then(async (mod) => {
      const summary = mod.getDbConfigSummary?.() || {};
      if (!mod.isPostgresConfigured?.()) {
        console.log(
          "  db:     NOT configured — set POSTGRES_PASSWORD in .env (Compose sets HOST=db)",
        );
        return;
      }
      console.log(
        `  db:     host=${summary.host} port=${summary.port} db=${summary.database} user=${summary.user} passwordSet=${summary.passwordSet} source=${summary.source}`,
      );
      try {
        const ping = await mod.pingDatabase();
        if (!ping?.ok) {
          console.error("  db:     PING FAILED:", ping?.error || "unknown");
          console.error(
            "  db:     Fix POSTGRES_PASSWORD (must match existing volume) or check: docker compose logs db",
          );
          return;
        }
        console.log(`  db:     ping ok — database=${ping.database}`);
        await mod.runMigrations();
        const boot = await mod.ensureBootstrap();
        const status = await mod.getDbStatus();
        console.log(
          `  db:     READY — ${status.database || "db"} @ ${status.host || "host"}` +
            (status.userCount != null ? ` — users=${status.userCount}` : "") +
            (boot?.seeded ? " — seeded admin@akab.local" : ""),
        );
      } catch (err) {
        console.error(
          "  db:     FAILED:",
          err instanceof Error ? err.message : err,
        );
      }
    })
    .catch((err) => {
      console.error(
        "  db:     module load failed:",
        err instanceof Error ? err.message : err,
      );
    });
});
