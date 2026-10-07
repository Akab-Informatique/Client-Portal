import path from "node:path";
import fs from "node:fs";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import * as schema from "./schema.ts";
import { config } from "../config.ts";

export type DB = NodePgDatabase<typeof schema>;

const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle");

let current: DB | null = null;
let closeFn: (() => Promise<void>) | null = null;

/**
 * PostgreSQL when DATABASE_URL / POSTGRES_HOST is set (production, Docker);
 * otherwise embedded PGlite on disk (local development) or in memory (tests).
 * Runs pending migrations from ./drizzle on every start.
 */
export async function initDb(opts: { memory?: boolean } = {}): Promise<DB> {
  if (current) return current;
  if (config.db.kind === "postgres" && !opts.memory) {
    const pool = new pg.Pool({ ...config.db.connection, max: 10 });
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder: MIGRATIONS });
    current = db;
    closeFn = () => pool.end();
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    let client;
    if (opts.memory) {
      client = new PGlite();
    } else {
      fs.mkdirSync(config.db.pgliteDir, { recursive: true });
      lockPglite(config.db.pgliteDir);
      client = new PGlite(config.db.pgliteDir);
    }
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder: MIGRATIONS });
    current = db as unknown as DB;
    closeFn = () => client.close();
  }
  return current;
}

/**
 * PGlite is single-process: two servers opening the same folder corrupt it.
 * Refuse to start when another live process holds the lock.
 */
function lockPglite(dir: string) {
  const lock = `${dir}.lock`;
  try {
    const pid = Number(fs.readFileSync(lock, "utf8").trim());
    if (pid && pid !== process.pid && isAlive(pid)) {
      console.error(
        `\n[db] The local database (${dir}) is already used by another portal server (pid ${pid}).\n` +
          `[db] Stop it first (close the other "npm run dev"), then start again.\n`,
      );
      process.exit(1);
    }
  } catch {
    /* no lock yet */
  }
  fs.writeFileSync(lock, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(lock, "utf8").trim() === String(process.pid)) fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  };
  process.once("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => process.exit(0));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function db(): DB {
  if (!current) throw new Error("Database not initialised — call initDb() first");
  return current;
}

export async function closeDb(): Promise<void> {
  await closeFn?.();
  current = null;
  closeFn = null;
}

export { schema };
