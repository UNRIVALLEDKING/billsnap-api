import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  drizzle,
  type PostgresJsDatabase,
  type PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
/** What repositories accept: the pool-backed `Db` or the drizzle handle of an open transaction. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
/** A drizzle handle bound to one open transaction, plus the raw postgres.js transaction (used by the queue). */
export type Tx = { db: Executor; sql: postgres.TransactionSql };

export type Database = {
  db: Db;
  sql: postgres.Sql;
  /** Runs `fn` in a transaction: commits when it resolves, rolls back when it throws. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Cheap connectivity check for /ready. Rejects after `timeoutMs`. */
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
};

export function createDatabase(opts: { url: string; poolSize: number }): Database {
  // Note: no prepared statement caching tricks needed; direct connection, no PgBouncer (SYSTEM_DESIGN section 7).
  const sql = postgres(opts.url, { max: opts.poolSize, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    // drizzle cannot wrap a postgres.js TransactionSql directly, so open the transaction through drizzle
    // and reach for the underlying TransactionSql it holds (needed to enqueue jobs in the same transaction).
    tx: (fn) =>
      db.transaction((dtx) => {
        const raw = (dtx as unknown as { session: { client: postgres.TransactionSql } }).session
          .client;
        return fn({ db: dtx, sql: raw });
      }),
    async ping(timeoutMs = 2000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database ping timed out")), timeoutMs);
      });
      try {
        await Promise.race([sql`select 1`, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
