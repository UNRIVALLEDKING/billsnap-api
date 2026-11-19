// Units and pack sizes (docs/BILL_ACCURACY_PLAN.md section 3): a unit with no factor is never passed
// through, saved factors convert, pack sizes are learned from bills, and an item's unit can change when
// its history converts. Real Postgres (compose stack), through the routes.
import { beforeAll, describe, expect, test } from "bun:test";
import { testDatabase, testStorage } from "../../../test/setup";
import { createApp } from "../../app";
import type { Database } from "../../platform/db/client";
import { createLogger } from "../../platform/logger";
import { Metrics } from "../../platform/metrics";
import type { Queue } from "../../platform/queue";
import { newId } from "../../shared/ids";
import { signToken } from "../auth/tokens";
import { bills } from "../bills/bills.schema";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { createMasterProduct, listInventoryTransactions } from "./inventory.service";

const SECRET = "t".repeat(40);
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
const run = newId().slice(-6);

beforeAll(async () => {
  database = await testDatabase();
  const storage = await testStorage();
  userId = newId();
  businessId = newId();
  await database.db
    .insert(users)
    .values({ id: userId, name: "Units", email: `units-${userId}@test.local` });
  await database.db
    .insert(businesses)
    .values({ id: businessId, name: "Units Business", createdBy: userId });
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
});

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
type Json = any;

const item = async (name: string, unit: string) =>
  (
    await createMasterProduct(database.db, {
      businessId,
      displayName: `${name} ${run}`,
      standardUnit: unit,
    })
  ).id;

type Line = {
  item: string;
  qty: string;
  unit: string;
  rate: string;
  packs?: string;
  packUnit?: string;
};

async function newBill(type: "purchase" | "sale" = "purchase") {
  const id = newId();
  await database.db.insert(bills).values({
    id,
    businessId,
    clientRef: newId(),
    type,
    status: "needs_review",
    source: "camera",
    uploadedBy: userId,
    droppedAt: new Date(),
  });
  return id;
}

const body = (lines: Line[], date = "2026-11-18") => ({
  type: "purchase",
  vendor_id: null,
  vendor_name: `Krishna ${run}`,
  invoice_number: `U-${newId().slice(-6)}`,
  bill_date: date,
  lines: lines.map((l) => ({
    description: `line ${l.item} ${l.unit}`,
    product_id: null,
    master_product_id: l.item,
    quantity: l.qty,
    unit: l.unit,
    rate: l.rate,
    discount: "0",
    printed_amount: null,
    hsn_sac: null,
    gst_rate: null,
    cgst: "0",
    sgst: "0",
    igst: "0",
    cess: "0",
    flags: [],
    ...(l.packs ? { pack_count: l.packs, pack_unit: l.packUnit ?? "box" } : {}),
  })),
  charges: [],
});

const confirm = (id: string, lines: Line[], date?: string) =>
  app.request(`/v1/bills/${id}/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify(body(lines, date)),
  });
const getItem = async (id: string): Promise<Json> =>
  ((await (await app.request(`/v1/inventory/master-products/${id}`, { headers })).json()) as Json)
    .master_product;
const putUnit = (id: string, unit: string, payload: Record<string, unknown>) =>
  app.request(`/v1/inventory/master-products/${id}/units/${unit}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });
