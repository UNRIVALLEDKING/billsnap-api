import type { Job } from "../../platform/queue";
import { type ExportsDeps, processExport } from "./exports.service";

export const EXPORT_JOB = "export.generate";
export const BILL_EXPORT_JOB = "bill.export";

export type ExportJobData = {
  exportId: string;
  businessId?: string;
};

/**
 * Creates the pg-boss job handler for asynchronous export generation.
 */
export function createExportHandler(deps: ExportsDeps) {
  return async (job: Job<ExportJobData>): Promise<void> => {
    const { exportId } = job.data;
    if (deps.logger) {
      deps.logger.info({ exportId, jobId: job.id }, "processing export job");
    }
    await processExport(deps, exportId);
  };
}
