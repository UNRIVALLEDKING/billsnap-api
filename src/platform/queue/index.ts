import type { Tx } from "../db/client";

export type SendOptions = {
  /** Enqueue inside this transaction: the job exists only if the transaction commits. */
  tx?: Tx;
  startAfter?: Date | number;
  singletonKey?: string;
  retryLimit?: number;
  /** Seconds between retries (initial delay when `retryBackoff` is on). */
  retryDelay?: number;
  retryBackoff?: boolean;
};

export type Job<T> = { id: string; data: T };

export type WorkOptions = {
  /** Jobs handled in parallel by this process. Default 1. */
  concurrency?: number;
  pollSeconds?: number;
};

/** Job queue port. The pg-boss adapter is the only implementation; keep callers off pg-boss types. */
export interface Queue {
  send(name: string, data: object, opts?: SendOptions): Promise<string | null>;
  /** Registers a handler. Throwing fails the attempt (retried per the job's retry settings). */
  work<T extends object>(
    name: string,
    handler: (job: Job<T>) => Promise<void>,
    opts?: WorkOptions,
  ): Promise<void>;
  /** Cron (UTC) enqueue of an empty job onto the queue of the same name. */
  schedule(name: string, cron: string): Promise<void>;
  start(): Promise<void>;
  /** Stops polling and waits for in-flight handlers (graceful). */
  stop(): Promise<void>;
}
