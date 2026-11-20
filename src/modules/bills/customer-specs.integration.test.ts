// Your business on bills and item specs per party (docs/CUSTOMER_SPECS_PLAN.md B6, B7). Real Postgres
// (compose stack), through the routes; extraction runs the real handler with a stub AI.
import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { testDatabase, testStorage } from "../../../test/setup";
import { createApp } from "../../app";
import type { AiExtractResult, AiProvider } from "../../platform/ai";
import type { Database } from "../../platform/db/client";
import { createLogger } from "../../platform/logger";
import { Metrics } from "../../platform/metrics";
import type { Queue } from "../../platform/queue";
import type { Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { signToken } from "../auth/tokens";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { vendors } from "../catalog/catalog.schema";
import { createExtractHandler } from "../extraction/extract.job";
import { createMasterProduct, listInventoryTransactions } from "../inventory/inventory.service";
import { replayItems } from "../inventory/replay";
import { billFiles, billLineItems, bills } from "./bills.schema";

const SECRET = "t".repeat(40);
const OWN_GSTIN = "27AAPFU0939F1ZV";
const dummyQueue: Queue = {
  async start() {},
  async stop() {},
  async send() {
    return "job-id";
  },
  async schedule() {},
  async work() {},
};

let database: Database;
let app: ReturnType<typeof createApp>;
let businessId: string;
let userId: string;
let headers: Record<string, string>;
let cherry: string;

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
type Json = any;

beforeAll(async () => {
  database = await testDatabase();
  const storage = await testStorage();
  userId = newId();
  businessId = newId();
  await database.db
    .insert(users)
    .values({ id: userId, name: "Specs", email: `specs-${userId}@test.local` });
  await database.db
    .insert(businesses)
    .values({ id: businessId, name: "Samavaya Agro", gstin: OWN_GSTIN, createdBy: userId });
  await database.db.insert(memberships).values({ businessId, userId, role: "owner" });
  app = createApp({
    logger: createLogger({ level: "silent" }),
    state: { shuttingDown: false },
    db: database,
    metrics: new Metrics(),
    demo: { email: "demo@billdrop.app", password: "Demo@1234", jwtSecret: SECRET },
    data: { database, storage, queue: dummyQueue },
  });
  headers = {
    authorization: `Bearer ${await signToken(SECRET, userId, "access")}`,
    "x-business-id": businessId,
    "content-type": "application/json",
  };
  cherry = (
    await createMasterProduct(database.db, {
      businessId,
      displayName: "Cherry tomatoes",
      standardUnit: "kg",
    })
  ).id;
});

async function newBill(
  type: "purchase" | "sale",
  status: "needs_review" | "queued" = "needs_review",
) {
  const id = newId();
  await database.db.insert(bills).values({
    id,
    businessId,
    clientRef: newId(),
    type,
    status,
    source: "camera",
    uploadedBy: userId,
    droppedAt: new Date(),
  });
  return id;
}

type Line = {
  desc: string;
  qty: string;
  unit: string;
  rate?: string;
  productId?: string | null;
  item?: string | null;
  stockFactor?: string;
  saveSpec?: boolean;
  packQtyUnit?: string;
};

const body = (
  type: "purchase" | "sale",
  party: { name: string; id?: string | null | undefined },
  lines: Line[],
  date: string,
) => ({
  type,
  vendor_id: party.id ?? null,
  vendor_name: party.name,
  invoice_number: `S-${newId().slice(-6)}`,
  bill_date: date,
  lines: lines.map((l) => ({
    description: l.desc,
    product_id: l.productId ?? null,
    master_product_id: l.item === undefined ? cherry : l.item,
    quantity: l.qty,
    unit: l.unit,
    rate: l.rate ?? "50",
    discount: "0",
    printed_amount: null,
    hsn_sac: null,
    gst_rate: null,
    cgst: "0",
    sgst: "0",
    igst: "0",
    cess: "0",
    flags: [],
    ...(l.stockFactor ? { stock_factor: l.stockFactor } : {}),
    ...(l.saveSpec !== undefined ? { save_spec: l.saveSpec } : {}),
    ...(l.packQtyUnit ? { pack_qty_unit: l.packQtyUnit } : {}),
  })),
  charges: [],
});

const post = (path: string, payload: unknown, method = "POST") =>
  app.request(path, { method, headers, body: JSON.stringify(payload) });
const confirm = (
  id: string,
  type: "purchase" | "sale",
  party: { name: string; id?: string | null | undefined },
  lines: Line[],
  date = "2026-11-10",
) => post(`/v1/bills/${id}/confirm`, body(type, party, lines, date));
const getJson = async (path: string): Promise<Json> =>
  (await app.request(path, { headers })).json();
const stock = async () =>
  (await getJson(`/v1/inventory/master-products/${cherry}`)).master_product.current_stock_weight;
const productOf = async (vendorId: string): Promise<Json> =>
  ((await getJson("/v1/products")) as Json[]).find((p) => p.vendor_id === vendorId);
const sold = async (billId: string) =>
  (await listInventoryTransactions(database.db, businessId, cherry)).find(
    (t) => t.bill_id === billId,
  )?.delta_weight;

const stubAi = (output: unknown): AiProvider => ({
  name: "stub",
  async extractBill(): Promise<AiExtractResult> {
    return { output, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
  },
});
const fileStore = {
  async getObject() {
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])).body;
  },
} as unknown as Storage;

