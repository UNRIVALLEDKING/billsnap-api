import { type SendOptions as BossSendOptions, type ConstructorOptions, PgBoss } from "pg-boss";
import type { Tx } from "../db/client";
import type { Logger } from "../logger";
import type { Job, Queue, SendOptions, WorkOptions } from "./index";

const DAY = 24 * 60 * 60;
/** SYSTEM_DESIGN section 8: completed jobs are deleted after 1 day. pg-boss 12 has no separate archive table. */
const QUEUE_DEFAULTS = { deleteAfterSeconds: DAY, retentionSeconds: 7 * DAY };

/** Lets pg-boss run its statements on an open postgres.js transaction. */
function txAdapter(tx: Tx): NonNullable<ConstructorOptions["db"]> {
  return {
    async executeSql(text, values) {
      const rows = await tx.sql.unsafe(text, (values ?? []) as never[]);
      return { rows: [...rows] };
    },
  };
}

export function createPgBossQueue(opts: {
  url: string;
  log: Logger;
  /** pg-boss's own pool (SYSTEM_DESIGN section 7: 4). */
  poolSize?: number;
}): Queue {
  const boss = new PgBoss({ connectionString: opts.url, max: opts.poolSize ?? 4 });
  boss.on("error", (err) => opts.log.error({ err }, "pg-boss error"));
  const known = new Set<string>();

  async function ensureQueue(name: string): Promise<void> {
    if (known.has(name)) return;
    await boss.createQueue(name, QUEUE_DEFAULTS);
    known.add(name);
  }

  return {
    async send(name, data, o: SendOptions = {}) {
      await ensureQueue(name);
      const sendOpts: BossSendOptions = {};
      if (o.tx) sendOpts.db = txAdapter(o.tx);
      if (o.startAfter !== undefined) {
        sendOpts.startAfter = o.startAfter instanceof Date ? o.startAfter : new Date(o.startAfter);
      }
      if (o.singletonKey !== undefined) sendOpts.singletonKey = o.singletonKey;
      if (o.retryLimit !== undefined) sendOpts.retryLimit = o.retryLimit;
      if (o.retryDelay !== undefined) sendOpts.retryDelay = o.retryDelay;
      if (o.retryBackoff !== undefined) sendOpts.retryBackoff = o.retryBackoff;
      return boss.send(name, data, sendOpts);
    },

    async work<T extends object>(
      name: string,
      handler: (job: Job<T>) => Promise<void>,
      o: WorkOptions = {},
    ) {
      await ensureQueue(name);
      await boss.work<T>(
        name,
        {
          localConcurrency: o.concurrency ?? 1,
          ...(o.pollSeconds !== undefined && { pollingIntervalSeconds: o.pollSeconds }),
        },
        async (jobs) => {
          for (const job of jobs) await handler({ id: job.id, data: job.data });
        },
      );
    },

    async schedule(name, cron) {
      await ensureQueue(name);
      await boss.schedule(name, cron);
    },

    async start() {
      await boss.start();
    },

    async stop() {
      await boss.stop({ graceful: true, timeout: 25_000 });
    },
  };
}
