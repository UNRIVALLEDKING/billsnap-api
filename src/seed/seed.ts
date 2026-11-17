/**
 * Seeds the demo business with fruits and vegetables (with variants).
 *
 *   bun run seed                  stock items + opening stock at a cost (no invoices). Stock, worth,
 *                                 "don't sell below" and lots screens have data.
 *   bun run seed --items-only     stock items only, no stock and no invoices
 *   bun run seed --with-bills     stock items + ~3 weeks of confirmed purchase and sale invoices with fees
 *                                 (no opening stock: stock comes from the invoices). Seeded invoices have
 *                                 no photo; their numbers start with "SEED-".
 *
 * Safe to re-run: existing item names are skipped, opening stock is only added to items with no
 * stock history, and invoices are skipped if any "SEED-" invoice exists.
 *
 * In Docker:  docker compose -f compose.dev.yml --profile full exec api bun run seed [flag]
 * Uses DATABASE_URL. The demo business must exist (start the API once with DEMO_EMAIL set).
 */
import { and, eq, like } from "drizzle-orm";
import { DEMO_BUSINESS_ID, DEMO_USER_ID } from "../modules/auth/demo-login";
import { bills } from "../modules/bills/bills.schema";
import { type ConfirmLine, confirmBill } from "../modules/bills/bills.service";
import { businesses } from "../modules/businesses/businesses.schema";
import { normalizeProductName } from "../modules/catalog/normalize";
import { inventoryTransactions, masterProducts } from "../modules/inventory/inventory.schema";
import { createMasterProduct, recordStockIncrement } from "../modules/inventory/inventory.service";
import { createDatabase } from "../platform/db/client";
import type { Queue } from "../platform/queue";
import type { Storage } from "../platform/storage/r2";
import { newId } from "../shared/ids";
import { CUSTOMERS, PRODUCE, type Produce, VENDORS } from "./produce";
import { importTradeCatalogs } from "./trade-seeder";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const withBills = process.argv.includes("--with-bills");
const itemsOnly = process.argv.includes("--items-only");
if (withBills && itemsOnly) {
  console.error("use either --with-bills or --items-only, not both");
  process.exit(1);
}
const DAYS = 21;

const database = createDatabase({ url, poolSize: 2 });
const { db } = database;

// Small deterministic PRNG so every run builds the same data.
let state = 20261110;
const rand = () => {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
};
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const sample = <T>(xs: T[], n: number): T[] => {
  const copy = [...xs];
  const out: T[] = [];
  while (out.length < n && copy.length > 0)
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0] as T);
  return out;
};
const money = (n: number) => n.toFixed(2);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

async function seedProducts(): Promise<Map<string, string>> {
  const existing = await db
    .select({ id: masterProducts.id, nameNorm: masterProducts.nameNorm })
    .from(masterProducts)
    .where(eq(masterProducts.businessId, DEMO_BUSINESS_ID));
  const byNorm = new Map(existing.map((r) => [r.nameNorm, r.id]));
  const ids = new Map<string, string>();
  let created = 0;
  for (const p of PRODUCE) {
    const found = byNorm.get(normalizeProductName(p.name));
    if (found) {
      ids.set(p.name, found);
      continue;
    }
    const mp = await createMasterProduct(db, {
      businessId: DEMO_BUSINESS_ID,
      displayName: p.name,
      category: p.category,
      standardUnit: p.unit,
      reorderLevel: p.unit === "kg" ? "10" : "20",
    });
    ids.set(p.name, mp.id);
    created++;
  }
  console.log(`stock items: ${created} created, ${PRODUCE.length - created} already there`);
  return ids;
}

/** Opening stock for items with no stock history yet, each at a cost so it gets a real cost and a lot. */
async function seedOpeningStock(ids: Map<string, string>) {
  let added = 0;
  for (const p of PRODUCE) {
    const id = ids.get(p.name) as string;
    const qty = p.unit === "kg" ? Math.round(between(5, 60)) : Math.round(between(10, 100));
    const rate = Math.round(p.rate * between(0.9, 1.1) * 2) / 2;
    const fees = Math.round(rate * between(0.03, 0.12) * 100) / 100; // transport/handling per unit
    const done = await database.tx(async ({ db: tx }) => {
      const [moved] = await tx
        .select({ id: inventoryTransactions.id })
        .from(inventoryTransactions)
        .where(eq(inventoryTransactions.masterProductId, id))
        .limit(1);
      if (moved) return false;
      await recordStockIncrement(tx, {
        businessId: DEMO_BUSINESS_ID,
        masterProductId: id,
        deltaQuantity: String(qty),
        quantityUnit: p.unit,
        type: "manual_adjustment",
        note: "Opening stock (seed)",
        cost: { goods: money(qty * rate), fees: money(qty * fees) },
        receivedOn: daysAgo(1),
      });
      return true;
    });
    if (done) added++;
  }
  console.log(`opening stock: added to ${added} items (items with stock history were left alone)`);
}

const line = (masterProductId: string, p: Produce, qty: number, rate: number): ConfirmLine => ({
  description: p.name,
  productId: null,
  masterProductId,
  quantity: String(qty),
  unit: p.unit,
  rate: money(rate),
  discount: "0",
  printedAmount: null,
  hsnSac: null,
  gstRate: null,
  cgst: "0",
  sgst: "0",
  igst: "0",
  cess: "0",
  flags: [],
});

