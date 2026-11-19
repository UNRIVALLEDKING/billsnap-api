import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env";
import { errorHandler } from "../../http/middleware/error-handler";
import type { Database } from "../../platform/db/client";
import type { Queue } from "../../platform/queue";
import type { Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { exportsRoutes } from "./exports.routes";
import { type ExportDataset, exportToView } from "./exports.schema";
import type { ExportsDeps } from "./exports.service";
import {
  generateCsv,
  generateCsvZip,
  generateItemizedCsv,
  generateSummaryCsv,
  generateVendorSpendCsv,
  UTF8_BOM,
} from "./writers/csv.writer";
import { sanitizeCellValue, sanitizeFormula } from "./writers/sanitizer";
import { generateXlsx } from "./writers/xlsx.writer";

type Json = Record<string, unknown>;
const j = (r: Response) => r.json() as Promise<Json>;

describe("Formula Injection Protection (SEC-10)", () => {
  test("prepends single quote to dangerous spreadsheet formula prefixes", () => {
    expect(sanitizeFormula("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
    expect(sanitizeFormula("+12345")).toBe("'+12345");
    expect(sanitizeFormula("-ITEM-CODE")).toBe("'-ITEM-CODE");
    expect(sanitizeFormula("@IMPORTXML(A1)")).toBe("'@IMPORTXML(A1)");
    expect(sanitizeFormula("   =1+1")).toBe("'   =1+1");
    expect(sanitizeFormula("  +919876543210")).toBe("'  +919876543210");
  });

  test("leaves safe strings and numbers unmodified", () => {
    expect(sanitizeFormula("INV-2026-001")).toBe("INV-2026-001");
    expect(sanitizeFormula("Tata Tea Gold 500g")).toBe("Tata Tea Gold 500g");
    expect(sanitizeFormula("")).toBe("");
    expect(sanitizeCellValue(1250.5)).toBe(1250.5);
    expect(sanitizeCellValue(true)).toBe(true);
    expect(sanitizeCellValue(null)).toBe(null);
  });
});

describe("Streaming Multi-sheet Excel Writer (xlsx.writer.ts)", () => {
  const sampleDataset: ExportDataset = {
    summary: [
      {
        id: "b-001",
        billDate: "2026-04-10",
        type: "Purchase",
        invoiceNumber: "INV-101",
        vendorName: "Krishna Provisions",
        gstin: "27AAPFU0939F1ZV",
        subtotal: 1000,
        cgst: 90,
        sgst: 90,
        igst: 0,
        cess: 0,
        total: 1180,
        status: "confirmed",
      },
      {
        id: "b-002",
        billDate: "2026-04-12",
        type: "Purchase",
        invoiceNumber: "=DANGEROUS-INV",
        vendorName: "+Malhotra Spices",
        gstin: "27AAACR5055K1Z7",
        subtotal: 500,
        cgst: 25,
        sgst: 25,
        igst: 0,
        cess: 0,
        total: 550,
        status: "confirmed",
      },
    ],
    itemized: [
      {
        billDate: "2026-04-10",
        invoiceNumber: "INV-101",
        vendorName: "Krishna Provisions",
        description: "Basmati Rice 25kg",
        hsnSac: "1006",
        quantity: 2,
        unit: "bag",
        rate: 500,
        discount: 0,
        taxableValue: 1000,
        gstRate: 18,
        cgst: 90,
        sgst: 90,
        igst: 0,
        lineTotal: 1180,
      },
      {
        billDate: "2026-04-12",
        invoiceNumber: "=DANGEROUS-INV",
        vendorName: "+Malhotra Spices",
        description: "@Special Chilli Powder",
        hsnSac: "0904",
        quantity: 5,
        unit: "kg",
        rate: 100,
        discount: 0,
        taxableValue: 500,
        gstRate: 10,
        cgst: 25,
        sgst: 25,
        igst: 0,
        lineTotal: 550,
      },
    ],
    vendorSpend: [
      {
        vendorName: "Krishna Provisions",
        gstin: "27AAPFU0939F1ZV",
        totalBills: 1,
        totalSpend: 1180,
        totalQuantity: 2,
      },
      {
        vendorName: "+Malhotra Spices",
        gstin: "27AAACR5055K1Z7",
        totalBills: 1,
        totalSpend: 550,
        totalQuantity: 5,
      },
    ],
  };

  test("generates 3 sheets with frozen top row, bold headers, and formula sanitization", async () => {
    const buffer = await generateXlsx(sampleDataset);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheetNames = workbook.worksheets.map((w) => w.name);
    expect(sheetNames).toEqual(["Summary", "Itemized", "Vendor Spend"]);

    // Verify Sheet 1: Summary
    const summary = workbook.getWorksheet("Summary");
    expect(summary).toBeDefined();
    expect(summary?.views?.[0]?.state).toBe("frozen");
    expect((summary?.views?.[0] as { ySplit?: number })?.ySplit).toBe(1);
    expect(summary?.getRow(1).font?.bold).toBe(true);

    // Verify formula sanitization on Sheet 1 row 3 (=DANGEROUS-INV -> '=DANGEROUS-INV)
    const row3Invoice = summary?.getRow(3).getCell(4).value;
    expect(row3Invoice).toBe("'=DANGEROUS-INV");
    const row3Vendor = summary?.getRow(3).getCell(5).value;
    expect(row3Vendor).toBe("'+Malhotra Spices");

    // Verify Sheet 2: Itemized
    const itemized = workbook.getWorksheet("Itemized");
    expect(itemized).toBeDefined();
    expect(itemized?.views?.[0]?.state).toBe("frozen");
    expect((itemized?.views?.[0] as { ySplit?: number })?.ySplit).toBe(1);
    expect(itemized?.getRow(1).font?.bold).toBe(true);
    expect(itemized?.getRow(3).getCell(4).value).toBe("'@Special Chilli Powder");

    // Verify Sheet 3: Vendor Spend
    const vendorSpend = workbook.getWorksheet("Vendor Spend");
    expect(vendorSpend).toBeDefined();
    expect(vendorSpend?.views?.[0]?.state).toBe("frozen");
    expect((vendorSpend?.views?.[0] as { ySplit?: number })?.ySplit).toBe(1);
    expect(vendorSpend?.getRow(1).font?.bold).toBe(true);
  });

  test("mathematical reconciliation: Sheet 1 Total equals sum of Sheet 2 Line Totals", async () => {
    const buffer = await generateXlsx(sampleDataset);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const summary = workbook.getWorksheet("Summary");
    const itemized = workbook.getWorksheet("Itemized");

    // Summary totals row is row 4 (1 header + 2 data + 1 total)
    const summaryTotalCell = summary?.getRow(4).getCell(16).value;
    // Itemized totals row is row 4 (1 header + 2 data + 1 total)
    const itemizedTotalCell = itemized?.getRow(4).getCell(15).value;

    expect(summaryTotalCell).toBe(1730);
    expect(itemizedTotalCell).toBe(1730);
    expect(summaryTotalCell).toBe(itemizedTotalCell);
  });
});

describe("CSV Writer & Zip Bundle (csv.writer.ts)", () => {
  const sampleDataset: ExportDataset = {
    summary: [
      {
        id: "bill-001",
        billDate: "2026-04-15",
        type: "Purchase",
        invoiceNumber: "=CALC-001",
        vendorName: "Mumbai Trading Co., Ltd.",
        gstin: "27AAPFU0939F1ZV",
        subtotal: 2000,
        cgst: 180,
        sgst: 180,
        igst: 0,
        cess: 0,
        total: 2360,
        status: "confirmed",
      },
    ],
    itemized: [
      {
        billDate: "2026-04-15",
        invoiceNumber: "=CALC-001",
        vendorName: "Mumbai Trading Co., Ltd.",
        description: "Premium Flour, 10kg",
        hsnSac: "1101",
        quantity: 4,
        unit: "bag",
        rate: 500,
        discount: 0,
        taxableValue: 2000,
        gstRate: 18,
        cgst: 180,
        sgst: 180,
        igst: 0,
        lineTotal: 2360,
      },
    ],
    vendorSpend: [
      {
        vendorName: "Mumbai Trading Co., Ltd.",
        gstin: "27AAPFU0939F1ZV",
        totalBills: 1,
        totalSpend: 2360,
        totalQuantity: 4,
      },
    ],
  };

  test("Summary.csv starts with UTF-8 BOM and sanitizes formulas", () => {
    const csv = generateSummaryCsv(sampleDataset);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    // Formula trigger sanitization: =CALC-001 must become '=CALC-001
    expect(csv).toContain("'=CALC-001");
    // Escaped commas in vendor name
    expect(csv).toContain('"Mumbai Trading Co., Ltd."');
    // Contains total row at bottom
    expect(csv).toContain(
      "Total,,,,,,2000.00,180.00,180.00,0.00,0.00,0.00,0.00,0.00,0.00,2360.00,",
    );
  });

  test("Itemized.csv starts with UTF-8 BOM and includes line totals", () => {
    const csv = generateItemizedCsv(sampleDataset);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toContain("2360.00");
    expect(csv).toContain('"Premium Flour, 10kg"');
  });

  test("Vendor_Spend.csv starts with UTF-8 BOM and sums aggregates", () => {
    const csv = generateVendorSpendCsv(sampleDataset);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toContain("2360.00");
    expect(csv).toContain("4.000");
  });

  test("generateCsvZip bundles all CSVs into a valid zip archive", async () => {
    const zipBuffer = await generateCsvZip(sampleDataset);
    expect(zipBuffer).toBeInstanceOf(Buffer);
    expect(zipBuffer.length).toBeGreaterThan(100);
    // Zip magic bytes: PK\x03\x04
    expect(zipBuffer[0]).toBe(0x50);
    expect(zipBuffer[1]).toBe(0x4b);
    expect(zipBuffer[2]).toBe(0x03);
    expect(zipBuffer[3]).toBe(0x04);
  });

  test("generateCsv returns summary csv", () => {
    const single = generateCsv(sampleDataset);
    expect(single.startsWith(UTF8_BOM)).toBe(true);
    expect(single).toContain("Bill ID,Date,Type");
  });
});

describe("Exports Routes & Service Integration", () => {
  const businessId = newId();
  const userId = newId();

  const store = new Map<string, { body: Uint8Array; contentType?: string | undefined }>();
  const mockStorage = {
    async putObject(
      key: string,
      body: string | Uint8Array | ArrayBuffer | Blob | ReadableStream,
      contentType?: string,
    ) {
      let bytes: Uint8Array;
      if (typeof body === "string") bytes = new TextEncoder().encode(body);
      else if (body instanceof Uint8Array) bytes = body;
      else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
      else if (body instanceof Blob) bytes = new Uint8Array(await body.arrayBuffer());
      else {
        const res = new Response(body);
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      store.set(key, { body: bytes, contentType });
    },
    async getObject(key: string) {
      const item = store.get(key);
      if (!item) throw new Error(`object not found: ${key}`);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(item.body);
          controller.close();
        },
      });
    },
    async headObject(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return {
        size: item.body.length,
        contentType: item.contentType ?? "application/octet-stream",
        etag: "etag-mock",
        lastModified: new Date(),
      };
    },
    presignGet(key: string, ttlSeconds: number) {
      return `https://r2.billdrop.test/${key}?expires=${ttlSeconds}`;
    },
    async deletePrefix() {
      return 0;
    },
  };

  const records = new Map<string, Record<string, unknown>>();
  let queryResult: unknown[] = [];

  const mockDb = {
    insert() {
      return {
        values(row: Record<string, unknown>) {
          return {
            returning() {
              const full: Record<string, unknown> = {
                ...row,
                fileBytes: null,
                billCount: null,
                lineCount: null,
                error: null,
                storageKey: null,
                createdAt: new Date(),
                completedAt: null,
                expiresAt: null,
              };
              records.set(String(full.id), full);
              return [full];
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where() {
              const res = queryResult;
              return Object.assign(Promise.resolve(res), {
                orderBy() {
                  return {
                    limit(n: number) {
                      return Array.from(records.values()).slice(0, n);
                    },
                  };
                },
              });
            },
          };
        },
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  return [];
                },
              };
            },
          };
        },
      };
    },
  };

  const mockQueue = {
    send: async () => "job-id",
    work: async () => {},
    schedule: async () => {},
    start: async () => {},
    stop: async () => {},
  };

  const mockDeps: ExportsDeps = {
    database: {
      db: mockDb as unknown as Database["db"],
      sql: {} as unknown as Database["sql"],
      ping: async () => {},
      close: async () => {},
      tx: async (fn: (tx: { db: Database["db"]; sql: Database["sql"] }) => Promise<unknown>) =>
        fn({ db: mockDb as unknown as Database["db"], sql: {} as unknown as Database["sql"] }),
    } as unknown as Database,
    storage: mockStorage as unknown as Storage,
    queue: mockQueue as unknown as Queue,
  };

  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  // Simulate auth & business context middleware
  app.use("*", async (c, next) => {
    c.set("business", {
      id: businessId,
      role: "owner",
    });
    c.set("user", {
      id: userId,
    });
    await next();
  });
  app.route("/v1/exports", exportsRoutes(mockDeps));

  test("POST /v1/exports creates an export job and returns 202 accepted", async () => {
    // Inject a manually prepared ready record for testing download
    const exportId = newId();
    const storageKey = `b/${businessId}/exports/${exportId}.xlsx`;
    await mockStorage.putObject(
      storageKey,
      Buffer.from("mock-xlsx-data"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    const record = {
      id: exportId,
      businessId,
      requestedBy: userId,
      format: "xlsx",
      status: "ready",
      filters: { type: "all", format: "xlsx" },
      storageKey,
      fileBytes: 14,
      billCount: 2,
      lineCount: 4,
      error: null,
      createdAt: new Date(),
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86400000),
    };
    records.set(exportId, record);

    const res = await app.request("/v1/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "all",
        format: "xlsx",
      }),
    });

    expect(res.status).toBe(202);
    const body = await j(res);
    expect(body.format).toBe("xlsx");
    expect(body.status).toBeDefined();
    expect(body.business_id).toBe(businessId);
  });

  test("POST /v1/exports validates input format and dates", async () => {
    const res = await app.request("/v1/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "invalid_type",
        format: "unsupported_fmt",
      }),
    });
    // Validation failure returns 422
    expect(res.status).toBe(422);
  });

  test("GET /v1/exports/:id returns export status with presigned download URL", async () => {
    const exportId = newId();
    const storageKey = `b/${businessId}/exports/${exportId}.xlsx`;
    await mockStorage.putObject(
      storageKey,
      Buffer.from("dummy-xlsx"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    records.set(exportId, {
      id: exportId,
      businessId,
      requestedBy: userId,
      format: "xlsx",
      status: "ready",
      filters: { type: "all", format: "xlsx" },
      storageKey,
      fileBytes: 10,
      createdAt: new Date(),
      completedAt: new Date(),
      expiresAt: new Date(),
    });

    // Provide mock select query resolution for this id
    queryResult = [records.get(exportId)];

    const res = await app.request(`/v1/exports/${exportId}`);
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.id).toBe(exportId);
    expect(body.status).toBe("ready");
    expect(String(body.download_url)).toContain(`b/${businessId}/exports/${exportId}.xlsx`);
  });

  test("GET /v1/exports/:id/download streams file with Content-Disposition", async () => {
    const exportId = newId();
    const storageKey = `b/${businessId}/exports/${exportId}.xlsx`;
    await mockStorage.putObject(
      storageKey,
      Buffer.from("sample-xlsx-stream"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    records.set(exportId, {
      id: exportId,
      businessId,
      requestedBy: userId,
      format: "xlsx",
      status: "ready",
      filters: { type: "all", format: "xlsx" },
      storageKey,
      fileBytes: 18,
      createdAt: new Date(),
      completedAt: new Date(),
      expiresAt: new Date(),
    });

    queryResult = [records.get(exportId)];

    const res = await app.request(`/v1/exports/${exportId}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain(`export-${exportId.slice(0, 8)}.xlsx`);
    const text = await res.text();
    expect(text).toBe("sample-xlsx-stream");
  });

  test("GET /v1/exports/:id/download with ?redirect=true returns 302 redirect", async () => {
    const exportId = newId();
    const storageKey = `b/${businessId}/exports/${exportId}.csv`;
    await mockStorage.putObject(storageKey, Buffer.from("sample-csv"), "text/csv");

    records.set(exportId, {
      id: exportId,
      businessId,
      requestedBy: userId,
      format: "csv",
      status: "ready",
      filters: { type: "all", format: "csv" },
      storageKey,
      fileBytes: 10,
      createdAt: new Date(),
      completedAt: new Date(),
      expiresAt: new Date(),
    });

    queryResult = [records.get(exportId)];

    const res = await app.request(`/v1/exports/${exportId}/download?redirect=true`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(String(res.headers.get("location"))).toContain(
      `b/${businessId}/exports/${exportId}.csv`,
    );
  });

  test("GET /v1/exports lists recent exports", async () => {
    const res = await app.request("/v1/exports?limit=10");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(Array.isArray(body.items)).toBe(true);
    expect((body.items as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  test("GET /v1/exports/:id returns 404 for invalid UUID or unknown id", async () => {
    const invalidRes = await app.request("/v1/exports/not-a-uuid");
    expect(invalidRes.status).toBe(404);

    queryResult = [];

    const unknownRes = await app.request(`/v1/exports/${newId()}`);
    expect(unknownRes.status).toBe(404);
  });

  test("GET /v1/exports/:id/download returns 400 when export is not ready", async () => {
    const pendingId = newId();
    records.set(pendingId, {
      id: pendingId,
      businessId,
      requestedBy: userId,
      format: "xlsx",
      status: "queued",
      filters: { type: "all", format: "xlsx" },
      storageKey: null,
      fileBytes: null,
      createdAt: new Date(),
      completedAt: null,
      expiresAt: null,
    });

    queryResult = [records.get(pendingId)];

    const res = await app.request(`/v1/exports/${pendingId}/download`);
    expect(res.status).toBe(400);
  });

  test("POST /v1/exports accepts tally_xml format and GET download streams application/xml", async () => {
    const exportId = newId();
    const storageKey = `b/${businessId}/exports/${exportId}.xml`;
    await mockStorage.putObject(
      storageKey,
      Buffer.from("<ENVELOPE></ENVELOPE>"),
      "application/xml",
    );

    records.set(exportId, {
      id: exportId,
      businessId,
      requestedBy: userId,
      format: "tally_xml",
      status: "ready",
      filters: { type: "all", format: "tally_xml" },
      storageKey,
      fileBytes: 21,
      createdAt: new Date(),
      completedAt: new Date(),
      expiresAt: new Date(),
    });

    queryResult = [records.get(exportId)];

    const createRes = await app.request("/v1/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "all",
        format: "tally_xml",
      }),
    });

    expect(createRes.status).toBe(202);
    const createBody = await j(createRes);
    expect(createBody.format).toBe("tally_xml");

    const dlRes = await app.request(`/v1/exports/${exportId}/download`);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("content-type")).toContain("application/xml");
    expect(dlRes.headers.get("content-disposition")).toContain(`.xml"`);
  });

  test("exportToView converts record correctly with and without download_url", () => {
    const now = new Date();
    const rec = {
      id: "exp-1",
      businessId: "biz-1",
      requestedBy: "user-1",
      format: "xlsx" as const,
      status: "ready" as const,
      filters: { type: "all" as const, format: "xlsx" as const },
      storageKey: "key-1",
      fileBytes: 500,
      billCount: 1,
      lineCount: 2,
      error: null,
      createdAt: now,
      completedAt: now,
      expiresAt: now,
    };
    const v = exportToView(rec, "https://download.url");
    expect(v.id).toBe("exp-1");
    expect(v.download_url).toBe("https://download.url");
    expect(v.file_bytes).toBe(500);

    const vNoUrl = exportToView(rec);
    expect(vNoUrl.download_url).toBeUndefined();
  });
});
