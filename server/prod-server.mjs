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
// Load .env without $ expansion (Autotask secrets often contain $)
// ---------------------------------------------------------------------------
function loadEnvFileNoExpand(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFileNoExpand(path.join(root, ".env"));
loadEnvFileNoExpand(path.join(root, ".env.local"));
loadEnvFileNoExpand(path.join(root, ".env.production"));
loadEnvFileNoExpand(path.join(root, ".env.production.local"));

// ---------------------------------------------------------------------------
// Register tsx so we can import api/**/*.ts at runtime
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
try {
  require("tsx/cjs");
} catch {
  console.warn(
    "[akab] Optional tip: install tsx for TypeScript API routes (npm i tsx).",
  );
}

// Dynamic import of .ts via tsx loader (Node 18+)
async function importTs(filePath) {
  // Prefer tsx register path
  try {
    const { register } = await import("tsx/esm/api");
    register();
  } catch {
    /* tsx may already be preloaded via NODE_OPTIONS */
  }
  return import(pathToFileURL(filePath).href + `?t=${Date.now()}`);
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
      if (typeof data === "object" && data !== null) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
      } else {
        res.end(data == null ? "" : String(data));
      }
      return api;
    },
    end(data) {
      res.statusCode = statusCode;
      res.end(data);
      return api;
    },
    write(chunk) {
      res.write(chunk);
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
  console.log(`AKAB Portal v1 listening on http://${HOST}:${PORT}`);
  console.log(`  static: ${distDir}`);
  console.log(`  api:    ${apiDir}`);

  // Apply additive PostgreSQL migrations on boot (no-op without DATABASE_URL)
  import(pathToFileURL(path.join(apiDir, "_lib/pg.ts")).href)
    .then(async (mod) => {
      if (!mod.isPostgresConfigured?.()) {
        console.log(
          "  db:     PGlite fallback (set DATABASE_URL for durable Postgres)",
        );
        return;
      }
      try {
        await mod.runMigrations();
        const status = await mod.getDbStatus();
        console.log(
          `  db:     PostgreSQL ok — ${status.database || "db"} @ ${status.host || "host"}`,
        );
      } catch (err) {
        console.error(
          "  db:     PostgreSQL migration/connect FAILED:",
          err instanceof Error ? err.message : err,
        );
      }
    })
    .catch((err) => {
      console.warn(
        "  db:     could not load pg module:",
        err instanceof Error ? err.message : err,
      );
    });
});
