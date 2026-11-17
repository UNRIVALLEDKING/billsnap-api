import { EXTRACT_JOB } from "./modules/bills/bills.service";
import {
  BILL_EXPORT_JOB,
  createExportHandler,
  EXPORT_JOB,
  type ExportJobData,
} from "./modules/exports";
import {
  createExtractHandler,
  type ExtractDeps,
  type ExtractJobData,
} from "./modules/extraction/extract.job";
import type { Logger } from "./platform/logger";
import type { Queue } from "./platform/queue";

export type WorkerDeps = Omit<ExtractDeps, "log"> & { concurrency: number };

/** Worker role: starts the queue (pg-boss) and registers job handlers. */
export async function startWorker(
  log: Logger,
  queue: Queue,
  deps: WorkerDeps,
): Promise<{ stop: () => Promise<void> }> {
  await queue.start();
  const { concurrency, ...extractDeps } = deps;
  await queue.work<ExtractJobData>(EXTRACT_JOB, createExtractHandler({ ...extractDeps, log }), {
    concurrency,
  });
  await queue.work<ExportJobData>(
    EXPORT_JOB,
    createExportHandler({
      database: deps.database,
      storage: deps.storage,
      queue,
      logger: log,
    }),
    { concurrency: 2 },
  );
  await queue.work<ExportJobData>(
    BILL_EXPORT_JOB,
    createExportHandler({
      database: deps.database,
      storage: deps.storage,
      queue,
      logger: log,
    }),
    { concurrency: 2 },
  );
  log.info(
    { concurrency, model: deps.model, ai: deps.ai ? deps.ai.name : "disabled" },
    "worker started",
  );
  return {
    stop: async () => {
      await queue.stop();
      log.info("worker stopped");
    },
  };
}