/** Reads a stub bill through the real extract handler and returns its view. */
async function extract(type: "purchase" | "sale", output: Record<string, unknown>): Promise<Json> {
  const billId = await newBill(type, "queued");
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
  const handler = createExtractHandler({
    database,
    storage: fileStore,
    ai: stubAi({ is_bill: true, invoice_number: `X-${newId().slice(-6)}`, ...output }),
    model: "stub-model",
    log: createLogger({ level: "silent" }),
    retryDelayMs: 0,
  });
  await handler({ id: "job", data: { billId, businessId } });
  return getJson(`/v1/bills/${billId}`);
}

const ids: Record<string, string> = {};

describe("B6: your business name aliases", () => {
  test("PATCH saves name_aliases; /v1/me and the business view show them", async () => {
    const res = await post(
      `/v1/businesses/${businessId}`,
      { name_aliases: ["Samavaya", "Samavaya Fresh", "samavaya"] },
      "PATCH",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).business.name_aliases).toEqual([
      "Samavaya",
      "Samavaya Fresh",
    ]);
    const me = (await getJson("/v1/me")) as Json;
    const mine = me.memberships.find((m: Json) => m.business.id === businessId);
    expect(mine.business.name_aliases).toEqual(["Samavaya", "Samavaya Fresh"]);
    const tooMany = await post(
      `/v1/businesses/${businessId}`,
      { name_aliases: Array.from({ length: 21 }, (_, i) => `n${i}`) },
      "PATCH",
    );
    expect(tooMany.status).toBe(422);
  });
});

