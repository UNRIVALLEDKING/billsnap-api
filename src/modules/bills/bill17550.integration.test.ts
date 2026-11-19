// Bill #17550 (Krishna Fruits & Vegetables, 18 Nov 2026) end to end, as docs/BILL_ACCURACY_PLAN.md
// sections 1 and 4 to 6 describe it: fees shared by boxes, baby corn counted in pcs. Real Postgres
// (compose stack), through the routes.
import { beforeAll, describe, expect, test } from "bun:test";
import { testDatabase, testStorage } from "../../../test/setup";
import { createApp } from "../../app";
import type { Database } from "../../platform/db/client";
import { createLogger } from "../../platform/logger";
import { Metrics } from "../../platform/metrics";
import type { Queue } from "../../platform/queue";
import { newId } from "../../shared/ids";
import { signToken } from "../auth/tokens";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { createMasterProduct } from "../inventory/inventory.service";
import { bills } from "./bills.schema";

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

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
type Json = any;

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
    .values({ id: userId, name: "Bill 17550", email: `b17550-${userId}@test.local` });
  await database.db
    .insert(businesses)
    .values({ id: businessId, name: "Bill 17550 Business", createdBy: userId });
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

const item = async (name: string, unit: string) =>
  (
    await createMasterProduct(database.db, {
      businessId,
      displayName: `${name} ${run}`,
      standardUnit: unit,
    })
  ).id;

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

type Line = {
  name: string;
  item: string | null;
  qty: string;
  unit: string;
  rate: string;
  packs?: string;
  kind?: "goods" | "credit";
  inStock?: boolean;
};

const lineBody = (l: Line) => ({
  description: l.name,
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
  ...(l.packs ? { pack_count: l.packs, pack_unit: "box" } : {}),
  ...(l.kind ? { line_kind: l.kind } : {}),
  ...(l.inStock === undefined ? {} : { credit_in_stock: l.inStock }),
});

const post = (path: string, payload: unknown) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(payload) });
const getItem = async (id: string): Promise<Json> =>
  ((await (await app.request(`/v1/inventory/master-products/${id}`, { headers })).json()) as Json)
    .master_product;

let items: Record<string, string>;

beforeAll(async () => {
  items = {
    cucumber: await item("E cucumber", "kg"),
    green: await item("Green lettuce", "kg"),
    iceberg: await item("Iceberg", "kg"),
    red: await item("Red lettuce", "kg"),
    celery: await item("Celery", "kg"),
    capsicum: await item("Capsicum", "kg"),
    corn: await item("Baby corn", "pcs"),
    guava: await item("Guava", "pcs"),
    mamey: await item("Mamey", "pcs"),
    imli: await item("Imli 250g", "pcs"),
  };
  // The station charge's fee type shares it by boxes; the ice box charge says so itself.
  const fee = await post("/v1/fees", {
    name: "Station charge",
    category: "transport",
    default_basis: "packs",
  });
  expect(fee.status).toBe(201);
});

const goods17550 = (): Line[] => [
  {
    name: "E cucumber",
    item: items.cucumber as string,
    qty: "150",
    unit: "kg",
    rate: "45",
    packs: "4",
  },
  {
    name: "Green lettuce",
    item: items.green as string,
    qty: "78",
    unit: "kg",
    rate: "70",
    packs: "4",
  },
  { name: "Iceberg", item: items.iceberg as string, qty: "70", unit: "kg", rate: "90", packs: "2" },
  {
    name: "Red lettuce",
    item: items.red as string,
    qty: "21",
    unit: "kg",
    rate: "120",
    packs: "1",
  },
  { name: "Celery", item: items.celery as string, qty: "20", unit: "kg", rate: "80", packs: "1" },
  {
    name: "Capsicum",
    item: items.capsicum as string,
    qty: "40",
    unit: "kg",
    rate: "130",
    packs: "2",
  },
  { name: "Baby corn", item: items.corn as string, qty: "90", unit: "pcs", rate: "90", packs: "2" },
  { name: "Guava", item: items.guava as string, qty: "1", unit: "pcs", rate: "150" },
  { name: "Mamey", item: items.mamey as string, qty: "1", unit: "pcs", rate: "280" },
  { name: "Imli 250g", item: items.imli as string, qty: "1", unit: "pcs", rate: "200" },
];

