import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Arbitrary constant shared by every migrate process ("billdrop" as hex).
const LOCK_KEY = "7091318301069045616";
const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../drizzle");

/** Applies pending migrations. A session advisory lock serialises concurrent runs; late arrivals find nothing to do. */
export async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 3, onnotice: () => {} });
  try {
    const lock = await sql.reserve();
    try {
      await lock`select pg_advisory_lock(${LOCK_KEY}::bigint)`;
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await lock`select pg_advisory_unlock(${LOCK_KEY}::bigint)`.catch(() => {});
      lock.release();
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  try {
    await runMigrations(url);
    console.log("migrations up to date");
  } catch (err) {
    console.error("migration failed:", err);
    process.exit(1);
  }
}
