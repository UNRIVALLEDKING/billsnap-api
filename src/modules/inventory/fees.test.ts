import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { testDatabase, testStorage } from "../../../test/setup";
import { createApp } from "../../app";
import type { Database } from "../../platform/db/client";
import { createLogger } from "../../platform/logger";
import { Metrics } from "../../platform/metrics";
import type { Queue } from "../../platform/queue";
import type { Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { signToken } from "../auth/tokens";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import type { FeeDefinitionView, MasterCategoryView } from "./inventory.service";
import { recordStockIncrement } from "./inventory.service";

type Json = Record<string, unknown>;
type CatalogResult = {
  success: boolean;
  products_created: number;
  total_products: number;
  categories: string[];
};

const SECRET = "t".repeat(40);
const demo = { email: "demo@billdrop.app", password: "Demo@1234", jwtSecret: SECRET };
const logger = createLogger({ level: "silent" });

let database: Database;
let storage: Storage;
let queue: Queue;
let app: ReturnType<typeof createApp>;

let ownerUserId: string;
let accountantUserId: string;
let staffUserId: string;

let ownerToken: string;
let accountantToken: string;
let staffToken: string;

let testBusinessId: string;

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

  ownerUserId = newId();
  accountantUserId = newId();
  staffUserId = newId();
  testBusinessId = newId();

  await database.db.insert(users).values([
    { id: ownerUserId, name: "Owner User", email: `owner-${ownerUserId}@test.local` },
    { id: accountantUserId, name: "Accountant User", email: `acct-${accountantUserId}@test.local` },
    { id: staffUserId, name: "Staff User", email: `staff-${staffUserId}@test.local` },
  ]);

  await database.db.insert(businesses).values({
    id: testBusinessId,
    name: "Fees Test Business",
    createdBy: ownerUserId,
  });

  await database.db.insert(memberships).values([
    { businessId: testBusinessId, userId: ownerUserId, role: "owner" },
    { businessId: testBusinessId, userId: accountantUserId, role: "accountant" },
    { businessId: testBusinessId, userId: staffUserId, role: "staff" },
  ]);

  app = createApp({
    logger,
    state: { shuttingDown: false },
    db: database,
    metrics: new Metrics(),
    demo,
    data: { database, storage, queue },
  });

  ownerToken = await signToken(SECRET, ownerUserId, "access");
  accountantToken = await signToken(SECRET, accountantUserId, "access");
  staffToken = await signToken(SECRET, staffUserId, "access");
});

