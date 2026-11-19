import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { testDatabase, testStorage } from "../../../test/setup";
import { createApp } from "../../app";
import type { Database } from "../../platform/db/client";
import { createLogger } from "../../platform/logger";
import { Metrics } from "../../platform/metrics";
import type { Queue } from "../../platform/queue";
import type { Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { signToken } from "../auth/tokens";
import { billLineItems, bills } from "../bills/bills.schema";
import { confirmBill, createBill } from "../bills/bills.service";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { products } from "../catalog/catalog.schema";
import { getMasterProduct, listInventoryTransactions } from "./inventory.service";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in assertions
type Json = any;

const SECRET = "t".repeat(40);
const demo = { email: "demo@billdrop.app", password: "Demo@1234", jwtSecret: SECRET };
const logger = createLogger({ level: "silent" });

let database: Database;
let storage: Storage;
let queue: Queue;
let app: ReturnType<typeof createApp>;
let token: string;
let testBusinessId: string;
let testUserId: string;

const dummyQueue: Queue = {
  async start() {},
  async stop() {},
  async send() {
    return "job-id";
  },
  async schedule() {},
  async work() {},
};

beforeAll(async () => {
  database = await testDatabase();
  storage = await testStorage();
  queue = dummyQueue;

  testUserId = newId();
  testBusinessId = newId();
  await database.db
    .insert(users)
    .values({ id: testUserId, name: "Inventory User", email: `inv-${testUserId}@test.local` });
  await database.db
    .insert(businesses)
    .values({ id: testBusinessId, name: "Inventory Business", createdBy: testUserId });
  await database.db
    .insert(memberships)
    .values({ businessId: testBusinessId, userId: testUserId, role: "owner" });

  app = createApp({
    logger,
    state: { shuttingDown: false },
    db: database,
    metrics: new Metrics(),
    demo,
    data: { database, storage, queue },
  });

  token = await signToken(SECRET, testUserId, "access");
});

describe("Inventory & Multi-Vendor Stock Tracking", () => {
  test("creates master product and tracks stock increments across multiple vendors", async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      "x-business-id": testBusinessId,
      "content-type": "application/json",
    };

    const prodName = `Broccoli ${newId().slice(-8)}`;

    // 1. Create a Master Product: "Broccoli", standard unit "kg", initial stock 0
    const createRes = await app.request("/v1/inventory/master-products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        display_name: prodName,
        standard_unit: "kg",
        category: "Vegetables",
        reorder_level: "20.000",
        initial_stock: "0.000",
      }),
    });

    if (createRes.status !== 201) {
      console.error("CREATE ERROR:", await createRes.text());
    }
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as Json;
    const masterProductId = createJson.master_product.id;
    expect(createJson.master_product.display_name).toBe(prodName);
    expect(createJson.master_product.current_stock_weight).toBe("0.000");
    expect(createJson.master_product.standard_unit).toBe("kg");

    // 2. Vendor 1: "Fresh Farms Organic" supplies 50 kg of Broccoli
    const bill1Res = await createBill(
      { database, storage, queue },
      {
        businessId: testBusinessId,
        userId: testUserId,
        clientRef: newId(),
        type: "purchase",
        source: "camera",
        droppedAt: new Date(),
        files: [
          {
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]),
            mime: "image/jpeg",
            ext: "jpg",
            sha256: newId(),
          },
        ],
      },
    );

    // Move Bill 1 to needs_review for confirmation
    await database.db
      .update(bills)
      .set({ status: "needs_review" })
      .where(eq(bills.id, bill1Res.bill.id));

    // Confirm Bill 1 with 50 kg Broccoli mapped to master product
    await confirmBill(
      { database, storage, queue },
      { businessId: testBusinessId, userId: testUserId },
      bill1Res.bill.id,
      {
        type: "purchase",
        vendorId: null,
        vendorName: "Fresh Farms Organic",
        invoiceNumber: "INV-FF-001",
        billDate: "2026-10-15",
        lines: [
          {
            description: "Broccoli A-Grade",
            productId: null,
            masterProductId,
            quantity: "50.000",
            unit: "kg",
            rate: "120.0000",
            discount: "0.00",
            printedAmount: "6000.00",
            hsnSac: "0704",
            gstRate: "0.00",
            cgst: "0.00",
            sgst: "0.00",
            igst: "0.00",
            cess: "0.00",
            flags: [],
          },
        ],
      },
    );

    // Verify stock became 50.000 kg
    let product = await getMasterProduct(database.db, testBusinessId, masterProductId);
    expect(product.current_stock_weight).toBe("50.000");

    // 3. Vendor 2: "City Wholesale Mart" supplies 50,000 grams of Broccoli
    const bill2Res = await createBill(
      { database, storage, queue },
      {
        businessId: testBusinessId,
        userId: testUserId,
        clientRef: newId(),
        type: "purchase",
        source: "camera",
        droppedAt: new Date(),
        files: [
          {
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x03, 0x04]),
            mime: "image/jpeg",
            ext: "jpg",
            sha256: newId(),
          },
        ],
      },
    );

    // Move Bill 2 to needs_review for confirmation
    await database.db
      .update(bills)
      .set({ status: "needs_review" })
      .where(eq(bills.id, bill2Res.bill.id));

    // Confirm Bill 2 with 50000 g Broccoli mapped to master product
    await confirmBill(
      { database, storage, queue },
      { businessId: testBusinessId, userId: testUserId },
      bill2Res.bill.id,
      {
        type: "purchase",
        vendorId: null,
        vendorName: "City Wholesale Mart",
        invoiceNumber: "INV-CWM-999",
        billDate: "2026-10-16",
        lines: [
          {
            description: "Green Broccoli Premium Pack",
            productId: null,
            masterProductId,
            quantity: "50000.000",
            unit: "g", // 50000 g = 50 kg!
            rate: "0.1100",
            discount: "0.00",
            printedAmount: "5500.00",
            hsnSac: "0704",
            gstRate: "0.00",
            cgst: "0.00",
            sgst: "0.00",
            igst: "0.00",
            cess: "0.00",
            flags: [],
          },
        ],
      },
    );

    // Stock should now be 50.000 + 50.000 = 100.000 kg!
    product = await getMasterProduct(database.db, testBusinessId, masterProductId);
    expect(product.current_stock_weight).toBe("100.000");

    // 4. Verify transaction ledger lists both vendors
    const txs = await listInventoryTransactions(database.db, testBusinessId, masterProductId);
    expect(txs.length).toBe(2);
    expect(txs[0]?.transaction_type).toBe("purchase_in");
    expect(txs[0]?.delta_weight).toBe("50.000");
    expect(txs[0]?.resulting_stock_weight).toBe("100.000");
    expect(txs[0]?.vendor_name).toBe("City Wholesale Mart");

    expect(txs[1]?.transaction_type).toBe("purchase_in");
    expect(txs[1]?.delta_weight).toBe("50.000");
    expect(txs[1]?.resulting_stock_weight).toBe("50.000");
    expect(txs[1]?.vendor_name).toBe("Fresh Farms Organic");

    // 5. Manual stock adjustment: -10 kg wastage
    const adjustRes = await app.request(`/v1/inventory/master-products/${masterProductId}/adjust`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        delta_weight: "-10.000",
        unit: "kg",
        note: "Damaged during handling",
      }),
    });

    expect(adjustRes.status).toBe(200);
    const adjustJson = (await adjustRes.json()) as Json;
    expect(adjustJson.master_product.current_stock_weight).toBe("90.000");

    // 6. Test GET /v1/inventory
    const listRes = await app.request(`/v1/inventory?query=${encodeURIComponent(prodName)}`, {
      headers,
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as Json;
    expect(listJson.items.length).toBeGreaterThanOrEqual(1);
    expect(listJson.items[0].display_name).toBe(prodName);
    expect(listJson.items[0].current_stock_weight).toBe("90.000");
  });

  test("edits details, locks the unit once stock moved, and deletes with unlinking", async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      "x-business-id": testBusinessId,
      "content-type": "application/json",
    };
    const name = `Paneer ${newId().slice(-8)}`;

    const created = (await (
      await app.request("/v1/inventory/master-products", {
        method: "POST",
        headers,
        body: JSON.stringify({ display_name: name, standard_unit: "kg" }),
      })
    ).json()) as Json;
    const id = created.master_product.id;

    // No stock history yet: name, category, reorder level and unit can all change.
    const edit = await app.request(`/v1/inventory/master-products/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        display_name: `${name} Fresh`,
        category: "Dairy",
        reorder_level: "5",
        standard_unit: "g",
      }),
    });
    expect(edit.status).toBe(200);
    const edited = (await edit.json()) as Json;
    expect(edited.master_product.display_name).toBe(`${name} Fresh`);
    expect(edited.master_product.category).toBe("Dairy");
    expect(edited.master_product.standard_unit).toBe("g");

    await app.request(`/v1/inventory/master-products/${id}/adjust`, {
      method: "POST",
      headers,
      body: JSON.stringify({ delta_weight: "500", unit: "g" }),
    });

    // Stock moved: a unit the history can't convert to is locked, but other fields still save.
    // (g -> kg converts, so that change is allowed and replays: see units.integration.test.ts.)
    const unit = await app.request(`/v1/inventory/master-products/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ standard_unit: "pcs" }),
    });
    expect(unit.status).toBe(409);
    expect(((await unit.json()) as Json).units).toEqual(["g"]);
    const sameUnit = await app.request(`/v1/inventory/master-products/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ standard_unit: "g", category: "Milk" }),
    });
    expect(sameUnit.status).toBe(200);

    // A bill line mapped to it is unlinked, not deleted, when the product goes.
    const drop = await createBill(
      { database, storage, queue },
      {
        businessId: testBusinessId,
        userId: testUserId,
        clientRef: newId(),
        type: "purchase",
        source: "camera",
        droppedAt: new Date(),
        files: [
          {
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x05, 0x06]),
            mime: "image/jpeg",
            ext: "jpg",
            sha256: newId(),
          },
        ],
      },
    );
    await database.db
      .update(bills)
      .set({ status: "needs_review" })
      .where(eq(bills.id, drop.bill.id));
    await confirmBill(
      { database, storage, queue },
      { businessId: testBusinessId, userId: testUserId },
      drop.bill.id,
      {
        type: "purchase",
        vendorId: null,
        vendorName: `Dairy Co ${newId().slice(-6)}`,
        invoiceNumber: "INV-D-1",
        billDate: "2026-10-20",
        lines: [
          {
            description: "Paneer block",
            productId: null,
            masterProductId: id,
            quantity: "2.000",
            unit: "kg",
            rate: "300.0000",
            discount: "0.00",
            printedAmount: "600.00",
            hsnSac: null,
            gstRate: null,
            cgst: "0.00",
            sgst: "0.00",
            igst: "0.00",
            cess: "0.00",
            flags: [],
          },
        ],
      },
    );

    const del = await app.request(`/v1/inventory/master-products/${id}`, {
      method: "DELETE",
      headers,
    });
    expect(del.status).toBe(204);

    const gone = await app.request(`/v1/inventory/master-products/${id}`, { headers });
    expect(gone.status).toBe(404);
    expect(await listInventoryTransactions(database.db, testBusinessId, id)).toHaveLength(0);
    const lines = await database.db
      .select({ masterProductId: billLineItems.masterProductId })
      .from(billLineItems)
      .where(eq(billLineItems.billId, drop.bill.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.masterProductId).toBeNull();
    const [linked] = await database.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.businessId, testBusinessId), eq(products.masterProductId, id)));
    expect(linked).toBeUndefined();
  });
});
