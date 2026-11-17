// Extraction links bill lines to the business's stock items by name (docs/STOCK_WASTAGE_PLAN.md phase 2).
// Runs the real extract handler against Postgres with a stub AI and an in-memory file store.
import { beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { testDatabase } from "../../../test/setup";
import type { AiExtractResult, AiProvider } from "../../platform/ai";
import type { Database } from "../../platform/db/client";
import { createLogger } from "../../platform/logger";
import type { Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { billFiles, billLineItems, bills } from "../bills/bills.schema";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { createMasterProduct } from "../inventory/inventory.service";
import { createExtractHandler } from "./extract.job";

let database: Database;
let businessId: string;
let userId: string;

beforeAll(async () => {
  database = await testDatabase();
  userId = newId();
  businessId = newId();
  await database.db
    .insert(users)
    .values({ id: userId, name: "Auto link", email: `autolink-${userId}@test.local` });
  await database.db
    .insert(businesses)
    .values({ id: businessId, name: "Auto Link Business", createdBy: userId });
  await database.db.insert(memberships).values({ businessId, userId, role: "owner" });
});

const stubAi = (output: unknown): AiProvider => ({
  name: "stub",
  async extractBill(): Promise<AiExtractResult> {
    return { output, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
  },
});

const storage = {
  async getObject() {
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])).body;
  },
} as unknown as Storage;

describe("extraction auto-link", () => {
  test("links unambiguous lines, flags them, and leaves the rest alone", async () => {
    const tomato = await createMasterProduct(database.db, {
      businessId,
      displayName: "Tomato (Desi)",
      standardUnit: "kg",
    });
    await createMasterProduct(database.db, {
      businessId,
      displayName: "Apple (Shimla)",
      standardUnit: "kg",
    });
    await createMasterProduct(database.db, {
      businessId,
      displayName: "Apple (Green)",
      standardUnit: "kg",
    });
    const billId = newId();
    await database.db.insert(bills).values({
      id: billId,
      businessId,
      clientRef: newId(),
      type: "purchase",
      status: "queued",
      source: "camera",
      uploadedBy: userId,
      droppedAt: new Date(),
    });
    await database.db.insert(billFiles).values({
      id: newId(),
      businessId,
      billId,
      position: 0,
      storageKey: `test/${billId}`,
      mimeType: "image/jpeg",
      bytes: 7,
      sha256: newId(),
    });

    const line = (description: string) => ({
      description,
      quantity: "10",
      unit: "kg",
      rate: "20",
      amount: "200",
    });
    const handler = createExtractHandler({
      database,
      storage,
      ai: stubAi({
        is_bill: true,
        counterparty: { name: "Auto Link Vendor", gstin: null },
        invoice_number: "AL-1",
        date_iso: "2026-11-01",
        line_items: [line("TAMATAR"), line("Apple"), line("Hammer")],
        grand_total: "600",
      }),
      model: "stub-model",
      fallbackModel: "stub-fallback",
      log: createLogger({ level: "silent" }),
      retryDelayMs: 0,
    });
    await handler({ id: "job", data: { billId, businessId } });

    const lines = await database.db
      .select({
        desc: billLineItems.descriptionRaw,
        master: billLineItems.masterProductId,
        flags: billLineItems.flags,
      })
      .from(billLineItems)
      .where(eq(billLineItems.billId, billId))
      .orderBy(asc(billLineItems.position));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ master: tomato.id });
    expect(lines[0]?.flags).toContain("stock_auto_linked");
    // "Apple" fits two items equally, "Hammer" fits none: both stay unlinked and unflagged
    expect(lines[1]?.master).toBeNull();
    expect(lines[1]?.flags).not.toContain("stock_auto_linked");
    expect(lines[2]?.master).toBeNull();
    expect(lines[2]?.flags).not.toContain("stock_auto_linked");
  });
});
