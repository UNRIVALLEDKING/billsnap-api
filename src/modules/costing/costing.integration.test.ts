// Landed cost, lots, average cost and sale profit through confirmBill, against the real Postgres
// (compose stack). Storage and queue are not touched by confirm, so they are stubs here.
import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { testDatabase } from "../../../test/setup";
import type { Database } from "../../platform/db/client";
import type { Queue } from "../../platform/queue";
import type { Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { billLineItems, bills } from "../bills/bills.schema";
import { type ConfirmLine, confirmBill } from "../bills/bills.service";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { stockLots } from "../inventory/inventory.schema";
import {
  createMasterProduct,
  getMasterProduct,
  listStockLots,
} from "../inventory/inventory.service";

let database: Database;
let businessId: string;
let userId: string;
const run = newId().slice(-6);
const deps = () => ({ database, storage: {} as Storage, queue: {} as Queue });

beforeAll(async () => {
  database = await testDatabase();
  userId = newId();
  businessId = newId();
  await database.db
    .insert(users)
    .values({ id: userId, name: "Costing", email: `cost-${userId}@test.local` });
  await database.db
    .insert(businesses)
    .values({ id: businessId, name: "Costing Business", createdBy: userId });
  await database.db.insert(memberships).values({ businessId, userId, role: "owner" });
});

const product = async (name: string, unit = "kg") =>
  (
    await createMasterProduct(database.db, {
      businessId,
      displayName: `${name} ${run}`,
      standardUnit: unit,
    })
  ).id;

const line = (masterProductId: string | null, qty: string, unit: string, rate: string) =>
  ({
    // Distinct per item and unit: lines sharing a description resolve to the same vendor product.
    description: `item ${masterProductId ?? "unlinked"} ${unit}`,
    productId: null,
    masterProductId,
    quantity: qty,
    unit,
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

async function confirm(o: {
  type: "purchase" | "sale";
  vendor: string;
  date: string;
  lines: ConfirmLine[];
  fees?: string[];
  basis?: "weight" | "value";
}) {
  const id = newId();
  await database.db.insert(bills).values({
    id,
    businessId,
    clientRef: newId(),
    type: o.type,
    status: "needs_review",
    source: "camera",
    uploadedBy: userId,
    droppedAt: new Date(),
  });
  return confirmBill(deps(), { businessId, userId }, id, {
    type: o.type,
    vendorId: null,
    vendorName: `${o.vendor} ${run}`,
    invoiceNumber: `INV-${id.slice(-6)}`,
    billDate: o.date,
    lines: o.lines,
    charges: (o.fees ?? []).map((amount, i) => ({ id: newId(), label: `Fee ${i}`, amount })),
    feeSplitBasis: o.basis,
  });
}

describe("costing through confirm", () => {
  test("spreadsheet: fees stay on their invoice, and the EC sale shows its real loss", async () => {
    const [ec, gl, rl] = [await product("EC"), await product("GL"), await product("RL")];
    const bought = await confirm({
      type: "purchase",
      vendor: "Mandi",
      date: "2026-11-01",
      lines: [line(ec, "100", "kg", "60"), line(gl, "32", "kg", "90"), line(rl, "15", "kg", "100")],
      fees: ["1250.00", "3250.00"],
    });
    expect(bought.fee_split_basis).toBe("weight");
    expect(bought.lines.map((l) => [l.allocated_fees, l.landed_cost, l.landed_unit_cost])).toEqual([
      ["3061.23", "9061.23", "90.6123"],
      ["979.59", "3859.59", "120.6122"],
      ["459.18", "1959.18", "130.6120"],
    ]);

    const before = await getMasterProduct(database.db, businessId, ec);
    expect(before.avg_cost).toBe("90.6123");
    expect(before.stock_value).toBe("9061.23");

    const sold = await confirm({
      type: "sale",
      vendor: "Customer",
      date: "2026-11-02",
      lines: [line(ec, "80", "kg", "90")],
    });
    // 80 x 90.6123 = 7248.98 cost against 7200 of sales: the sheet's 48.98 loss.
    expect(sold.lines[0]?.cost_of_goods).toBe("7248.98");
    expect(sold.lines[0]?.gross_profit).toBe("-48.98");
    expect(sold.lines[0]?.landed_cost).toBeNull();

    const after = await getMasterProduct(database.db, businessId, ec);
    expect(after.current_stock_weight).toBe("20.000");
    expect(after.avg_cost).toBe("90.6123");
    expect(after.stock_value).toBe("1812.25");
    const lots = await listStockLots(database.db, businessId, ec, { open: true });
    expect(lots.map((l) => [l.qty, l.remaining_qty, l.fees_per_unit])).toEqual([
      ["100.000", "20.000", "30.6123"],
    ]);
  });

  test("three sugar invoices, each with its own fees", async () => {
    const sugar = await product("Sugar");
    await confirm({
      type: "purchase",
      vendor: "Vendor A",
      date: "2026-11-01",
      lines: [line(sugar, "100", "kg", "100")],
      fees: ["500.00"],
    });
    await confirm({
      type: "purchase",
      vendor: "Vendor B",
      date: "2026-11-03",
      lines: [line(sugar, "1", "quintal", "9000")],
      fees: ["1500.00", "500.00"],
    });
    await confirm({
      type: "purchase",
      vendor: "Vendor A",
      date: "2026-11-06",
      lines: [line(sugar, "100", "kg", "130")],
    });

    const lots = await listStockLots(database.db, businessId, sugar, {});
    // Newest first; the quintal lot is stored in kg with only its own invoice's fees.
    expect(lots.map((l) => [l.received_on, l.qty, l.fees_per_unit, l.landed_unit_cost])).toEqual([
      ["2026-11-06", "100.000", "0.0000", "130.0000"],
      ["2026-11-03", "100.000", "20.0000", "110.0000"],
      ["2026-11-01", "100.000", "5.0000", "105.0000"],
    ]);

    let s = await getMasterProduct(database.db, businessId, sugar);
    expect(s.avg_cost).toBe("115.0000");
    expect(s.last_landed_cost).toBe("130.0000");
    expect(s.break_even).toBe("130.0000");
    expect(s.stock_value).toBe("34500.00");
    // Latest lot per vendor, cheapest landed first.
    expect(s.vendor_costs?.map((v) => [v.vendor_name, v.landed_unit_cost])).toEqual([
      [`Vendor B ${run}`, "110.0000"],
      [`Vendor A ${run}`, "130.0000"],
    ]);

    // An older bill confirmed late blends into the average but does not become the "last" price.
    await confirm({
      type: "purchase",
      vendor: "Vendor B",
      date: "2026-10-01",
      lines: [line(sugar, "10", "kg", "50")],
    });
    s = await getMasterProduct(database.db, businessId, sugar);
    expect(s.avg_cost).toBe("112.9032"); // (34500 + 500) / 310
    expect(s.last_landed_cost).toBe("130.0000");
    expect(s.last_purchase_at).toBe("2026-11-06");

    // Selling 150 kg takes the oldest lots first (Oct 10 kg, Nov 1 100 kg, then 40 of Nov 3).
    await confirm({
      type: "sale",
      vendor: "Customer",
      date: "2026-11-07",
      lines: [line(sugar, "150", "kg", "140")],
    });
    const open = await listStockLots(database.db, businessId, sugar, { open: true });
    expect(open.map((l) => [l.received_on, l.remaining_qty])).toEqual([
      ["2026-11-06", "100.000"],
      ["2026-11-03", "60.000"],
    ]);
  });

  test("a sale before any costed purchase has no cost, and is counted", async () => {
    const salt = await product("Salt");
    const sold = await confirm({
      type: "sale",
      vendor: "Customer",
      date: "2026-11-02",
      lines: [line(salt, "5", "kg", "20")],
    });
    expect(sold.lines[0]?.cost_of_goods).toBeNull();
    expect(sold.lines[0]?.gross_profit).toBeNull();
    const s = await getMasterProduct(database.db, businessId, salt);
    expect(s.current_stock_weight).toBe("-5.000");
    expect(s.avg_cost).toBeNull();
    expect(s.stock_value).toBe("0.00");
    expect(s.unknown_cost_sales).toBe(1);

    // The next purchase starts the average at its own cost; the earlier sale is not rewritten.
    await confirm({
      type: "purchase",
      vendor: "Vendor C",
      date: "2026-11-03",
      lines: [line(salt, "50", "kg", "12")],
      fees: ["100.00"],
    });
    const after = await getMasterProduct(database.db, businessId, salt);
    expect(after.avg_cost).toBe("14.0000");
    expect(after.stock_value).toBe("630.00"); // 45 kg left x 14
    const open = await listStockLots(database.db, businessId, salt, { open: true });
    expect(open.map((l) => [l.qty, l.remaining_qty])).toEqual([["50.000", "45.000"]]);
  });

  test("a pcs line makes the invoice split by value; unmapped lines still carry their share", async () => {
    const rice = await product("Rice");
    const b = await confirm({
      type: "purchase",
      vendor: "Kirana",
      date: "2026-11-04",
      lines: [line(rice, "10", "kg", "50"), line(null, "10", "pcs", "10")],
      fees: ["60.00"],
    });
    expect(b.lines.map((l) => [l.allocated_fees, l.landed_cost, l.landed_unit_cost])).toEqual([
      ["50.00", "550.00", "55.0000"],
      ["10.00", "110.00", "11.0000"],
    ]);
    const rows = await database.db
      .select({ id: stockLots.id })
      .from(stockLots)
      .where(and(eq(stockLots.businessId, businessId), eq(stockLots.masterProductId, rice)));
    expect(rows.length).toBe(1);
    const stored = await database.db
      .select({ fees: billLineItems.allocatedFees })
      .from(billLineItems)
      .where(eq(billLineItems.billId, b.id));
    expect(stored.map((r) => r.fees).sort()).toEqual(["10.00", "50.00"]);
  });
});
