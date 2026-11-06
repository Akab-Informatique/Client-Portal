import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");

// Load .env (Node built-in parser); real environment variables win.
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile) && process.env.NODE_ENV !== "test") {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.error("[config] could not parse .env:", e instanceof Error ? e.message : e);
  }
}

const env = (k: string) => (process.env[k] ?? "").trim();
const bool = (k: string, dflt: boolean) => {
  const v = env(k).toLowerCase();
  if (!v) return dflt;
  return v === "1" || v === "true" || v === "yes";
};

const production = env("NODE_ENV") === "production";
const isPlaceholder = (v: string) => !v || /^change-?me/i.test(v);

/**
 * APP_SECRET seals MFA secrets at rest. Production: required, ≥ 32 chars.
 * Development: generated once into .data/dev-secret (never committed).
 */
function appSecret(): string {
  const v = env("APP_SECRET");
  if (!isPlaceholder(v) && v.length >= 32) return v;
  if (production) {
    throw new Error("APP_SECRET is missing, too short or still the example value — generate one: openssl rand -hex 32");
  }
  const file = path.join(ROOT, ".data", "dev-secret");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(file, "utf8").trim();
}

function dbConfig() {
  const url = env("DATABASE_URL");
  const host = env("POSTGRES_HOST");
  if (url || host) {
    const password = env("POSTGRES_PASSWORD");
    if (production && !url && isPlaceholder(password)) {
      throw new Error("POSTGRES_PASSWORD is missing or still the example value");
    }
    return {
      kind: "postgres" as const,
      connection: url
        ? { connectionString: url }
        : {
            host,
            port: Number(env("POSTGRES_PORT") || 5432),
            database: env("POSTGRES_DB") || "akab",
            user: env("POSTGRES_USER") || "akab",
            password,
          },
      pgliteDir: "",
    };
  }
  if (production) throw new Error("Production requires PostgreSQL (POSTGRES_HOST or DATABASE_URL)");
  return {
    kind: "pglite" as const,
    connection: {},
    pgliteDir: path.resolve(ROOT, env("PGLITE_DIR") || ".data/pglite"),
  };
}

/**
 * The only other sites allowed to show the portal inside a frame (EMBED_ORIGINS,
 * separated by commas or spaces). Each must be an exact origin — https://host or
 * https://host:port, no path, no wildcard; http only for localhost outside
 * production. Anything else is ignored with a warning, so a typo can never open
 * the portal to every site. Empty = nobody (only the portal's own pages).
 */
export function parseEmbedOrigins(raw: string, prod: boolean): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    let ok = false;
    try {
      const u = new URL(part);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      ok = (u.protocol === "https:" || (u.protocol === "http:" && local && !prod)) && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash && !part.includes("*");
      if (ok) out.add(u.origin);
    } catch {
      /* not a URL */
    }
    if (!ok) console.warn(`[config] EMBED_ORIGINS: "${part}" ignored (an exact https origin is needed, e.g. https://imago.example.com)`);
  }
  return [...out];
}
const embedOrigins = parseEmbedOrigins(env("EMBED_ORIGINS"), production);
const cookieSecure = bool("COOKIE_SECURE", production);

export const config = {
  root: ROOT,
  production,
  // Production: PORT (default 3000). Development: API_PORT (default 3001) — PORT
  // is ignored there because dev tools often set it for the web server.
  port: Number(production ? env("PORT") || 3000 : env("API_PORT") || 3001),
  publicUrl: env("PUBLIC_URL").replace(/\/+$/, ""),
  appSecret: appSecret(),
  cookieSecure,
  embedOrigins,
  // Only when the embedding site is on another site (another registrable domain): the session cookie must then
  // travel inside the frame (SameSite=None; Secure; Partitioned). Off by default; needs HTTPS and EMBED_ORIGINS.
  embedCrossSiteCookie: bool("EMBED_CROSS_SITE_COOKIE", false) && embedOrigins.length > 0 && cookieSecure,
  // Sécurité › Passbolt is a spike: on in development and tests, off in production unless PASSBOLT_SPIKE=true
  passboltEnabled: bool("PASSBOLT_SPIKE", !production),
  // MFA: always on in production by default; off for local development
  // (set REQUIRE_MFA=true locally to test the authenticator flow).
  requireMfa: bool("REQUIRE_MFA", production),
  trustedProxies: env("TRUSTED_PROXY_IPS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  db: dbConfig(),
  bootstrap: {
    email: env("ADMIN_EMAIL").toLowerCase(),
    password: env("ADMIN_PASSWORD"),
    name: env("ADMIN_NAME") || "Administrateur AKAB",
  },
  smtp: {
    host: env("SMTP_HOST"),
    port: Number(env("SMTP_PORT") || 587),
    secure: bool("SMTP_SECURE", false),
    user: env("SMTP_USER"),
    pass: env("SMTP_PASS"),
    from: env("SMTP_FROM") || env("SMTP_USER"),
    fromName: env("SMTP_FROM_NAME") || "AKAB Informatique",
  },
  seedDemo: bool("SEED_DEMO", !production),
};

export type Config = typeof config;
