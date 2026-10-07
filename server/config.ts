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

export const config = {
  root: ROOT,
  production,
  // Production: PORT (default 3000). Development: API_PORT (default 3001) — PORT
  // is ignored there because dev tools often set it for the web server.
  port: Number(production ? env("PORT") || 3000 : env("API_PORT") || 3001),
  publicUrl: env("PUBLIC_URL").replace(/\/+$/, ""),
  appSecret: appSecret(),
  cookieSecure: bool("COOKIE_SECURE", production),
  requireMfa: bool("REQUIRE_MFA", true),
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
