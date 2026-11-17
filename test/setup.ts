import { afterAll } from "bun:test";
import postgres from "postgres";
import { createDatabase, type Database, type Tx } from "../src/platform/db/client";
import { runMigrations } from "../src/platform/db/migrate";
import { createStorage, type Storage } from "../src/platform/storage/r2";
import { ensureBucket } from "./ensure-bucket";

/**
 * Integration test harness (needs `docker compose -f compose.dev.yml up -d`). Preloaded for every
 * test file but lazy: pure unit tests never touch Postgres or MinIO.
 */
process.env.NODE_ENV ??= "test";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  `postgres://billdrop:billdrop@localhost:${process.env.POSTGRES_PORT ?? "54340"}/billdrop_test`;

export const S3_TEST = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? "billdrop",
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? "billdrop-dev-secret",
  R2_BUCKET: "billdrop-test",
};

async function createDatabaseIfMissing(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  target.pathname = "/postgres";
  const admin = postgres(target.toString(), { max: 1, onnotice: () => {} });
  try {
    const found = await admin`select 1 from pg_database where datname = ${name}`;
    if (found.length === 0) {
      try {
        await admin.unsafe(`create database "${name.replaceAll('"', '""')}"`);
      } catch (err) {
        if ((err as { code?: string }).code !== "42P04") throw err; // lost a creation race
      }
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

let database: Promise<Database> | undefined;

/** Shared test database: created if missing, migrated once per `bun test` run. */
export function testDatabase(): Promise<Database> {
  database ??= (async () => {
    await createDatabaseIfMissing(TEST_DATABASE_URL);
    await runMigrations(TEST_DATABASE_URL);
    return createDatabase({ url: TEST_DATABASE_URL, poolSize: 5 });
  })();
  return database;
}

class Rollback extends Error {}

/** Runs `fn` inside a transaction that is always rolled back, so tests leave no rows behind. */
export async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { tx } = await testDatabase();
  let result!: T;
  try {
    await tx(async (t) => {
      result = await fn(t);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return result;
}

let storage: Promise<Storage> | undefined;

/** Storage client for the `billdrop-test` MinIO bucket, created if missing. */
export function testStorage(): Promise<Storage> {
  storage ??= (async () => {
    await ensureBucket({
      endpoint: S3_TEST.S3_ENDPOINT,
      accessKeyId: S3_TEST.R2_ACCESS_KEY_ID,
      secretAccessKey: S3_TEST.R2_SECRET_ACCESS_KEY,
      bucket: S3_TEST.R2_BUCKET,
    });
    return createStorage(S3_TEST);
  })();
  return storage;
}

afterAll(async () => {
  if (database) await (await database).close();
});
