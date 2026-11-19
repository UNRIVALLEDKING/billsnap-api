// Stock rebuilt in bill-date order (docs/BILL_ACCURACY_PLAN.md sections 2 and 7): confirm order does
// not matter, confirmed bills can be edited and deleted, and manual movements survive. Real Postgres
// (compose stack); confirm runs with stub storage and queue, edit and delete through the routes.
import { beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, inArray } from "drizzle-orm";
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
import { type ConfirmLine, confirmBill, getBill } from "../bills/bills.service";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { inventoryTransactions, masterProducts, stockLots } from "./inventory.schema";
import {
  createMasterProduct,
  getMasterProduct,
  listInventoryTransactions,
  listStockLots,
  recordStockIncrement,
} from "./inventory.service";
import { replayItems } from "./replay";

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
const deps = () => ({ database, storage: {} as Storage, queue: {} as Queue });

beforeAll(async () => {
  database = await testDatabase();
  const storage = await testStorage();
  userId = newId();
  businessId = newId();
  await database.db
    .insert(users)
    .values({ id: userId, name: "Replay", email: `replay-${userId}@test.local` });
  await database.db
    .insert(businesses)
    .values({ id: businessId, name: "Replay Business", createdBy: userId });
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

const product = async (name: string, initialStock?: string) =>
  (
    await createMasterProduct(database.db, {
      businessId,
      displayName: `${name} ${run}`,
      standardUnit: "kg",
      initialStock,
    })
  ).id;

const line = (masterProductId: string, qty: string, rate: string) =>
  ({
    description: `item ${masterProductId}`,
    productId: null,
    masterProductId,
    quantity: qty,
    unit: "kg",
    rate,
    discount: "0",
    printedAmount: null,
    hsnSac: null,
    gstRate: null,
    cgst: "0",
    sgst: "0",
    igst: "0",
    cess: "0",
    flags: [],
  }) satisfies ConfirmLine;

type BillSpec = { type: "purchase" | "sale"; date: string; lines: ConfirmLine[]; fees?: string[] };

const input = (id: string, o: BillSpec) => ({
  type: o.type,
  vendorId: null,
  vendorName: `${o.type === "purchase" ? "Mandi" : "Customer"} ${run}`,
  invoiceNumber: `INV-${id.slice(-6)}`,
  billDate: o.date,
  lines: o.lines,
  charges: (o.fees ?? []).map((amount, i) => ({ id: `fee-${i}`, label: `Fee ${i}`, amount })),
});

async function newBill(type: "purchase" | "sale") {
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

async function confirm(o: BillSpec) {
  const id = await newBill(o.type);
  return confirmBill(deps(), { businessId, userId }, id, input(id, o));
}

/** The confirm/edit JSON body, as the app sends it. */
const body = (id: string, o: BillSpec) => {
  const i = input(id, o);
  return {
    type: i.type,
    vendor_id: null,
    vendor_name: i.vendorName,
    invoice_number: i.invoiceNumber,
    bill_date: i.billDate,
    lines: i.lines.map((l) => ({
      description: l.description,
      product_id: null,
      master_product_id: l.masterProductId,
      quantity: l.quantity,
      unit: l.unit,
      rate: l.rate,
      discount: l.discount,
      printed_amount: null,
      hsn_sac: null,
      gst_rate: null,
      cgst: "0",
      sgst: "0",
      igst: "0",
      cess: "0",
      flags: [],
    })),
    charges: i.charges.map((c) => ({ label: c.label, amount: c.amount })),
  };
};

const edit = (id: string, o: BillSpec) =>
  app.request(`/v1/bills/${id}`, { method: "PUT", headers, body: JSON.stringify(body(id, o)) });
const discard = (id: string) =>
  app.request(`/v1/bills/${id}/discard`, { method: "POST", headers, body: "{}" });
const adjust = (id: string, payload: Record<string, unknown>) =>
  app.request(`/v1/inventory/master-products/${id}/adjust`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
const saleLine = async (billId: string) => (await getBill(deps(), businessId, billId)).lines[0];
const item = (id: string) => getMasterProduct(database.db, businessId, id);
const stockOf = async (id: string) => {
  const p = await item(id);
  return [p.current_stock_weight, p.avg_cost, p.stock_value, p.last_landed_cost];
};
const ledger = async (id: string) =>
  (await listInventoryTransactions(database.db, businessId, id)).map((t) => [
    t.transaction_type,
    t.bill_date,
    t.delta_weight,
    t.resulting_stock_weight,
    t.unit_cost,
    t.value_delta,
  ]);

/** Every stored row replay writes for these items, to compare two replays. */
async function snapshot(ids: string[]) {
  const txs = await database.db
    .select()
    .from(inventoryTransactions)
    .where(inArray(inventoryTransactions.masterProductId, ids))
    .orderBy(asc(inventoryTransactions.id));
  const lots = await database.db
    .select()
    .from(stockLots)
    .where(inArray(stockLots.masterProductId, ids))
    .orderBy(asc(stockLots.id));
  const items = (
    await database.db
      .select()
      .from(masterProducts)
      .where(inArray(masterProducts.id, ids))
      .orderBy(asc(masterProducts.id))
  ).map(({ updatedAt: _, ...rest }) => rest);
  const lines = await database.db
    .select({
      id: billLineItems.id,
      costOfGoods: billLineItems.costOfGoods,
      grossProfit: billLineItems.grossProfit,
      goodsValue: billLineItems.goodsValue,
    })
    .from(billLineItems)
    .where(inArray(billLineItems.masterProductId, ids))
    .orderBy(asc(billLineItems.id));
  return JSON.parse(JSON.stringify({ txs, lots, items, lines }));
}

const replay = (ids: string[]) => database.tx(({ db }) => replayItems(db, businessId, ids));

describe("replay", () => {
  test("confirm order does not matter: a 16 Nov sale confirmed after an 18 Nov purchase", async () => {
    const inOrder = await product("InOrder");
    const late = await product("LateSale");

    // Same three bills for both items; only the confirm order differs.
    const buy15 = (id: string) => ({
      type: "purchase" as const,
      date: "2026-11-15",
      lines: [line(id, "100", "30")],
    });
    const sell16 = (id: string) => ({
      type: "sale" as const,
      date: "2026-11-16",
      lines: [line(id, "20", "50")],
    });
    const buy18 = (id: string) => ({
      type: "purchase" as const,
      date: "2026-11-18",
      lines: [line(id, "50", "40")],
    });

    await confirm(buy15(inOrder));
    const saleA = await confirm(sell16(inOrder));
    await confirm(buy18(inOrder));

    await confirm(buy15(late));
    await confirm(buy18(late));
    const saleB = await confirm(sell16(late));

    // The sale is valued at the 16 Nov average (30), not the blended 18 Nov one.
    for (const sale of [saleA, saleB]) {
      expect(sale.lines[0]?.cost_of_goods).toBe("600.00");
      expect(sale.lines[0]?.gross_profit).toBe("400.00");
    }
    expect((await saleLine(saleA.id))?.cost_of_goods).toBe("600.00");
    // (80 x 30 + 2000) / 130
    expect(await stockOf(inOrder)).toEqual(["130.000", "33.8462", "4400.01", "40.0000"]);
    expect(await stockOf(late)).toEqual(await stockOf(inOrder));
    expect(await ledger(late)).toEqual(await ledger(inOrder));
    expect(await ledger(late)).toEqual([
      ["purchase_in", "2026-11-18", "50.000", "130.000", "40.0000", "2000.0000"],
      ["sale_out", "2026-11-16", "-20.000", "80.000", "30.0000", "-600.0000"],
      ["purchase_in", "2026-11-15", "100.000", "100.000", "30.0000", "3000.0000"],
    ]);
    const lots = async (id: string) =>
      (await listStockLots(database.db, businessId, id, {})).map((l) => [
        l.received_on,
        l.remaining_qty,
      ]);
    expect(await lots(late)).toEqual([
      ["2026-11-18", "50.000"],
      ["2026-11-15", "80.000"],
    ]);
    expect(await lots(late)).toEqual(await lots(inOrder));
  });

  test("a sale dated before any purchase stays uncosted in either order", async () => {
    const corn = await product("BabyCorn");
    const sale = await confirm({
      type: "sale",
      date: "2026-11-16",
      lines: [line(corn, "20", "120")],
    });
    await confirm({ type: "purchase", date: "2026-11-18", lines: [line(corn, "90", "100")] });
    expect((await saleLine(sale.id))?.cost_of_goods).toBeNull();
    expect(await stockOf(corn)).toEqual(["70.000", "100.0000", "7000.00", "100.0000"]);
    expect((await item(corn)).unknown_cost_sales).toBe(1);
  });

  test("editing a past purchase re-costs a later sale; history records the diff", async () => {
    const onion = await product("Onion");
    const bought = await confirm({
      type: "purchase",
      date: "2026-11-01",
      lines: [line(onion, "100", "30")],
    });
    const sold = await confirm({
      type: "sale",
      date: "2026-11-02",
      lines: [line(onion, "10", "50")],
    });
    expect(sold.lines[0]?.cost_of_goods).toBe("300.00");
    expect(sold.lines[0]?.gross_profit).toBe("200.00");

    const res = await edit(bought.id, {
      type: "purchase",
      date: "2026-11-01",
      lines: [line(onion, "100", "40")],
    });
    expect(res.status).toBe(200);
    const edited = (await res.json()) as { status: string; lines: Array<Record<string, string>> };
    expect(edited.status).toBe("confirmed");
    expect(edited.lines[0]?.landed_unit_cost).toBe("40.0000");

    expect((await saleLine(sold.id))?.cost_of_goods).toBe("400.00");
    expect((await saleLine(sold.id))?.gross_profit).toBe("100.00");
    expect(await stockOf(onion)).toEqual(["90.000", "40.0000", "3600.00", "40.0000"]);

    const history = (await (
      await app.request(`/v1/bills/${bought.id}/history`, { headers })
    ).json()) as { items: Array<{ action: string; diff: Record<string, unknown> }> };
    const entry = history.items.at(-1);
    expect(entry?.action).toBe("edited");
    expect(entry?.diff).toMatchObject({
      fields: {},
      totals: { before: { total: "3000.00" }, after: { total: "4000.00" } },
      lines: {
        added: [],
        removed: [],
        changed: [{ before: { rate: "30.0000" }, after: { rate: "40.0000" } }],
      },
    });

    // Moving the sale's line to another item replays both items.
    const garlic = await product("Garlic");
    await confirm({ type: "purchase", date: "2026-11-01", lines: [line(garlic, "50", "100")] });
    const moved = await edit(sold.id, {
      type: "sale",
      date: "2026-11-02",
      lines: [line(garlic, "10", "150")],
    });
    expect(moved.status).toBe(200);
    expect((await item(onion)).current_stock_weight).toBe("100.000");
    expect((await item(garlic)).current_stock_weight).toBe("40.000");
    expect((await saleLine(sold.id))?.gross_profit).toBe("500.00");
  });

  test("only confirmed bills can be edited", async () => {
    const id = await newBill("purchase");
    const pea = await product("Pea");
    const res = await edit(id, {
      type: "purchase",
      date: "2026-11-01",
      lines: [line(pea, "1", "1")],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("wrong_status");
  });

  test("deleting confirmed bills undoes their stock and re-costs later sales", async () => {
    const apple = await product("Apple");
    const a = await confirm({
      type: "purchase",
      date: "2026-11-01",
      lines: [line(apple, "100", "30")],
    });
    await confirm({ type: "purchase", date: "2026-11-03", lines: [line(apple, "100", "50")] });
    const sale = await confirm({
      type: "sale",
      date: "2026-11-05",
      lines: [line(apple, "50", "60")],
    });
    expect(sale.lines[0]?.cost_of_goods).toBe("2000.00");
    expect((await item(apple)).current_stock_weight).toBe("150.000");

    expect((await discard(a.id)).status).toBe(204);
    expect((await getBill(deps(), businessId, a.id)).status).toBe("discarded");
    expect((await saleLine(sale.id))?.cost_of_goods).toBe("2500.00");
    expect((await saleLine(sale.id))?.gross_profit).toBe("500.00");
    expect(await stockOf(apple)).toEqual(["50.000", "50.0000", "2500.00", "50.0000"]);
    expect(
      (await listStockLots(database.db, businessId, apple, {})).map((l) => l.remaining_qty),
    ).toEqual(["50.000"]);
    const history = (await (
      await app.request(`/v1/bills/${a.id}/history`, { headers })
    ).json()) as { items: Array<{ action: string; diff: Record<string, unknown> }> };
    expect(history.items.at(-1)).toMatchObject({
      action: "removed",
      diff: { total: "3000.00", lineCount: 1 },
    });

    // Deleting the sale gives its stock back; a second discard is a no-op.
    expect((await discard(sale.id)).status).toBe(204);
    expect((await discard(sale.id)).status).toBe(204);
    expect((await item(apple)).current_stock_weight).toBe("100.000");
    expect((await item(apple)).unknown_cost_sales).toBe(0);

    // Restore sends a once-confirmed bill back to review; it counts again only when re-confirmed.
    const restored = await app.request(`/v1/bills/${a.id}/restore`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(((await restored.json()) as { status: string }).status).toBe("needs_review");
    expect((await item(apple)).current_stock_weight).toBe("100.000");
    await confirmBill(
      deps(),
      { businessId, userId },
      a.id,
      input(a.id, { type: "purchase", date: "2026-11-01", lines: [line(apple, "100", "30")] }),
    );
    expect(await stockOf(apple)).toEqual(["200.000", "40.0000", "8000.00", "50.0000"]);
  });

  test("wastage, corrections and stock at creation survive replay with ids, reasons and notes", async () => {
    const tomato = await product("TomatoR", "10");
    await confirm({ type: "purchase", date: "2026-11-01", lines: [line(tomato, "100", "30")] });
    expect(
      (await adjust(tomato, { delta_weight: "-2", kind: "wastage", reason: "damaged" })).status,
    ).toBe(200);
    expect((await adjust(tomato, { delta_weight: "5", note: "Found a crate" })).status).toBe(200);

    const manual = () =>
      database.db
        .select({
          id: inventoryTransactions.id,
          type: inventoryTransactions.transactionType,
          delta: inventoryTransactions.deltaWeight,
          note: inventoryTransactions.note,
          reason: inventoryTransactions.reason,
          createdAt: inventoryTransactions.createdAt,
        })
        .from(inventoryTransactions)
        .where(
          and(
            eq(inventoryTransactions.masterProductId, tomato),
            inArray(inventoryTransactions.transactionType, ["manual_adjustment", "wastage"]),
          ),
        )
        .orderBy(asc(inventoryTransactions.id));
    const before = await manual();
    expect(before.length).toBe(3);

    // A back-dated sale replays the item: it goes before today's wastage and corrections.
    const sale = await confirm({
      type: "sale",
      date: "2026-11-02",
      lines: [line(tomato, "8", "45")],
    });
    expect(sale.lines[0]?.cost_of_goods).toBe("240.00");
    expect(await manual()).toEqual(before);
    await replay([tomato]);
    expect(await manual()).toEqual(before);

    // 10 at creation (uncosted, valued at the then-unknown average) + 100 - 8 - 2 + 5.
    expect((await item(tomato)).current_stock_weight).toBe("105.000");
    const txs = await listInventoryTransactions(database.db, businessId, tomato);
    const waste = txs.find((t) => t.transaction_type === "wastage");
    expect(waste?.reason).toBe("damaged");
    expect(waste?.value_delta).toBe("-60.0000");
    expect(txs.find((t) => t.note === "Found a crate")?.value_delta).toBe("150.0000");

    const report = (await (await app.request("/v1/inventory/wastage", { headers })).json()) as {
      items: Array<{ master_product_id: string; value_lost: string; by_reason: unknown }>;
    };
    const row = report.items.find((i) => i.master_product_id === tomato);
    expect(row?.value_lost).toBe("60.00");
    expect(row?.by_reason).toEqual([{ reason: "damaged", qty: "2.000", value_lost: "60.00" }]);
  });

  test("seeded opening stock at a cost keeps its lot and cost", async () => {
    const mango = await product("Mango");
    const opening = await database.tx(({ db }) =>
      recordStockIncrement(db, {
        businessId,
        masterProductId: mango,
        deltaQuantity: "50",
        quantityUnit: "kg",
        type: "manual_adjustment",
        note: "Opening stock (seed)",
        cost: { goods: "1500.00", fees: "75.00" },
        receivedOn: "2026-11-10",
      }),
    );
    await confirm({ type: "purchase", date: "2026-11-12", lines: [line(mango, "50", "40")] });
    await confirm({ type: "sale", date: "2026-11-13", lines: [line(mango, "60", "60")] });
    await replay([mango]);

    // (50 x 31.5 + 2000) / 100
    expect(await stockOf(mango)).toEqual(["40.000", "35.7500", "1430.00", "40.0000"]);
    const lots = await listStockLots(database.db, businessId, mango, {});
    expect(lots.map((l) => [l.received_on, l.remaining_qty, l.landed_unit_cost])).toEqual([
      ["2026-11-12", "40.000", "40.0000"],
      ["2026-11-10", "0.000", "31.5000"],
    ]);
    expect(lots[1]?.id).toBe(opening.lotId as string);
    expect([lots[1]?.base_unit_cost, lots[1]?.fees_per_unit]).toEqual(["30.0000", "1.5000"]);
    const [row] = await database.db
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.lotId, opening.lotId as string));
    expect([row?.note, row?.unitCost, row?.valueDelta, row?.billId]).toEqual([
      "Opening stock (seed)",
      "31.5000",
      "1575.0000",
      null,
    ]);
  });

  test("replaying twice writes identical rows", async () => {
    const leek = await product("Leek", "4");
    const okra = await product("Okra");
    await confirm({
      type: "purchase",
      date: "2026-11-03",
      lines: [line(leek, "40", "25"), line(okra, "30", "60"), line(leek, "10", "27")],
      fees: ["90.00"],
    });
    await confirm({ type: "sale", date: "2026-11-02", lines: [line(leek, "5", "40")] });
    await confirm({
      type: "sale",
      date: "2026-11-04",
      lines: [line(leek, "20", "40"), line(okra, "12", "80")],
      fees: ["10.00"],
    });
    await adjust(okra, { delta_weight: "-1.5", kind: "wastage", reason: "spoiled" });

    await replay([leek, okra]);
    const first = await snapshot([leek, okra]);
    const again = await replay([okra, leek, okra]);
    expect(again.salesRecosted).toBe(0);
    expect(await snapshot([leek, okra])).toEqual(first);
    expect(first.txs.length).toBe(8);
  });
});
