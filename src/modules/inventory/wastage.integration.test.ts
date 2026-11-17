// Wastage through the real routes and confirmBill, against the real Postgres (compose stack).
// The plan's example: buy 100 kg at 30, waste 2 kg, sell 8 kg at 45.
import { beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { testDatabase, testStorage } from "../../../test/setup";
import { createApp } from "../../app";
import type { Database } from "../../platform/db/client";
import { createLogger } from "../../platform/logger";
import { Metrics } from "../../platform/metrics";
import type { Queue } from "../../platform/queue";
import type { Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { signToken } from "../auth/tokens";
import { bills } from "../bills/bills.schema";
import { type ConfirmLine, confirmBill } from "../bills/bills.service";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { inventoryTransactions } from "./inventory.schema";
import { createMasterProduct, getMasterProduct } from "./inventory.service";

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
let storage: Storage;
let app: ReturnType<typeof createApp>;
let businessId: string;
let userId: string;
let headers: Record<string, string>;
const run = newId().slice(-6);
const deps = () => ({ database, storage: {} as Storage, queue: {} as Queue });

beforeAll(async () => {
  database = await testDatabase();
  storage = await testStorage();
  userId = newId();
  businessId = newId();
  await database.db
    .insert(users)
    .values({ id: userId, name: "Wastage", email: `waste-${userId}@test.local` });
  await database.db
    .insert(businesses)
    .values({ id: businessId, name: "Wastage Business", createdBy: userId });
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

const line = (masterProductId: string, qty: string, rate: string) =>
  ({
    description: "item",
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

async function confirm(type: "purchase" | "sale", date: string, lines: ConfirmLine[]) {
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
  return confirmBill(deps(), { businessId, userId }, id, {
    type,
    vendorId: null,
    vendorName: `Party ${run}`,
    invoiceNumber: `INV-${id.slice(-6)}`,
    billDate: date,
    lines,
    charges: [],
  });
}

const product = async (name: string) =>
  (
    await createMasterProduct(database.db, {
      businessId,
      displayName: `${name} ${run}`,
      standardUnit: "kg",
    })
  ).id;

const adjust = (id: string, body: Record<string, unknown>) =>
  app.request(`/v1/inventory/master-products/${id}/adjust`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

type Report = {
  summary: { value_lost: string; entries: number; uncosted_entries: number };
  items: Array<{
    master_product_id: string;
    name: string;
    unit: string;
    qty: string;
    value_lost: string;
    entries: number;
    uncosted_entries: number;
    by_reason: Array<{ reason: string; qty: string; value_lost: string }>;
  }>;
};

const report = async (qs: string): Promise<Report> => {
  const res = await app.request(`/v1/inventory/wastage${qs}`, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as Report;
};

describe("wastage", () => {
  test("the tomato example: stock 90, wastage 60.00, cost of sold stock 240.00", async () => {
    const tomato = await product("Tomato");
    await confirm("purchase", "2026-11-01", [line(tomato, "100", "30")]);

    const res = await adjust(tomato, {
      delta_weight: "-2",
      unit: "kg",
      kind: "wastage",
      reason: "spoiled",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      master_product: { current_stock_weight: string };
      adjustment: { valueDelta: string | null };
    };
    expect(body.master_product.current_stock_weight).toBe("98.000");
    expect(body.adjustment.valueDelta).toBe("-60.0000");

    const sold = await confirm("sale", "2026-11-02", [line(tomato, "8", "45")]);
    expect(sold.lines[0]?.cost_of_goods).toBe("240.00");
    expect(sold.lines[0]?.gross_profit).toBe("120.00");
    expect((await getMasterProduct(database.db, businessId, tomato)).current_stock_weight).toBe(
      "90.000",
    );

    const txs = await app.request(`/v1/inventory/master-products/${tomato}/transactions`, {
      headers,
    });
    const items = ((await txs.json()) as { items: Array<Record<string, unknown>> }).items;
    const waste = items.find((t) => t.transaction_type === "wastage");
    expect(waste?.reason).toBe("spoiled");
    expect(waste?.value_delta).toBe("-60.0000");
    expect(items.find((t) => t.transaction_type === "sale_out")?.reason).toBeNull();

    const r = await report("");
    expect(r.summary).toEqual({ value_lost: "60.00", entries: 1, uncosted_entries: 0 });
    expect(r.items).toEqual([
      {
        master_product_id: tomato,
        name: `Tomato ${run}`,
        unit: "kg",
        qty: "2.000",
        value_lost: "60.00",
        entries: 1,
        uncosted_entries: 0,
        by_reason: [{ reason: "spoiled", qty: "2.000", value_lost: "60.00" }],
      },
    ]);
  });

  test("validation: wastage must reduce; reason and kind are checked", async () => {
    const id = await product("Validate");
    for (const delta of ["5", "0", "0.000"]) {
      const res = await adjust(id, { delta_weight: delta, kind: "wastage" });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("wastage_must_reduce");
    }
    expect((await adjust(id, { delta_weight: "-1", kind: "wastage", reason: "lost" })).status).toBe(
      422,
    );
    expect((await adjust(id, { delta_weight: "-1", kind: "bogus" })).status).toBe(422);
    // a plain correction (the default kind) is not wastage
    expect((await adjust(id, { delta_weight: "5" })).status).toBe(200);
    expect((await report("")).items.some((i) => i.master_product_id === id)).toBe(false);
    // the reason defaults to spoiled; no cost known counts in qty and uncosted_entries only
    expect((await adjust(id, { delta_weight: "-1", kind: "wastage" })).status).toBe(200);
    const row = (await report("")).items.find((i) => i.master_product_id === id);
    expect(row?.by_reason[0]?.reason).toBe("spoiled");
    expect(row?.qty).toBe("1.000");
    expect(row?.value_lost).toBe("0.00");
    expect(row?.uncosted_entries).toBe(1);
  });

  test("date range is in IST days, both ends inclusive, sorted by value lost", async () => {
    const cheap = await product("Cheap");
    const dear = await product("Dear");
    await confirm("purchase", "2026-01-01", [line(cheap, "100", "10"), line(dear, "100", "100")]);

    // Records wastage now, then moves that one row to the given instant.
    const waste = async (id: string, qty: string, reason: string, at: string) => {
      const res = await adjust(id, { delta_weight: `-${qty}`, kind: "wastage", reason });
      expect(res.status).toBe(200);
      const [tx] = await database.db
        .select({ id: inventoryTransactions.id })
        .from(inventoryTransactions)
        .where(
          and(
            eq(inventoryTransactions.masterProductId, id),
            eq(inventoryTransactions.transactionType, "wastage"),
          ),
        )
        .orderBy(desc(inventoryTransactions.createdAt))
        .limit(1);
      await database.db
        .update(inventoryTransactions)
        .set({ createdAt: new Date(at) })
        .where(eq(inventoryTransactions.id, tx?.id as string));
    };
    // 10 Feb 2026 IST runs from 2026-02-09T18:30:00Z to 2026-02-10T18:29:59Z
    await waste(cheap, "3", "damaged", "2026-02-09T18:30:00Z"); // first instant of 10 Feb
    await waste(dear, "1", "expired", "2026-02-10T18:29:59Z"); // last instant of 10 Feb
    await waste(dear, "2", "theft", "2026-02-10T18:30:00Z"); // 11 Feb: outside
    await waste(cheap, "1", "spoiled", "2026-02-09T18:29:59Z"); // 9 Feb: outside

    const day = await report("?from=2026-02-10&to=2026-02-10");
    expect(day.summary).toEqual({ value_lost: "130.00", entries: 2, uncosted_entries: 0 });
    expect(day.items.map((i) => [i.name, i.qty, i.value_lost])).toEqual([
      [`Dear ${run}`, "1.000", "100.00"],
      [`Cheap ${run}`, "3.000", "30.00"],
    ]);
    expect(day.items[0]?.by_reason).toEqual([
      { reason: "expired", qty: "1.000", value_lost: "100.00" },
    ]);

    const wide = await report("?from=2026-02-09&to=2026-02-11");
    const ours = wide.items.filter((i) => [cheap, dear].includes(i.master_product_id));
    expect(ours.reduce((n, i) => n + i.entries, 0)).toBe(4);
    const dearWide = ours.find((i) => i.master_product_id === dear);
    expect(dearWide?.value_lost).toBe("300.00");
    expect(dearWide?.by_reason.map((b) => b.reason)).toEqual(["theft", "expired"]);

    expect(await report("?from=2026-03-01&to=2026-03-02")).toEqual({
      summary: { value_lost: "0.00", entries: 0, uncosted_entries: 0 },
      items: [],
    });
    expect((await app.request("/v1/inventory/wastage?from=10-02-2026", { headers })).status).toBe(
      422,
    );
  });

  test("in-stock list keeps negative stock; master list returns everything A-Z", async () => {
    const neg = await product("Zneg");
    const zero = await product("Azero");
    await confirm("sale", "2026-11-03", [line(neg, "5", "10")]);

    const stock = (await (await app.request("/v1/inventory", { headers })).json()) as {
      items: Array<{ id: string; current_stock_weight: string }>;
    };
    expect(stock.items.find((i) => i.id === neg)?.current_stock_weight).toBe("-5.000");
    expect(stock.items.some((i) => i.id === zero)).toBe(false);

    const all = (await (
      await app.request("/v1/inventory/master-products?limit=abc", { headers })
    ).json()) as { items: Array<{ id: string; display_name: string }> };
    expect(all.items.some((i) => i.id === zero)).toBe(true);
    expect(all.items.some((i) => i.id === neg)).toBe(true);
    const ids = all.items.map((i) => i.id);
    expect(ids.indexOf(zero)).toBeLessThan(ids.indexOf(neg));
  });
});
