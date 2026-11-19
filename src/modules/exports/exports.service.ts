import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Database } from "../../platform/db/client";
import { badRequest, notFound } from "../../platform/errors";
import type { Logger } from "../../platform/logger";
import type { Queue } from "../../platform/queue";
import { keys, type Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { billLineItems, bills } from "../bills/bills.schema";
import { businesses } from "../businesses/businesses.schema";
import { vendors } from "../catalog/catalog.schema";
import { EXPORT_JOB } from "./export.job";
import { buildExportDataset, buildTallyBills } from "./exports.dataset";
import {
  type CreateExportInput,
  type ExportDataset,
  type ExportRecord,
  exportsTable,
} from "./exports.schema";
import { generateCsv } from "./writers/csv.writer";
import { generateTallyXml, type TallyBill } from "./writers/tally.writer";
import { generateXlsx } from "./writers/xlsx.writer";

export type ExportsDeps = {
  database: Database;
  storage: Storage;
  queue?: Queue;
  logger?: Logger;
};

/**
 * Creates an export record and enqueues background processing or processes synchronously.
 */
export async function createExport(
  deps: ExportsDeps,
  businessId: string,
  userId: string,
  input: CreateExportInput,
  options?: { sync?: boolean },
): Promise<{ record: ExportRecord; downloadUrl?: string | undefined }> {
  const exportId = newId();

  const newExport: typeof exportsTable.$inferInsert = {
    id: exportId,
    businessId,
    requestedBy: userId,
    format: input.format,
    status: "queued",
    filters: input,
  };

  const [inserted] = await deps.database.db.insert(exportsTable).values(newExport).returning();

  if (!inserted) {
    throw new Error("Failed to insert export record");
  }

  // If sync is requested or no queue is available, process synchronously.
  // Otherwise enqueue to pg-boss background worker.
  const runSync = options?.sync ?? !deps.queue;

  if (runSync) {
    const ready = await processExport(deps, exportId);
    const downloadUrl = ready.storageKey
      ? deps.storage.presignGet(ready.storageKey, 300)
      : undefined;
    return { record: ready, downloadUrl };
  }

  if (deps.queue) {
    await deps.queue.send(EXPORT_JOB, { exportId, businessId });
  }

  return { record: inserted };
}

/**
 * Fetches matching confirmed bills, line items, and generates export bytes.
 * Uploads result to Cloudflare R2 and updates export record to "ready".
 */
export async function processExport(deps: ExportsDeps, exportId: string): Promise<ExportRecord> {
  const [record] = await deps.database.db
    .select()
    .from(exportsTable)
    .where(eq(exportsTable.id, exportId));

  if (!record) {
    throw notFound("Export not found");
  }

  if (record.status === "ready") {
    return record;
  }

  await deps.database.db
    .update(exportsTable)
    .set({ status: "processing" })
    .where(eq(exportsTable.id, exportId));

  try {
    const { filters, businessId } = record;

    // Build conditions for confirmed bills matching export filters
    const conditions = [eq(bills.businessId, businessId), eq(bills.status, "confirmed")];

    if (filters.type === "purchase") {
      conditions.push(eq(bills.type, "purchase"));
    } else if (filters.type === "sale") {
      conditions.push(eq(bills.type, "sale"));
    }

    if (filters.from_date) {
      conditions.push(gte(bills.billDate, filters.from_date));
    }
    if (filters.to_date) {
      conditions.push(lte(bills.billDate, filters.to_date));
    }
    if (filters.vendor_id) {
      conditions.push(eq(bills.vendorId, filters.vendor_id));
    }

    const matchingBills = await deps.database.db
      .select()
      .from(bills)
      .where(and(...conditions))
      .orderBy(desc(bills.billDate), desc(bills.createdAt));

    // Resolve vendor names
    const vendorIds = [
      ...new Set(matchingBills.map((b) => b.vendorId).filter((id): id is string => Boolean(id))),
    ];

    const vendorMap = new Map<string, { name: string; gstin: string | null }>();
    if (vendorIds.length > 0) {
      const vendorRows = await deps.database.db
        .select({ id: vendors.id, name: vendors.displayName, gstin: vendors.gstin })
        .from(vendors)
        .where(inArray(vendors.id, vendorIds));
      for (const v of vendorRows) {
        vendorMap.set(v.id, { name: v.name, gstin: v.gstin });
      }
    }

    // Fetch line items for matching bills
    const billIds = matchingBills.map((b) => b.id);
    const lineItemRows =
      billIds.length > 0
        ? await deps.database.db
            .select()
            .from(billLineItems)
            .where(
              and(eq(billLineItems.businessId, businessId), inArray(billLineItems.billId, billIds)),
            )
            .orderBy(asc(billLineItems.position))
        : [];

    // Earlier bills that credit lines point at ("Less from earlier bills"), for their invoice numbers.
    const refIds = [
      ...new Set(
        lineItemRows.flatMap((l) =>
          l.lineKind === "credit" && l.creditRefBillId ? [l.creditRefBillId] : [],
        ),
      ),
    ];
    const refInvoices = new Map<string, string | null>();
    if (refIds.length > 0) {
      const refRows = await deps.database.db
        .select({ id: bills.id, invoiceNumber: bills.invoiceNumber })
        .from(bills)
        .where(and(eq(bills.businessId, businessId), inArray(bills.id, refIds)));
      for (const r of refRows) refInvoices.set(r.id, r.invoiceNumber);
    }

    const dataset: ExportDataset = buildExportDataset({
      bills: matchingBills,
      lines: lineItemRows,
      vendors: vendorMap,
      refInvoices,
    });
    const summaryRows = dataset.summary;
    const itemizedRows = dataset.itemized;
    // Generate output file
    let fileBuffer: Buffer | Uint8Array;
    let contentType: string;

    if (record.format === "xlsx") {
      fileBuffer = await generateXlsx(dataset);
      contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else if (record.format === "tally_xml") {
      const [biz] = await deps.database.db
        .select({ name: businesses.name })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      const companyName = biz?.name ?? "Company";

      const tallyBills: TallyBill[] = buildTallyBills({
        bills: matchingBills,
        lines: lineItemRows,
        vendors: vendorMap,
        refInvoices,
      });

      const xmlOutput = generateTallyXml({
        companyName,
        bills: tallyBills,
      });

      fileBuffer = Buffer.from(xmlOutput, "utf-8");
      contentType = "application/xml";
    } else {
      fileBuffer = Buffer.from(generateCsv(dataset), "utf-8");
      contentType = "text/csv; charset=utf-8";
    }

    const ext = record.format === "tally_xml" ? "xml" : record.format;
    const storageKey = keys.export(record.businessId, record.id, ext);
    await deps.storage.putObject(storageKey, fileBuffer, contentType);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [updated] = await deps.database.db
      .update(exportsTable)
      .set({
        status: "ready",
        storageKey,
        fileBytes: fileBuffer.length,
        billCount: summaryRows.length,
        lineCount: itemizedRows.length,
        completedAt: new Date(),
        expiresAt,
      })
      .where(eq(exportsTable.id, exportId))
      .returning();

    if (!updated) {
      throw new Error("Failed to update export record to ready");
    }

    return updated;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (deps.logger) {
      deps.logger.error({ err, exportId }, "export generation failed");
    }
    await deps.database.db
      .update(exportsTable)
      .set({
        status: "failed",
        error: errorMsg,
        completedAt: new Date(),
      })
      .where(eq(exportsTable.id, exportId));
    throw err;
  }
}

/**
 * Retrieves an export by ID for a business.
 */
export async function getExport(
  deps: ExportsDeps,
  businessId: string,
  id: string,
): Promise<{ record: ExportRecord; downloadUrl?: string | undefined }> {
  const [record] = await deps.database.db
    .select()
    .from(exportsTable)
    .where(and(eq(exportsTable.id, id), eq(exportsTable.businessId, businessId)));

  if (!record) {
    throw notFound("Export not found");
  }

  const downloadUrl =
    record.status === "ready" && record.storageKey
      ? deps.storage.presignGet(record.storageKey, 300)
      : undefined;

  return { record, downloadUrl };
}

/**
 * Lists recent exports for a business.
 */
export async function listExports(
  deps: ExportsDeps,
  businessId: string,
  limit = 20,
): Promise<ExportRecord[]> {
  return await deps.database.db
    .select()
    .from(exportsTable)
    .where(eq(exportsTable.businessId, businessId))
    .orderBy(desc(exportsTable.createdAt))
    .limit(limit);
}

/**
 * Retrieves the downloadable stream for an export.
 */
export async function getExportDownload(
  deps: ExportsDeps,
  businessId: string,
  id: string,
): Promise<{
  record: ExportRecord;
  downloadUrl: string;
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  filename: string;
}> {
  const { record, downloadUrl } = await getExport(deps, businessId, id);
  if (record.status !== "ready" || !record.storageKey || !downloadUrl) {
    throw badRequest("Export is not ready for download");
  }

  const stream = await deps.storage.getObject(record.storageKey);
  const ext = record.format === "xlsx" ? "xlsx" : record.format === "tally_xml" ? "xml" : "csv";
  const contentType =
    record.format === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : record.format === "tally_xml"
        ? "application/xml"
        : "text/csv; charset=utf-8";
  const filename = `export-${record.id.slice(0, 8)}.${ext}`;

  return { record, downloadUrl, stream, contentType, filename };
}