describe("Fee Definitions CRUD & RBAC", () => {
  let createdFeeId: string;

  test("owner can create a fee definition", async () => {
    const res = await app.request("/v1/fees", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "x-business-id": testBusinessId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Special Hamali",
        category: "hamali",
        default_basis: "weight",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { fee: FeeDefinitionView };
    expect(body.fee.id).toBeDefined();
    expect(body.fee.name).toBe("Special Hamali");
    expect(body.fee.category).toBe("hamali");
    expect(body.fee.default_basis).toBe("weight");
    expect(body.fee.is_active).toBe(true);

    createdFeeId = body.fee.id;
  });

  test("staff can view fee definitions, but cannot create", async () => {
    // 1. Staff can view
    const viewRes = await app.request("/v1/fees", {
      method: "GET",
      headers: {
        authorization: `Bearer ${staffToken}`,
        "x-business-id": testBusinessId,
      },
    });
    expect(viewRes.status).toBe(200);
    const viewBody = (await viewRes.json()) as { fees: FeeDefinitionView[] };
    expect(Array.isArray(viewBody.fees)).toBe(true);
    expect(viewBody.fees.some((f) => f.id === createdFeeId)).toBe(true);

    // 2. Staff cannot create
    const createRes = await app.request("/v1/fees", {
      method: "POST",
      headers: {
        authorization: `Bearer ${staffToken}`,
        "x-business-id": testBusinessId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Unauthorized Fee",
        category: "other",
      }),
    });
    expect(createRes.status).toBe(403);
  });

  test("accountant can update fee definition", async () => {
    const res = await app.request(`/v1/fees/${createdFeeId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${accountantToken}`,
        "x-business-id": testBusinessId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Updated Hamali",
        default_basis: "value",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { fee: FeeDefinitionView };
    expect(body.fee.name).toBe("Updated Hamali");
    expect(body.fee.default_basis).toBe("value");
  });

  test("owner can delete (soft-delete) fee definition", async () => {
    const res = await app.request(`/v1/fees/${createdFeeId}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "x-business-id": testBusinessId,
      },
    });
    expect(res.status).toBe(204);

    // Verify it is no longer returned in active list
    const listRes = await app.request("/v1/fees", {
      method: "GET",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "x-business-id": testBusinessId,
      },
    });
    const listBody = (await listRes.json()) as { fees: FeeDefinitionView[] };
    expect(listBody.fees.some((f) => f.id === createdFeeId)).toBe(false);

    // But it is returned when include_inactive=true
    const inactiveRes = await app.request("/v1/fees?include_inactive=true", {
      method: "GET",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "x-business-id": testBusinessId,
      },
    });
    const inactiveBody = (await inactiveRes.json()) as { fees: FeeDefinitionView[] };
    expect(inactiveBody.fees.some((f) => f.id === createdFeeId && f.is_active === false)).toBe(
      true,
    );
  });
});

describe("Multi-Trade Catalog Initialization & In-Stock Separation", () => {
  let catalogBusinessId: string;
  let catalogToken: string;

  beforeAll(async () => {
    catalogBusinessId = newId();
    await database.db.insert(businesses).values({
      id: catalogBusinessId,
      name: "Catalog Test Business",
      createdBy: ownerUserId,
    });
    await database.db.insert(memberships).values({
      businessId: catalogBusinessId,
      userId: ownerUserId,
      role: "owner",
    });
    catalogToken = await signToken(SECRET, ownerUserId, "access");
  });

  test("POST /v1/business/initialize-catalog seeds products and fees", async () => {
    const res = await app.request("/v1/business/initialize-catalog", {
      method: "POST",
      headers: {
        authorization: `Bearer ${catalogToken}`,
        "x-business-id": catalogBusinessId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        trade_type: "fruits",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.success).toBe(true);
    expect(body.productsCreated).toBeGreaterThanOrEqual(100);
    expect(body.products_created).toBe(body.productsCreated);
    expect(body.feesCreated).toBe(5);
    expect(body.fees_created).toBe(5);
    expect(body.total_products).toBe(body.productsCreated);
    expect(body.categories).toContain("Citrus");
    expect(body.categories).toContain("Apples & Pears");
    expect(body.categories).not.toContain("Leafy Greens");

    // Verify fees exist
    const feeRes = await app.request("/v1/fees", {
      method: "GET",
      headers: {
        authorization: `Bearer ${catalogToken}`,
        "x-business-id": catalogBusinessId,
      },
    });
    const feeBody = (await feeRes.json()) as { fees: FeeDefinitionView[] };
    const feeNames = feeBody.fees.map((f) => f.name);
    expect(feeNames).toContain("Transport / Tempo");
    expect(feeNames).toContain("Hamali / Loading & Unloading");
    expect(feeNames).toContain("Ice Box Packaging");
    expect(feeNames).toContain("Wooden Crate Packaging");
    expect(feeNames).toContain("APMC / Mandi Cess");
  });

  test("GET /v1/inventory/trade-catalogs lists the starter lists", async () => {
    const res = await app.request("/v1/inventory/trade-catalogs", {
      headers: { authorization: `Bearer ${catalogToken}`, "x-business-id": catalogBusinessId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        name: string;
        item_count: number;
        categories: Array<{ name: string; item_count: number }>;
      }>;
    };
    expect(body.items.map((i) => i.id)).toEqual([
      "vegetables",
      "fruits",
      "grocery",
      "electronics",
      "skincare",
    ]);
    for (const c of body.items) {
      expect(c.item_count).toBeGreaterThan(0);
      expect(c.categories.reduce((n, x) => n + x.item_count, 0)).toBe(c.item_count);
    }
    const veg = body.items.find((i) => i.id === "vegetables");
    const fruit = body.items.find((i) => i.id === "fruits");
    expect((veg?.item_count ?? 0) + (fruit?.item_count ?? 0)).toBe(424);
  });

  test("initialize-catalog takes trade_types and a category filter", async () => {
    const ownerId = newId();
    const bizId = newId();
    await database.db
      .insert(users)
      .values({ id: ownerId, name: "Multi", email: `multi-${ownerId}@test.local` });
    await database.db
      .insert(businesses)
      .values({ id: bizId, name: "Multi Business", createdBy: ownerId });
    await database.db
      .insert(memberships)
      .values({ businessId: bizId, userId: ownerId, role: "owner" });
    const headers = {
      authorization: `Bearer ${await signToken(SECRET, ownerId, "access")}`,
      "x-business-id": bizId,
      "content-type": "application/json",
    };
    const post = async (body: unknown) =>
      (await (
        await app.request("/v1/inventory/initialize-catalog", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      ).json()) as CatalogResult;

    const first = await post({
      trade_types: ["fruits", "vegetables"],
      categories: ["Mangoes", "Potatoes"],
    });
    expect(first.products_created).toBeGreaterThan(0);
    expect([...first.categories].sort()).toEqual(["Mangoes", "Potatoes"]);
    expect(first.total_products).toBe(first.products_created);
    const [biz] = await database.db
      .select({ tradeType: businesses.tradeType, cats: businesses.configuredCategories })
      .from(businesses)
      .where(eq(businesses.id, bizId));
    expect(biz?.tradeType).toBe("fruits");
    expect(biz?.cats).toEqual(["Mangoes", "Potatoes"]);

    // re-importing skips what is already there; the old single trade_type body still works
    const again = await post({ trade_types: ["fruits"], categories: ["Mangoes"] });
    expect(again.products_created).toBe(0);
    const old = await post({ trade_type: "grocery" });
    expect(old.success).toBe(true);
    expect(old.products_created).toBeGreaterThan(0);
    expect(old.total_products).toBeGreaterThan(first.total_products);

    const bad = await app.request("/v1/inventory/initialize-catalog", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(422);
  });

  test("separates in-stock inventory vs full master catalog", async () => {
    const headers = {
      authorization: `Bearer ${catalogToken}`,
      "x-business-id": catalogBusinessId,
      "content-type": "application/json",
    };

    // 1. In-stock inventory should initially be empty (0 items with stock > 0)
    const stockRes = await app.request("/v1/inventory", {
      method: "GET",
      headers,
    });
    expect(stockRes.status).toBe(200);
    const stockBody = (await stockRes.json()) as {
      items: unknown[];
      summary: { totalItems: number; totalStockWeight: string };
    };
    expect(stockBody.items.length).toBe(0);
    expect(stockBody.summary.totalItems).toBe(0);
    expect(stockBody.summary.totalStockWeight).toBe("0.000");

    // 2. Full master catalog should contain all seeded fruit products
    const masterRes = await app.request("/v1/inventory/master-products", {
      method: "GET",
      headers,
    });
    expect(masterRes.status).toBe(200);
    const masterBody = (await masterRes.json()) as {
      items: Array<{ id: string; category: string; standard_unit: string }>;
    };
    expect(masterBody.items.length).toBeGreaterThanOrEqual(35);

    // 3. Categories endpoint returns category counts
    const catRes = await app.request("/v1/inventory/categories", {
      method: "GET",
      headers,
    });
    expect(catRes.status).toBe(200);
    const catBody = (await catRes.json()) as { categories: MasterCategoryView[] };
    expect(catBody.categories.length).toBeGreaterThanOrEqual(5);
    const citrusCat = catBody.categories.find((c) => c.category === "Citrus");
    expect(citrusCat).toBeDefined();
    expect(citrusCat?.productCount).toBeGreaterThan(0);
    expect(citrusCat?.inStockCount).toBe(0);

    // 4. Record stock for one item
    const firstProduct = masterBody.items[0];
    expect(firstProduct).toBeDefined();
    if (!firstProduct) throw new Error("Expected at least one product in master catalog");
    await recordStockIncrement(database.db, {
      businessId: catalogBusinessId,
      masterProductId: firstProduct.id,
      deltaQuantity: "45.000",
      quantityUnit: firstProduct.standard_unit,
      type: "manual_adjustment",
      note: "Test stock",
    });

    // 5. In-stock inventory should now have exactly 1 item
    const updatedStockRes = await app.request("/v1/inventory", {
      method: "GET",
      headers,
    });
    const updatedStockBody = (await updatedStockRes.json()) as {
      items: Array<{ id: string }>;
      summary: { totalItems: number; totalStockWeight: string };
    };
    expect(updatedStockBody.items.length).toBe(1);
    expect(updatedStockBody.items[0]?.id).toBe(firstProduct.id);
    expect(updatedStockBody.summary.totalItems).toBe(1);
    expect(updatedStockBody.summary.totalStockWeight).toBe("45.000");

    // Master products in_stock_only=true returns 1 item
    const inStockOnlyRes = await app.request("/v1/inventory/master-products?in_stock_only=true", {
      method: "GET",
      headers,
    });
    const inStockOnlyBody = (await inStockOnlyRes.json()) as { items: Array<{ id: string }> };
    expect(inStockOnlyBody.items.length).toBe(1);
    expect(inStockOnlyBody.items[0]?.id).toBe(firstProduct.id);

    // Category inStockCount now reflects 1
    const updatedCatRes = await app.request("/v1/inventory/categories", {
      method: "GET",
      headers,
    });
    const updatedCatBody = (await updatedCatRes.json()) as { categories: MasterCategoryView[] };
    const prodCat = updatedCatBody.categories.find((c) => c.category === firstProduct.category);
    expect(prodCat?.inStockCount).toBe(1);
  });
});