const confirmBody = (lines: Line[], extra: Record<string, unknown> = {}) => ({
  type: "purchase",
  vendor_id: null,
  vendor_name: `Krishna Fruits & Vegetables ${run}`,
  invoice_number: `17550-${newId().slice(-4)}`,
  bill_date: "2026-11-18",
  lines: lines.map(lineBody),
  charges: [
    { label: "Ice box", amount: "3000.00", basis: "packs" },
    { label: "Station charge", amount: "10400.00" },
  ],
  ...extra,
});

describe("bill #17550 by boxes", () => {
  test("fees follow the 16 boxes; baby corn lands at 108.6111 per pcs", async () => {
    const res = await post(`/v1/bills/${await newBill()}/confirm`, confirmBody(goods17550()));
    expect(res.status).toBe(200);
    const bill = (await res.json()) as Json;
    expect(bill.fee_split_basis).toBe("weight");
    expect(bill.charges.map((c: Json) => [c.label, c.amount, c.basis])).toEqual([
      ["Ice box", "3000.00", "packs"],
      ["Station charge", "10400.00", "packs"],
    ]);
    expect(
      bill.lines.map((l: Json) => [
        l.description,
        l.pack_count,
        l.allocated_fees,
        l.landed_unit_cost,
      ]),
    ).toEqual([
      ["E cucumber", "4.000", "3350.00", "67.3333"],
      ["Green lettuce", "4.000", "3350.00", "112.9487"],
      ["Iceberg", "2.000", "1675.00", "113.9286"],
      ["Red lettuce", "1.000", "837.50", "159.8810"],
      ["Celery", "1.000", "837.50", "121.8750"],
      ["Capsicum", "2.000", "1675.00", "171.8750"],
      ["Baby corn", "2.000", "1675.00", "108.6111"],
      ["Guava", null, "0.00", "150.0000"],
      ["Mamey", null, "0.00", "280.0000"],
      ["Imli 250g", null, "0.00", "200.0000"],
    ]);
    const corn = bill.lines[6];
    expect([corn.quantity, corn.unit, corn.goods_value, corn.landed_cost]).toEqual([
      "90.000",
      "pcs",
      "8100.00",
      "9775.00",
    ]);

    const stock = await getItem(items.corn as string);
    expect([stock.standard_unit, stock.current_stock_weight, stock.avg_cost]).toEqual([
      "pcs",
      "90.000",
      "108.6111",
    ]);
    // Pack sizes learned from the bill.
    expect(stock.units).toEqual([
      { unit: "box", per_unit: "45", approx: true, source: "suggested" },
    ]);
    expect((await getItem(items.cucumber as string)).units).toEqual([
      { unit: "box", per_unit: "37.5", approx: true, source: "suggested" },
    ]);
  });
});