describe("B7: item specs per customer", () => {
  test("stock in: 30 kg from a farm", async () => {
    const id = await newBill("purchase");
    const res = await confirm(
      id,
      "purchase",
      { name: "Krishna Farms" },
      [{ desc: "Cherry tomato", qty: "30", unit: "kg", rate: "100" }],
      "2026-11-01",
    );
    expect(res.status).toBe(200);
    expect(await stock()).toBe("30.000");
  });

  test("Flipkart 20 box: 422 names the party; saving 200 g takes out 4 kg", async () => {
    const id = await newBill("sale");
    const line = { desc: "Unbranded cherry tomatoes", qty: "20", unit: "box" };
    const stuck = await confirm(id, "sale", { name: "Flipkart" }, [line]);
    expect(stuck.status).toBe(422);
    const problem = (await stuck.json()) as Json;
    expect(problem.code).toBe("unit_conversion_needed");
    expect(problem.detail ?? problem.title ?? "").toContain("Flipkart");
    expect(problem.lines).toEqual([
      expect.objectContaining({
        index: 0,
        item_id: cherry,
        from_unit: "box",
        to_unit: "kg",
        party_id: null,
        party_name: "Flipkart",
        product_id: null,
      }),
    ]);

    const ok = await confirm(id, "sale", { name: "Flipkart" }, [
      { ...line, stockFactor: "0.2", saveSpec: true, packQtyUnit: "g" },
    ]);
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as Json;
    ids.flipkart = view.vendor_id;
    ids.flipkartBill1 = id;
    expect(view.lines[0]).toMatchObject({
      stock_factor: "0.2",
      stock_factor_source: "customer",
      stock_qty: "4.000",
      suggested_spec: { pack_unit: "box", pack_qty: "200", pack_qty_unit: "g" },
    });
    expect(await sold(id)).toBe("-4.000");
    const product = await productOf(ids.flipkart as string);
    expect([product.pack_unit, product.pack_qty, product.pack_qty_unit]).toEqual([
      "box",
      "200",
      "g",
    ]);
  });

  test("Zepto 10 x 250 g and Blinkit 30 x 200 g take out 2.5 and 6 kg", async () => {
    const z = await newBill("sale");
    const zr = await confirm(z, "sale", { name: "Zepto" }, [
      {
        desc: "Samavaya cherry tomatoes",
        qty: "10",
        unit: "box",
        stockFactor: "0.25",
        saveSpec: true,
      },
    ]);
    expect(zr.status).toBe(200);
    const zv = (await zr.json()) as Json;
    expect(await sold(z)).toBe("-2.500");
    // No pack_qty_unit sent: the spec is kept in the item's stock unit.
    expect(zv.lines[0].suggested_spec).toEqual({
      pack_unit: "box",
      pack_qty: "0.25",
      pack_qty_unit: "kg",
    });

    const b = await newBill("sale");
    const br = await confirm(b, "sale", { name: "Blinkit" }, [
      {
        desc: "Cherry tomato 200g",
        qty: "30",
        unit: "box",
        stockFactor: "0.2",
        saveSpec: true,
        packQtyUnit: "g",
      },
    ]);
    expect(br.status).toBe(200);
    ids.blinkit = ((await br.json()) as Json).vendor_id;
    ids.blinkitBill = b;
    expect(await sold(b)).toBe("-6.000");
    expect(await stock()).toBe("17.500");
  });

  test("the next Flipkart invoice auto-maps at extraction (item and size)", async () => {
    const view = await extract("sale", {
      seller: { name: "SAMAVAYA", gstin: OWN_GSTIN },
      buyer: { name: "Flipkart", gstin: null },
      counterparty: { name: "Samavaya", gstin: null },
      date_iso: "2026-11-12",
      line_items: [
        {
          description: "Unbranded cherry tomatoes",
          quantity: "15",
          unit: "boxes",
          rate: "50",
          amount: "750",
        },
      ],
      grand_total: "750",
    });
    expect(view.status).toBe("needs_review");
    expect([view.vendor_name, view.vendor_id]).toEqual(["Flipkart", ids.flipkart]);
    expect(view.flags).not.toContain("seller_unknown");
    const line = view.lines[0];
    expect(line).toMatchObject({
      master_product_id: cherry,
      unit: "box",
      stock_factor: "0.2",
      stock_factor_source: "customer",
      stock_qty: "3.000",
      suggested_spec: { pack_unit: "box", pack_qty: "200", pack_qty_unit: "g" },
    });
    expect(line.flags).not.toContain("stock_auto_linked");

    // Confirming as shown, with no factor sent: the spec decides and is stored on the line.
    const res = await confirm(
      view.id,
      "sale",
      { name: "Flipkart", id: view.vendor_id },
      [{ desc: line.description, qty: "15", unit: "box", productId: line.product_id }],
      "2026-11-12",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).lines[0]).toMatchObject({
      stock_factor: "0.2",
      stock_factor_source: "customer",
    });
    expect(await sold(view.id)).toBe("-3.000");
  });

  test("changing Flipkart to 250 g with save: new and future bills use it, old bills keep 200 g", async () => {
    const changed = await newBill("sale");
    const res = await confirm(
      changed,
      "sale",
      { name: "Flipkart", id: ids.flipkart },
      [
        {
          desc: "Unbranded cherry tomatoes",
          qty: "4",
          unit: "box",
          stockFactor: "0.25",
          saveSpec: true,
          packQtyUnit: "g",
        },
      ],
      "2026-11-13",
    );
    expect(res.status).toBe(200);
    expect(await sold(changed)).toBe("-1.000");

    const future = await newBill("sale");
    const fr = await confirm(
      future,
      "sale",
      { name: "Flipkart", id: ids.flipkart },
      [{ desc: "Unbranded cherry tomatoes", qty: "2", unit: "box" }],
      "2026-11-14",
    );
    expect(fr.status).toBe(200);
    expect(await sold(future)).toBe("-0.500");

    await database.tx(({ db }) => replayItems(db, businessId, [cherry]));
    expect(await sold(ids.flipkartBill1 as string)).toBe("-4.000");
    const old = (await getJson(`/v1/bills/${ids.flipkartBill1}`)) as Json;
    expect(old.lines[0]).toMatchObject({ stock_factor: "0.2", stock_qty: "4.000" });
    // 30 - 4 - 2.5 - 6 - 3 - 1 - 0.5
    expect(await stock()).toBe("13.000");
  });

  test("'only this bill' (a factor without save_spec) keeps the spec", async () => {
    const id = await newBill("sale");
    const res = await confirm(
      id,
      "sale",
      { name: "Flipkart", id: ids.flipkart },
      [{ desc: "Unbranded cherry tomatoes", qty: "10", unit: "box", stockFactor: "0.3" }],
      "2026-11-15",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).lines[0]).toMatchObject({
      stock_factor: "0.3",
      stock_factor_source: "manual",
      stock_qty: "3.000",
      suggested_spec: { pack_unit: "box", pack_qty: "250", pack_qty_unit: "g" },
    });
    const p = await productOf(ids.flipkart as string);
    expect([p.pack_qty, p.pack_qty_unit]).toEqual(["250", "g"]);
    expect(await stock()).toBe("10.000");
  });

  test("PUT/DELETE /v1/products/:id/spec; confirmed bills keep their factor", async () => {
    const blinkitProduct = await productOf(ids.blinkit as string);
    const put = await post(
      `/v1/products/${blinkitProduct.id}/spec`,
      { pack_unit: "Box", pack_qty: "0.5", pack_qty_unit: "kg" },
      "PUT",
    );
    expect(put.status).toBe(200);
    expect((await put.json()) as Json).toMatchObject({
      id: blinkitProduct.id,
      pack_unit: "box",
      pack_qty: "0.5",
      pack_qty_unit: "kg",
    });
    expect(await sold(ids.blinkitBill as string)).toBe("-6.000");
    const bad = await post(
      `/v1/products/${blinkitProduct.id}/spec`,
      { pack_unit: "box", pack_qty: "0", pack_qty_unit: "kg" },
      "PUT",
    );
    expect(bad.status).toBe(422);
    const del = await app.request(`/v1/products/${blinkitProduct.id}/spec`, {
      method: "DELETE",
      headers,
    });
    expect(del.status).toBe(200);
    expect((await del.json()) as Json).toMatchObject({
      pack_unit: null,
      pack_qty: null,
      pack_qty_unit: null,
    });
    expect(await stock()).toBe("10.000");
    const missing = await app.request(`/v1/products/${newId()}/spec`, {
      method: "DELETE",
      headers,
    });
    expect(missing.status).toBe(404);
  });

  test("changing the item's unit to g rescales kept factors", async () => {
    const res = await post(
      `/v1/inventory/master-products/${cherry}`,
      { standard_unit: "g" },
      "PATCH",
    );
    expect(res.status).toBe(200);
    expect(await stock()).toBe("10000.000");
    const old = (await getJson(`/v1/bills/${ids.flipkartBill1}`)) as Json;
    expect(old.lines[0]).toMatchObject({ stock_factor: "200", stock_qty: "4000.000" });
    expect(await sold(ids.flipkartBill1 as string)).toBe("-4000.000");
  });
});

