import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { businesses, users } from "../businesses/businesses.schema";

export const exportStatus = pgEnum("export_status", ["queued", "processing", "ready", "failed"]);

export const exportFormat = pgEnum("export_format", ["xlsx", "csv", "tally_xml"]);

export const createExportSchema = z.object({
  type: z.enum(["purchase", "sale", "all"]).default("all"),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
    .optional(),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
    .optional(),
  vendor_id: z.string().uuid().optional(),
  format: z.enum(["xlsx", "csv", "tally_xml"]).default("xlsx"),
});

export type CreateExportInput = z.infer<typeof createExportSchema>;
export type ExportFilters = CreateExportInput;

export const exportsTable = pgTable(
  "exports",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    format: exportFormat("format").notNull().default("xlsx"),
    status: exportStatus("status").notNull().default("queued"),
    filters: jsonb("filters").notNull().$type<ExportFilters>(),
    storageKey: text("storage_key"),
    fileBytes: integer("file_bytes"),
    billCount: integer("bill_count"),
    lineCount: integer("line_count"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("exports_business_created_idx").on(t.businessId, t.createdAt.desc())],
);

export type ExportRecord = typeof exportsTable.$inferSelect;
export type NewExportRecord = typeof exportsTable.$inferInsert;

export const exportViewSchema = z.object({
  id: z.string().uuid(),
  business_id: z.string().uuid(),
  format: z.enum(["xlsx", "csv", "tally_xml"]),
  status: z.enum(["queued", "processing", "ready", "failed"]),
  download_url: z.string().url().optional(),
  file_bytes: z.number().int().optional(),
  created_at: z.string(),
  expires_at: z.string().optional(),
});

export type ExportView = z.infer<typeof exportViewSchema>;

export function exportToView(record: ExportRecord, downloadUrl?: string): ExportView {
  return {
    id: record.id,
    business_id: record.businessId,
    format: record.format as "xlsx" | "csv" | "tally_xml",
    status: record.status as "queued" | "processing" | "ready" | "failed",
    ...(downloadUrl ? { download_url: downloadUrl } : {}),
    ...(record.fileBytes != null ? { file_bytes: record.fileBytes } : {}),
    created_at: record.createdAt.toISOString(),
    ...(record.expiresAt ? { expires_at: record.expiresAt.toISOString() } : {}),
  };
}

// Data structures for multi-sheet writers (Summary, Itemized, Vendor Spend)
export type ExportSummaryRow = {
  id: string;
  billDate: string | null;
  type: string;
  invoiceNumber: string | null;
  vendorName: string | null;
  gstin: string | null;
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  total: number;
  status: string;
};

export type ExportItemRow = {
  billDate: string | null;
  invoiceNumber: string | null;
  vendorName: string | null;
  description: string;
  hsnSac: string | null;
  quantity: number;
  unit: string;
  rate: number;
  discount: number;
  taxableValue: number;
  gstRate: number | null;
  cgst: number;
  sgst: number;
  igst: number;
  lineTotal: number;
};

export type ExportVendorSpendRow = {
  vendorName: string;
  gstin: string | null;
  totalBills: number;
  totalSpend: number;
  totalQuantity: number;
};

export type ExportDataset = {
  summary: ExportSummaryRow[];
  itemized: ExportItemRow[];
  vendorSpend: ExportVendorSpendRow[];
};