let invoiceNo = 1;
async function confirm(
  type: "purchase" | "sale",
  party: string,
  date: string,
  lines: ConfirmLine[],
  charges: Array<[string, number]>,
) {
  const id = newId();
  await db.insert(bills).values({
    id,
    businessId: DEMO_BUSINESS_ID,
    clientRef: newId(),
    type,
    status: "needs_review",
    source: "camera",
    uploadedBy: DEMO_USER_ID,
    droppedAt: new Date(`${date}T10:00:00+05:30`),
  });
  await confirmBill(
    { database, storage: {} as Storage, queue: {} as Queue },
    { businessId: DEMO_BUSINESS_ID, userId: DEMO_USER_ID },
    id,
    {
      type,
      vendorId: null,
      vendorName: party,
      invoiceNumber: `SEED-${type === "purchase" ? "P" : "S"}-${String(invoiceNo++).padStart(4, "0")}`,
      billDate: date,
      lines,
      charges: charges.map(([label, amount]) => ({ id: newId(), label, amount: money(amount) })),
    },
  );
}

async function seedBills(ids: Map<string, string>) {
  const [already] = await db
    .select({ id: bills.id })
    .from(bills)
    .where(and(eq(bills.businessId, DEMO_BUSINESS_ID), like(bills.invoiceNumber, "SEED-%")))
    .limit(1);
  if (already) {
    console.log("seeded invoices already exist; skipping invoices (delete them to re-seed)");
    return;
  }

  const stock = new Map<string, number>(); // product name -> qty on hand from seeded invoices
  const lastRate = new Map<string, number>();
  let purchases = 0;
  let sales = 0;

  for (let d = DAYS; d >= 1; d--) {
    const date = daysAgo(d);

    // Morning: 1-3 purchase invoices, each from one vendor with its own fees.
    for (const vendor of sample(VENDORS, 1 + Math.floor(rand() * 3))) {
      const items = sample(
        PRODUCE.filter((p) => vendor.categories.includes(p.category)),
        3 + Math.floor(rand() * 4),
      );
      const lines = items.map((p) => {
        const qty = p.unit === "kg" ? Math.round(between(10, 80)) : Math.round(between(20, 120));
        const rate = Math.round(p.rate * between(0.85, 1.2) * 2) / 2;
        stock.set(p.name, (stock.get(p.name) ?? 0) + qty);
        lastRate.set(p.name, rate);
        return line(ids.get(p.name) as string, p, qty, rate);
      });
      const charges: Array<[string, number]> = [
        ["Freight / Bhada", Math.round(between(200, 900) / 10) * 10],
        ["Hamali / Majduri", Math.round(between(50, 250) / 10) * 10],
      ];
      if (rand() < 0.5)
        charges.push(["Packaging (Bardana)", Math.round(between(60, 300) / 10) * 10]);
      if (rand() < 0.3) charges.push(["Mandi Cess", Math.round(between(30, 150))]);
      await confirm("purchase", vendor.name, date, lines, charges);
      purchases++;
    }

    // Day: 1-3 sale invoices from what is in stock, mostly at a markup, sometimes below cost.
    for (let s = 0, n = 1 + Math.floor(rand() * 3); s < n; s++) {
      const inStock = PRODUCE.filter((p) => (stock.get(p.name) ?? 0) >= 5);
      if (inStock.length === 0) break;
      const lines = sample(inStock, 2 + Math.floor(rand() * 4)).map((p) => {
        const have = stock.get(p.name) ?? 0;
        const qty = Math.max(1, Math.min(have, Math.round(have * between(0.2, 0.6))));
        const markup = rand() < 0.12 ? between(0.85, 1.0) : between(1.15, 1.5);
        const rate = Math.round((lastRate.get(p.name) ?? p.rate) * markup * 2) / 2;
        stock.set(p.name, have - qty);
        return line(ids.get(p.name) as string, p, qty, rate);
      });
      const charges: Array<[string, number]> =
        rand() < 0.4 ? [["Delivery", Math.round(between(50, 200) / 10) * 10]] : [];
      await confirm("sale", pick(CUSTOMERS), date, lines, charges);
      sales++;
    }
  }
  console.log(`invoices: ${purchases} purchases and ${sales} sales over ${DAYS} days`);
}

try {
  const [biz] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.id, DEMO_BUSINESS_ID))
    .limit(1);
  if (!biz) throw new Error("Demo business not found: start the API once with DEMO_EMAIL set");
  const tradeTypes = (process.env.SEED_TRADE_TYPE ?? "vegetables,fruits").split(",");
  const tradeResult = await importTradeCatalogs(db, DEMO_BUSINESS_ID, tradeTypes);
  console.log(
    `trade catalog [${tradeTypes.join(", ")}]: ${tradeResult.productsCreated} items, ${tradeResult.feesCreated} fees created`,
  );
  const ids = await seedProducts();
  if (withBills) await seedBills(ids);
  else if (!itemsOnly) await seedOpeningStock(ids);
  console.log("seed done");
} catch (err) {
  console.error("seed failed:", err);
  process.exitCode = 1;
} finally {
  await database.sql.end();
}