describe("B6: your own business is never the other party", () => {
  test("confirm with our name, alias or vendor id is 422 counterparty_is_self; no vendor made", async () => {
    for (const name of ["Samavaya", "Samavaya Agro Pvt Ltd", "SAMAVAYA FRESH"]) {
      const id = await newBill("sale");
      const res = await confirm(id, "sale", { name }, [
        { desc: "Cherry", qty: "1", unit: "g", item: null },
      ]);
      expect(res.status).toBe(422);
      const problem = (await res.json()) as Json;
      expect(problem.code).toBe("counterparty_is_self");
      expect(problem.detail).toBe("This is your own business. Choose the customer (or vendor).");
    }
    const selfVendors = await database.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.businessId, businessId), eq(vendors.nameNorm, "samavaya")));
    expect(selfVendors).toEqual([]);

    // A vendor record that is us (made before this guard) is refused by id too.
    const legacy = newId();
    await database.db.insert(vendors).values({
      id: legacy,
      businessId,
      displayName: "Samavaya Fresh",
      nameNorm: "samavaya fresh",
    });
    const id = await newBill("sale");
    const res = await confirm(id, "sale", { name: "Someone", id: legacy }, [
      { desc: "Cherry", qty: "1", unit: "g", item: null },
    ]);
    expect(res.status).toBe(422);
    expect(((await res.json()) as Json).code).toBe("counterparty_is_self");
  });

  test("Samavaya -> Zepto sale extraction picks Zepto and keeps both parties", async () => {
    const zeptoGstin = "29AAGCB7383J1Z4";
    const view = await extract("sale", {
      seller: { name: "Samavaya Fresh", gstin: OWN_GSTIN },
      buyer: { name: "Zepto Marketplace Pvt Ltd", gstin: zeptoGstin },
      counterparty: { name: "Samavaya Fresh", gstin: OWN_GSTIN },
      date_iso: "2026-11-16",
      line_items: [
        { description: "Cherry tomato", quantity: "1", unit: "kg", rate: "80", amount: "80" },
      ],
      grand_total: "80",
    });
    expect([view.vendor_name, view.gstin]).toEqual(["Zepto Marketplace Pvt Ltd", zeptoGstin]);
    expect(view.flags).not.toContain("looks_like_sale");
    expect(view.flags).not.toContain("seller_unknown");
    expect(view.extracted_parties).toEqual({
      seller: { name: "Samavaya Fresh", gstin: OWN_GSTIN },
      buyer: { name: "Zepto Marketplace Pvt Ltd", gstin: zeptoGstin },
    });
  });

  test("the same paper added as a purchase is flagged looks_like_sale; confirming as a sale clears it", async () => {
    const view = await extract("purchase", {
      seller: { name: "Samavaya", gstin: null },
      buyer: { name: "Zepto", gstin: null },
      date_iso: "2026-11-16",
      line_items: [
        { description: "Cherry tomato", quantity: "1", unit: "kg", rate: "80", amount: "80" },
      ],
      grand_total: "80",
    });
    expect(view.vendor_name).toBe("Zepto");
    expect(view.flags).toContain("looks_like_sale");
    const res = await confirm(view.id, "sale", { name: "Zepto" }, [
      { desc: "Cherry tomato", qty: "1", unit: "kg", item: null },
    ]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).flags).not.toContain("looks_like_sale");
  });
});