describe("credits from an earlier bill (Less Broccoli 27 x 70)", () => {
  const broccoliStock = async (name: string) => {
    const id = await item(name, "kg");
    // Bought earlier at 60/kg, no fees.
    const res = await post(`/v1/bills/${await newBill()}/confirm`, {
      ...confirmBody([{ name, item: id, qty: "50", unit: "kg", rate: "60" }]),
      bill_date: "2026-11-10",
      charges: [],
    });
    expect(res.status).toBe(200);
    return id;
  };
  const less = (id: string, inStock?: boolean): Line => ({
    name: "Broccoli",
    item: id,
    qty: "27",
    unit: "kg",
    rate: "70",
    kind: "credit",
    ...(inStock === undefined ? {} : { inStock }),
  });
  const ledger = async (id: string) =>
    (
      (await (
        await app.request(`/v1/inventory/master-products/${id}/transactions`, { headers })
      ).json()) as Json
    ).items.map((t: Json) => [t.transaction_type, t.delta_weight, t.value_delta]);

  test("in stock: payable 48070.00, broccoli goes back at its average cost", async () => {
    const broccoli = await broccoliStock("Broccoli");
    const billId = await newBill();
    const res = await post(
      `/v1/bills/${billId}/confirm`,
      confirmBody([...goods17550(), less(broccoli)], { discount_total: "0" }),
    );
    expect(res.status).toBe(200);
    const bill = (await res.json()) as Json;
    expect([bill.confirmed_total, bill.discount_total]).toEqual(["48070.00", "0.00"]);
    // The credit takes no fees: baby corn still lands at 108.6111 per pcs.
    expect(bill.lines[6].landed_unit_cost).toBe("108.6111");
    const credit = bill.lines[10];
    expect([
      credit.line_kind,
      credit.credit_in_stock,
      credit.amount,
      credit.allocated_fees,
      credit.landed_cost,
      credit.credit_result,
    ]).toEqual(["credit", true, "1890.00", null, null, "270.00"]); // 1890 - 27 x 60
    expect(bill.lines[0].line_kind).toBe("goods");

    expect((await getItem(broccoli)).current_stock_weight).toBe("23.000");
    expect(await ledger(broccoli)).toEqual([
      ["purchase_return", "-27.000", "-1620.0000"],
      ["purchase_in", "50.000", "3000.0000"],
    ]);

    // Edited to "not in stock": the stock comes back and the whole credit is recovered.
    const edited = await app.request(`/v1/bills/${billId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(confirmBody([...goods17550(), less(broccoli, false)])),
    });
    expect(edited.status).toBe(200);
    const after = (await edited.json()) as Json;
    expect([after.confirmed_total, after.lines[10].credit_result]).toEqual(["48070.00", "1890.00"]);
    expect((await getItem(broccoli)).current_stock_weight).toBe("50.000");
  });

  test("not in stock: no stock move, credit_result is the whole 1890.00", async () => {
    const broccoli = await broccoliStock("Broccoli kept");
    const res = await post(
      `/v1/bills/${await newBill()}/confirm`,
      confirmBody([...goods17550(), less(broccoli, false)]),
    );
    expect(res.status).toBe(200);
    const bill = (await res.json()) as Json;
    expect(bill.confirmed_total).toBe("48070.00");
    expect([bill.lines[10].credit_in_stock, bill.lines[10].credit_result]).toEqual([
      false,
      "1890.00",
    ]);
    expect((await getItem(broccoli)).current_stock_weight).toBe("50.000");
    expect(await ledger(broccoli)).toEqual([["purchase_in", "50.000", "3000.0000"]]);
  });

  test("a credit line on a sale is refused", async () => {
    const broccoli = await broccoliStock("Broccoli sold");
    const res = await post(`/v1/bills/${await newBill("sale")}/confirm`, {
      ...confirmBody([less(broccoli)]),
      type: "sale",
      charges: [],
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Json).code).toBe("credit_on_sale");
  });
});

describe("discounts", () => {
  test("discount_total on a sale lowers its revenue and gross profit", async () => {
    const tomato = await item("Tomato", "kg");
    await post(`/v1/bills/${await newBill()}/confirm`, {
      ...confirmBody([{ name: "Tomato", item: tomato, qty: "20", unit: "kg", rate: "60" }]),
      bill_date: "2026-11-01",
      charges: [],
    });
    const sale = (lines: Line[], extra: Record<string, unknown>) => ({
      ...confirmBody(lines),
      type: "sale",
      vendor_name: `Customer ${run}`,
      bill_date: "2026-11-02",
      charges: [],
      ...extra,
    });
    const tomatoes: Line[] = [{ name: "Tomato", item: tomato, qty: "10", unit: "kg", rate: "100" }];

    const full = (await (
      await post(`/v1/bills/${await newBill("sale")}/confirm`, sale(tomatoes, {}))
    ).json()) as Json;
    expect([full.lines[0].goods_value, full.lines[0].gross_profit]).toEqual(["1000.00", "400.00"]);

    const res = await post(
      `/v1/bills/${await newBill("sale")}/confirm`,
      sale(tomatoes, { discount_total: "100.00" }),
    );
    expect(res.status).toBe(200);
    const discounted = (await res.json()) as Json;
    expect([discounted.discount_total, discounted.confirmed_total]).toEqual(["100.00", "900.00"]);
    expect([
      discounted.lines[0].goods_value,
      discounted.lines[0].cost_of_goods,
      discounted.lines[0].gross_profit,
    ]).toEqual(["900.00", "600.00", "300.00"]);
  });
});
