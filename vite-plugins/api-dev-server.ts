import fs from "fs";
import path from "path";
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "http";

/**
 * Parse a .env file WITHOUT variable expansion.
 * Vite's loadEnv uses dotenv-expand, which treats `$...` inside values
 * (common in Autotask secrets) as variable references and silently truncates them.
 */
function loadEnvFileNoExpand(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    // Strip surrounding quotes only (do NOT expand $VARS)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Unescape common sequences inside double quotes
    value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    out[key] = value;
  }
  return out;
}

/** Keys where the on-disk .env must beat a stale/empty process.env injection. */
const FILE_WINS_PREFIXES = [
  "AUTOTASK_",
  "SPLASHTOP_",
  "MICROSOFT_",
  "ITGLUE_",
  "SMTP_",
  "SESSION_",
];

function injectEnvFromFiles(root: string) {
  // Later files override earlier ones (same idea as Vite)
  const files = [".env", ".env.local", ".env.development", ".env.development.local"];
  for (const name of files) {
    const parsed = loadEnvFileNoExpand(path.join(root, name));
    for (const [key, value] of Object.entries(parsed)) {
      // Prefer file values for integration secrets so a truncated / placeholder
      // process.env entry (Compose, platform inject) cannot win over .env.
      const fileWins = FILE_WINS_PREFIXES.some((p) => key.startsWith(p));
      if (fileWins || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Mounts /api/* handlers from the api/ folder during Vite dev,
 * matching Vercel serverless function shape (req, res).
 * Loads .env into process.env so API routes can read secrets.
 */
export function apiDevServer(): Plugin {
  return {
    name: "akab-api-dev-server",
    configureServer(server) {
      const root = server.config.root || process.cwd();
      injectEnvFromFiles(root);

      server.middlewares.use(async (req, res, next) => {
        try {
          if (!req.url || !req.method) return next();
          const url = new URL(req.url, "http://localhost");
          if (!url.pathname.startsWith("/api/")) return next();

          // Re-inject on each request so secret updates apply without full restart
          injectEnvFromFiles(root);

          // Map /api/foo/bar -> api/foo/bar.ts, including Vercel dynamic [id] segments
          const rel = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
          const resolved = resolveApiHandler(root, rel);
          if (!resolved) return next();
          const { file, params: routeParams } = resolved;

          // Collect body
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            req.on("data", (c) => chunks.push(Buffer.from(c)));
            req.on("end", () => resolve());
            req.on("error", reject);
          });
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: unknown = undefined;
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              body = raw;
            }
          }

          const query: Record<string, string | string[]> = {};
          url.searchParams.forEach((value, key) => {
            const existing = query[key];
            if (existing === undefined) query[key] = value;
            else if (Array.isArray(existing)) existing.push(value);
            else query[key] = [existing, value];
          });
          // Merge dynamic path params (e.g. id from /tickets/123)
          for (const [k, v] of Object.entries(routeParams)) {
            if (query[k] === undefined) query[k] = v;
          }

          const vercelReq = Object.assign(req, {
            query,
            body,
            cookies: {},
          }) as IncomingMessage & {
            query: Record<string, string | string[]>;
            body: unknown;
            cookies: Record<string, string>;
          };

          const vercelRes = createVercelRes(res);

          // Same auth gate as production (server/prod-server.mjs)
          const gate = await server.ssrLoadModule(
            path.join(root, "api", "_lib", "api-gate.ts"),
          );
          const verdict = await gate.gateApiRequest(vercelReq, rel);
          if (!verdict.ok) {
            res.statusCode = verdict.status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: verdict.error }));
            return;
          }
          (vercelReq as unknown as { auth: unknown }).auth = verdict.auth;
          gate.wrapStatusResponse(rel, verdict.auth, vercelRes);

          // Bust cache so edits hot-reload
          const mod = await server.ssrLoadModule(file + "?t=" + Date.now());
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
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : "API middleware error",
            }),
          );
        }
      });
    },
  };
}

/**
 * Resolve an API path to a handler file, supporting Vercel dynamic
 * segments: [id].ts, [id]/notes.ts, etc.
 */
function resolveApiHandler(
  root: string,
  rel: string,
): { file: string; params: Record<string, string> } | null {
  const exact = [
    path.join(root, "api", `${rel}.ts`),
    path.join(root, "api", rel, "index.ts"),
    path.join(root, "api", `${rel}.js`),
  ];
  for (const f of exact) {
    if (fs.existsSync(f)) return { file: f, params: {} };
  }

  const parts = rel.split("/").filter(Boolean);
  const match = walkDynamic(path.join(root, "api"), parts, {});
  return match;
}

function walkDynamic(
  dir: string,
  parts: string[],
  params: Record<string, string>,
): { file: string; params: Record<string, string> } | null {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;

  if (parts.length === 0) {
    const indexTs = path.join(dir, "index.ts");
    if (fs.existsSync(indexTs)) return { file: indexTs, params };
    return null;
  }

  const [head, ...rest] = parts;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  // 1) Exact file match for remaining single segment: notes.ts
  if (rest.length === 0) {
    const exactFile = entries.find(
      (e) => e.isFile() && (e.name === `${head}.ts` || e.name === `${head}.js`),
    );
    if (exactFile) {
      return { file: path.join(dir, exactFile.name), params };
    }
  }

  // 2) Exact directory match
  const exactDir = entries.find((e) => e.isDirectory() && e.name === head);
  if (exactDir) {
    const hit = walkDynamic(path.join(dir, exactDir.name), rest, params);
    if (hit) return hit;
  }

  // 3) Dynamic file: [id].ts when this is the last segment
  if (rest.length === 0) {
    const dynFile = entries.find(
      (e) =>
        e.isFile() &&
        /^\[[^\]]+\]\.(ts|js)$/.test(e.name),
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

  // 4) Dynamic directory: [id]/
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

  // 5) Nested resource file under dynamic dir already consumed — handled by recursion.
  // Also support flat "action" files next to [id] folder? Vercel uses [id]/action.ts
  // which is a FILE named like that only when using the odd pattern; our structure
  // is api/autotask/tickets/[id]/notes.ts → directory [id] + notes.ts (covered).

  return null;
}

function createVercelRes(res: ServerResponse) {
  let statusCode = 200;
  const api = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(c: number) {
      statusCode = c;
      res.statusCode = c;
    },
    status(code: number) {
      statusCode = code;
      res.statusCode = code;
      return api;
    },
    setHeader(name: string, value: string | number | string[]) {
      res.setHeader(name, value);
      return api;
    },
    getHeader(name: string) {
      return res.getHeader(name);
    },
    json(data: unknown) {
      if (!res.getHeader("Content-Type")) {
        res.setHeader("Content-Type", "application/json");
      }
      res.statusCode = statusCode;
      res.end(JSON.stringify(data));
      return api;
    },
    send(data: unknown) {
      res.statusCode = statusCode;
      // Binary payloads (PDF, files): never JSON-stringify Buffers/TypedArrays
      if (
        Buffer.isBuffer(data) ||
        data instanceof Uint8Array ||
        data instanceof ArrayBuffer
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
    end(data?: unknown) {
      res.statusCode = statusCode;
      if (
        Buffer.isBuffer(data) ||
        data instanceof Uint8Array ||
        data instanceof ArrayBuffer
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
        res.end(data as string | undefined);
      }
      return api;
    },
    write(chunk: unknown) {
      if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } else {
        res.write(chunk as string);
      }
      return api;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      statusCode = code;
      res.writeHead(code, headers);
      return api;
    },
  };
  return api;
}