describe("B7: pack size suggested from the item name", () => {
  const DESC = "Kaffir Lime Leaves (Makroot) - 10 g";
  const kiranakart = { name: "Kiranakart" };
  // Its own kg item: an earlier test switches Cherry tomatoes to grams.
  let lime: string;
  beforeAll(async () => {
    lime = (
      await createMasterProduct(database.db, {
        businessId,
        displayName: "Kaffir lime leaves",
        standardUnit: "kg",
      })
    ).id;
  });

  test("a pcs line on a kg item shows the name size; confirming with it saves the party spec", async () => {
    const id = await newBill("sale");
    await database.db.insert(billLineItems).values({
      id: newId(),
      businessId,
      billId: id,
      position: 0,
      descriptionRaw: DESC,
      masterProductId: lime,
      quantity: "25",
      unit: "pcs",
      rate: "20",
      amount: "500",
    });
    const before = (await getJson(`/v1/bills/${id}`)).lines[0] as Json;
    expect(before.suggested_spec).toEqual({ pack_unit: "pcs", pack_qty: "10", pack_qty_unit: "g" });
    expect(before.suggested_spec_source).toBe("name");
    expect(before.stock_factor).toBeNull();

    const res = await confirm(id, "sale", kiranakart, [
      {
        desc: DESC,
        qty: "25",
        unit: "pcs",
        rate: "20",
        stockFactor: "0.01",
        saveSpec: true,
        packQtyUnit: "g",
        item: lime,
      },
    ]);
    expect(res.status).toBe(200);
    const view = (await res.json()) as Json;
    ids.kiranakart = view.vendor_id;
    expect(view.lines[0]).toMatchObject({
      stock_factor: "0.01",
      stock_qty: "0.250",
      suggested_spec: { pack_unit: "pcs", pack_qty: "10", pack_qty_unit: "g" },
      suggested_spec_source: "party",
    });
    const product = await productOf(ids.kiranakart as string);
    expect([product.pack_unit, product.pack_qty, product.pack_qty_unit]).toEqual([
      "pcs",
      "10",
      "g",
    ]);
  });

  test("the next Kiranakart bill shows the spec from the party", async () => {
    const view = await extract("sale", {
      seller: { name: "Samavaya", gstin: OWN_GSTIN },
      buyer: { name: "Kiranakart", gstin: null },
      date_iso: "2026-11-18",
      line_items: [{ description: DESC, quantity: "5", unit: "pcs", rate: "20", amount: "100" }],
      grand_total: "100",
    });
    expect(view.vendor_id).toBe(ids.kiranakart);
    expect(view.lines[0]).toMatchObject({
      master_product_id: lime,
      suggested_spec: { pack_unit: "pcs", pack_qty: "10", pack_qty_unit: "g" },
      suggested_spec_source: "party",
      stock_factor: "0.01",
      stock_factor_source: "customer",
    });
  });
});
