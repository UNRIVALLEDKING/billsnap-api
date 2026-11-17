import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import journal from "../../../drizzle/meta/_journal.json";
import { TEST_DATABASE_URL, testDatabase, withRollback } from "../../../test/setup";
import { runMigrations } from "./migrate";

describe("database (integration)", () => {
  test("extensions from migration 0000 are installed", async () => {
    const { sql: pg } = await testDatabase();
    const rows =
      await pg`select extname from pg_extension where extname in ('pg_trgm','citext','pg_stat_statements')`;
    expect(rows.map((r) => r.extname).sort()).toEqual(["citext", "pg_stat_statements", "pg_trgm"]);
  });

  test("withRollback leaves nothing behind", async () => {
    await withRollback(async ({ db }) => {
      await db.execute(sql`create table rollback_probe (id int)`);
      await db.execute(sql`insert into rollback_probe values (1)`);
    });
    const { sql: pg } = await testDatabase();
    const [row] = await pg`select to_regclass('public.rollback_probe') as t`;
    expect(row?.t).toBeNull();
  });

  test("tx commits on success and rolls back on throw", async () => {
    const database = await testDatabase();
    await database.sql`create table if not exists tx_probe (id int)`;
    await database.sql`truncate tx_probe`;
    await database.tx(async ({ sql: t }) => {
      await t`insert into tx_probe values (1)`;
    });
    await database
      .tx(async ({ sql: t }) => {
        await t`insert into tx_probe values (2)`;
        throw new Error("boom");
      })
      .catch(() => {});
    const rows = await database.sql`select id from tx_probe`;
    expect(rows.map((r) => r.id)).toEqual([1]);
    await database.sql`drop table tx_probe`;
  });

  test("migrations are idempotent and safe to run concurrently on a fresh database", async () => {
    const name = `billdrop_mig_${Date.now()}`;
    const admin = postgres(TEST_DATABASE_URL, { max: 1 });
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    try {
      await admin.unsafe(`create database ${name}`);
      await Promise.all([
        runMigrations(url.toString()),
        runMigrations(url.toString()),
        runMigrations(url.toString()),
      ]);
      await runMigrations(url.toString());
      const fresh = postgres(url.toString(), { max: 1 });
      const applied = await fresh`select count(*)::int as n from drizzle.__drizzle_migrations`;
      await fresh.end();
      expect(applied[0]?.n).toBe(journal.entries.length);
    } finally {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    }
  });
});