const patchItem = (id: string, payload: Record<string, unknown>) =>
  app.request(`/v1/inventory/master-products/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(payload),
  });

describe("unit conversion at confirm", () => {
  test("a box line on a pcs item asks for a factor (422) and changes nothing", async () => {
    const corn = await item("Baby corn", "pcs");
    const billId = await newBill();
    const res = await confirm(billId, [{ item: corn, qty: "2", unit: "box", rate: "4050" }]);
    expect(res.status).toBe(422);
    const problem = (await res.json()) as Json;
    expect(problem.code).toBe("unit_conversion_needed");
    expect(problem.lines).toEqual([
      {
        index: 0,
        bill_id: billId,
        item_id: corn,
        item_name: `Baby corn ${run}`,
        from_unit: "box",
        to_unit: "pcs",
        // The party is named (docs/CUSTOMER_SPECS_PLAN.md B7); new on this bill, so no ids yet.
        party_id: null,
        party_name: `Krishna ${run}`,
        product_id: null,
      },
    ]);
    const bill = (await (await app.request(`/v1/bills/${billId}`, { headers })).json()) as Json;
    expect(bill.status).toBe("needs_review");
    expect((await getItem(corn)).current_stock_weight).toBe("0.000");

    // Saving "1 box = 45 pcs" lets the same bill confirm: 2 box -> 90 pcs.
    const saved = await putUnit(corn, "box", { per_unit: "45" });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Json).master_product.units).toEqual([
      { unit: "box", per_unit: "45", approx: false, source: "user" },
    ]);
    const ok = await confirm(billId, [{ item: corn, qty: "2", unit: "box", rate: "4050" }]);
    expect(ok.status).toBe(200);
    const after = await getItem(corn);
    expect(after.current_stock_weight).toBe("90.000");
    expect(after.avg_cost).toBe("90.0000");
    // No kg factor yet, so no approximate weight.
    expect(after.approx_kg).toBeNull();

    // 1 kg is about 5 packets: stock reads 90 pcs, about 18 kg.
    await putUnit(corn, "kg", { per_unit: "5", approx: true });
    expect((await getItem(corn)).approx_kg).toBe("18.000");

    // The factor is in use by a confirmed bill: it can't be removed; an unused one can.
    const del = await app.request(`/v1/inventory/master-products/${corn}/units/box`, {
      method: "DELETE",
      headers,
    });
    expect(del.status).toBe(409);
    expect(((await del.json()) as Json).code).toBe("unit_in_use");
    const delKg = await app.request(`/v1/inventory/master-products/${corn}/units/kg`, {
      method: "DELETE",
      headers,
    });
    expect(delKg.status).toBe(200);
    expect(((await delKg.json()) as Json).master_product.units.map((u: Json) => u.unit)).toEqual([
      "box",
    ]);
  });

  test("a built-in unit needs no factor", async () => {
    const onion = await item("Onion", "kg");
    const res = await putUnit(onion, "g", { per_unit: "0.001" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Json).code).toBe("unit_builtin");
  });

  test("a pack size is learned from a purchase and never replaces the user's", async () => {
    const cucumber = await item("Cucumber", "kg");
    const first = await confirm(await newBill(), [
      { item: cucumber, qty: "150", unit: "kg", rate: "45", packs: "4" },
    ]);
    expect(first.status).toBe(200);
    const line = ((await first.json()) as Json).lines[0];
    expect([line.pack_count, line.pack_unit]).toEqual(["4.000", "box"]);
    expect((await getItem(cucumber)).units).toEqual([
      { unit: "box", per_unit: "37.5", approx: true, source: "suggested" },
    ]);

    // A later bill updates a suggestion...
    await confirm(await newBill(), [
      { item: cucumber, qty: "160", unit: "kg", rate: "45", packs: "4" },
    ]);
    expect((await getItem(cucumber)).units[0].per_unit).toBe("40");

    // ...but not a size the user set.
    await putUnit(cucumber, "box", { per_unit: "38", approx: true });
    await confirm(await newBill(), [
      { item: cucumber, qty: "100", unit: "kg", rate: "45", packs: "4" },
    ]);
    expect((await getItem(cucumber)).units).toEqual([
      { unit: "box", per_unit: "38", approx: true, source: "user" },
    ]);
  });
});

describe("changing an item's unit", () => {
  test("allowed when the history converts; stock, cost and factors follow", async () => {
    const paneer = await item("Paneer", "kg");
    expect(
      (await confirm(await newBill(), [{ item: paneer, qty: "10", unit: "kg", rate: "100" }]))
        .status,
    ).toBe(200);
    await app.request(`/v1/inventory/master-products/${paneer}/adjust`, {
      method: "POST",
      headers,
      body: JSON.stringify({ delta_weight: "-0.5", unit: "kg", kind: "wastage" }),
    });

    // kg -> g is built in: the purchase and the manual wastage are re-counted in g.
    const toG = await patchItem(paneer, { standard_unit: "g" });
    expect(toG.status).toBe(200);
    const g = ((await toG.json()) as Json).master_product;
    expect([g.standard_unit, g.current_stock_weight, g.avg_cost, g.stock_value]).toEqual([
      "g",
      "9500.000",
      "0.1000",
      "950.00",
    ]);
    const ledger = await listInventoryTransactions(database.db, businessId, paneer);
    expect(
      ledger.map((t) => [t.transaction_type, t.delta_weight, t.resulting_stock_weight]),
    ).toEqual([
      ["wastage", "-500.000", "9500.000"],
      ["purchase_in", "10000.000", "10000.000"],
    ]);

    // pcs: nothing says how many g a piece is.
    const locked = await patchItem(paneer, { standard_unit: "pcs" });
    expect(locked.status).toBe(409);
    const problem = (await locked.json()) as Json;
    expect(problem.code).toBe("unit_locked");
    expect(problem.units).toEqual(["g", "kg"]);

    // With 1 pcs = 250 g it converts: 9500 g -> 38 pcs, and g becomes one of its units.
    await putUnit(paneer, "pcs", { per_unit: "250" });
    const toPcs = await patchItem(paneer, { standard_unit: "pcs" });
    expect(toPcs.status).toBe(200);
    const pcs = ((await toPcs.json()) as Json).master_product;
    expect([pcs.standard_unit, pcs.current_stock_weight, pcs.avg_cost, pcs.approx_kg]).toEqual([
      "pcs",
      "38.000",
      "25.0000",
      "9.500",
    ]);
    expect(pcs.units).toEqual([{ unit: "g", per_unit: "0.004", approx: false, source: "user" }]);
  });
});
