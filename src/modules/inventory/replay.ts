import type Decimal from "decimal.js";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../../platform/db/client";
import { dec, fmt } from "../../shared/money";
import { billLineItems, bills } from "../bills/bills.schema";
import { products, vendors } from "../catalog/catalog.schema";
import { saleProfit } from "../costing/average";
import { type EventKey, istDate, sortEvents } from "./event-order";
import { inventoryTransactions, masterProducts, stockLots } from "./inventory.schema";
import {
  loadItemUnits,
  type RecordStockIncrementInput,
  recordStockIncrement,
  type UnitConversionLine,
  unitConversionNeeded,
} from "./inventory.service";
import {
  type FactorSource,
  lineStockFactor,
  normalizeUnit,
  type PackSpec,
  STORED_SOURCES,
} from "./units";

/**
 * Rebuilds items' stock from their history in bill-date order (docs/BILL_ACCURACY_PLAN.md section 2).
 *
 * Every confirmed bill line linked to an item and every manual movement (correction, wastage, opening
 * stock) is collected, sorted by `compareEvents`, and re-applied through `recordStockIncrement` on a
 * zeroed item. Bill-driven ledger rows and lots take their bill line's id; manual rows keep their own
 * id, lot id, note, reason and time. Sale lines get their cost_of_goods and gross_profit rewritten.
 * A credit line that was in stock ("Less Broccoli", section 5) goes out as a purchase_return valued at
 * the average cost on its date; its credit_result (amount less that value) is rewritten too.
 * Replaying the same history twice writes identical rows.
 */

type BillLineEvent = EventKey & {
  kind: "purchase" | "sale" | "purchase_return";
  masterProductId: string;
  billId: string;
  vendorId: string | null;
  billDate: string | null;
  quantity: string;
  unit: string;
  productId: string | null;
  /** As stored on the line (docs/CUSTOMER_SPECS_PLAN.md B7). */
  stockFactor: string | null;
  stockFactorSource: string | null;
  amount: string;
  allocatedFees: string | null;
  landedCost: string | null;
  goodsValue: string | null;
  costOfGoods: string | null;
  grossProfit: string | null;
  creditResult: string | null;
};

type ManualEvent = EventKey & {
  kind: "manual";
  masterProductId: string;
  type: NonNullable<RecordStockIncrementInput["type"]>;
  deltaWeight: string;
  vendorId: string | null;
  valueDelta: string | null;
  note: string | null;
  reason: string | null;
  /** The lot a costed manual inflow (e.g. seeded opening stock) created, kept with its cost. */
  lot: { id: string; receivedOn: string | null; qty: string; baseUnitCost: string } | null;
};

type StockEvent = BillLineEvent | ManualEvent;

export type ReplayResult = { items: number; events: number; salesRecosted: number };

export type ReplayOptions = {
  /** Unit the manual movements of an item are stored in, when it is not (yet) the stock unit. */
  manualUnits?: Map<string, string> | undefined;
};

export async function replayItems(
  tx: Executor,
  businessId: string,
  masterProductIds: Iterable<string>,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const wanted = [...new Set(masterProductIds)].sort();
  if (wanted.length === 0) return { items: 0, events: 0, salesRecosted: 0 };

  // Lock in id order, so two replays over overlapping items cannot deadlock.
  const items = await tx
    .select({
      id: masterProducts.id,
      displayName: masterProducts.displayName,
      standardUnit: masterProducts.standardUnit,
    })
    .from(masterProducts)
    .where(and(eq(masterProducts.businessId, businessId), inArray(masterProducts.id, wanted)))
    .orderBy(asc(masterProducts.id))
    .for("update");
  if (items.length === 0) return { items: 0, events: 0, salesRecosted: 0 };
  const ids = items.map((i) => i.id);
  const unitOf = new Map(items.map((i) => [i.id, i.standardUnit]));

  const events = sortEvents<StockEvent>([
    ...(await billLineEvents(tx, businessId, ids)),
    ...(await manualEvents(tx, businessId, ids)),
  ]);

  // Every bill line must convert into its item's stock unit before anything is rebuilt
  // (docs/CUSTOMER_SPECS_PLAN.md B7):
  // - a party spec or review choice stored on the line is kept as it was confirmed;
  // - a same/built-in/item factor follows today's item units, and the line is updated to match;
  // - a line confirmed before factors were stored uses today's rule, its party spec included.
  const unitsOf = await loadItemUnits(tx, businessId, ids);
  const lineEvents = events.filter((e): e is BillLineEvent => e.kind !== "manual");
  const specs = await packSpecs(tx, lineEvents);
  const factorOf = new Map<string, Decimal>();
  const stuck: Array<UnitConversionLine & { vendorId: string | null }> = [];
  const seen = new Set<string>();
  for (const e of lineEvents) {
    const item = items.find((i) => i.id === e.masterProductId);
    if (!item) continue;
    const own = (unitsOf.get(item.id) ?? []).map((r) => ({ unit: r.unit, perUnit: r.perUnit }));
    let resolved: { factor: Decimal; source: FactorSource } | null;
    if (e.stockFactor != null && e.stockFactorSource && STORED_SOURCES.has(e.stockFactorSource)) {
      resolved = { factor: dec(e.stockFactor), source: e.stockFactorSource as FactorSource };
    } else if (e.stockFactorSource != null) {
      const live = lineStockFactor(e.unit, item.standardUnit, own, null);
      resolved = live;
      const factor = live ? fmt(live.factor, 6) : null;
      if (live && (factor !== e.stockFactor || live.source !== e.stockFactorSource)) {
        await tx
          .update(billLineItems)
          .set({ stockFactor: factor, stockFactorSource: live.source })
          .where(eq(billLineItems.id, e.id));
      }
    } else {
      const spec = e.productId ? (specs.get(e.productId) ?? null) : null;
      resolved = lineStockFactor(e.unit, item.standardUnit, own, spec);
    }
    if (resolved) {
      factorOf.set(e.id, resolved.factor);
      continue;
    }
    const key = `${item.id} ${normalizeUnit(e.unit)} ${e.vendorId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stuck.push({
      index: null,
      bill_id: e.billId,
      item_id: item.id,
      item_name: item.displayName,
      from_unit: normalizeUnit(e.unit),
      to_unit: item.standardUnit,
      party_id: e.vendorId,
      party_name: null,
      product_id: e.productId,
      vendorId: e.vendorId,
    });
  }
  if (stuck.length > 0) {
    const vendorIds = [...new Set(stuck.flatMap((s) => (s.vendorId ? [s.vendorId] : [])))];
    const names = new Map(
      vendorIds.length === 0
        ? []
        : (
            await tx
              .select({ id: vendors.id, name: vendors.displayName })
              .from(vendors)
              .where(inArray(vendors.id, vendorIds))
          ).map((v) => [v.id, v.name]),
    );
    throw unitConversionNeeded(
      stuck.map(({ vendorId, ...s }) => ({
        ...s,
        party_name: vendorId ? (names.get(vendorId) ?? null) : null,
      })),
    );
  }

  await tx
    .delete(inventoryTransactions)
    .where(
      and(
        eq(inventoryTransactions.businessId, businessId),
        inArray(inventoryTransactions.masterProductId, ids),
      ),
    );
  await tx
    .delete(stockLots)
    .where(and(eq(stockLots.businessId, businessId), inArray(stockLots.masterProductId, ids)));
  await tx
    .update(masterProducts)
    .set({
      currentStockWeight: "0",
      avgCost: null,
      stockValue: "0",
      lastLandedCost: null,
      lastPurchaseAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(masterProducts.businessId, businessId), inArray(masterProducts.id, ids)));

  let salesRecosted = 0;
  for (const e of events) {
    if (e.kind === "manual") {
      await recordStockIncrement(tx, {
        businessId,
        masterProductId: e.masterProductId,
        // Stored in the item's unit already (or in the unit it had, while that changes).
        deltaQuantity: e.deltaWeight,
        quantityUnit: opts.manualUnits?.get(e.masterProductId) ?? unitOf.get(e.masterProductId),
        vendorId: e.vendorId,
        type: e.type,
        note: e.note,
        reason: e.reason,
        cost: e.lot ? manualLotCost(e, e.lot) : null,
        receivedOn: e.lot?.receivedOn ?? null,
        asOf: e.on,
        transactionId: e.id,
        lotId: e.lot?.id,
        createdAt: e.at,
      });
      continue;
    }

    const common = {
      businessId,
      masterProductId: e.masterProductId,
      quantityUnit: e.unit,
      stockFactor: factorOf.get(e.id),
      billId: e.billId,
      billLineItemId: e.id,
      vendorId: e.vendorId,
      asOf: e.on,
      transactionId: e.id,
      lotId: e.id,
      createdAt: e.at,
    };
    if (e.kind === "purchase") {
      const fees = e.allocatedFees ?? "0";
      await recordStockIncrement(tx, {
        ...common,
        deltaQuantity: e.quantity,
        type: "purchase_in",
        // landed_cost = goods (after discount, plus GST when it is a cost) + this line's fees.
        cost:
          e.landedCost == null
            ? null
            : { goods: fmt(dec(e.landedCost).minus(dec(fees))), fees: fmt(fees) },
        receivedOn: e.billDate,
      });
      continue;
    }

    if (e.kind === "purchase_return") {
      // Back to the vendor at the average cost on its date; the credit less that value is the result.
      const moved = await recordStockIncrement(tx, {
        ...common,
        deltaQuantity: dec(e.quantity).neg().toString(),
        type: "purchase_return",
      });
      const creditResult =
        moved.valueDelta == null ? null : fmt(dec(e.amount).plus(dec(moved.valueDelta)));
      if (creditResult !== e.creditResult) {
        await tx.update(billLineItems).set({ creditResult }).where(eq(billLineItems.id, e.id));
      }
      continue;
    }

    // Sale: valued at the average cost on its date; unknown when nothing costed was bought before.
    const moved = await recordStockIncrement(tx, {
      ...common,
      deltaQuantity: dec(e.quantity).neg().toString(),
      type: "sale_out",
    });
    const goods = saleGoods(e);
    let costOfGoods: string | null = null;
    let grossProfit: string | null = null;
    if (moved.valueDelta != null) {
      costOfGoods = fmt(dec(moved.valueDelta).neg());
      grossProfit = saleProfit(goods.value, e.allocatedFees ?? "0", costOfGoods);
    }
    const backfill = e.goodsValue == null && goods.exact;
    if (costOfGoods !== e.costOfGoods || grossProfit !== e.grossProfit || backfill) {
      await tx
        .update(billLineItems)
        .set({ costOfGoods, grossProfit, ...(backfill ? { goodsValue: goods.value } : {}) })
        .where(eq(billLineItems.id, e.id));
      salesRecosted++;
    }
  }

  return { items: ids.length, events: events.length, salesRecosted };
}

/** Confirmed bill lines linked to the items. Lines of discarded or unconfirmed bills never count. */
async function billLineEvents(
  tx: Executor,
  businessId: string,
  ids: string[],
): Promise<BillLineEvent[]> {
  const rows = await tx
    .select({
      id: billLineItems.id,
      masterProductId: billLineItems.masterProductId,
      quantity: billLineItems.quantity,
      unit: billLineItems.unit,
      productId: billLineItems.productId,
      stockFactor: billLineItems.stockFactor,
      stockFactorSource: billLineItems.stockFactorSource,
      amount: billLineItems.amount,
      allocatedFees: billLineItems.allocatedFees,
      landedCost: billLineItems.landedCost,
      goodsValue: billLineItems.goodsValue,
      costOfGoods: billLineItems.costOfGoods,
      grossProfit: billLineItems.grossProfit,
      lineKind: billLineItems.lineKind,
      creditInStock: billLineItems.creditInStock,
      creditResult: billLineItems.creditResult,
      lineVendorId: billLineItems.vendorId,
      billId: bills.id,
      billType: bills.type,
      billDate: bills.billDate,
      billVendorId: bills.vendorId,
      billCreatedAt: bills.createdAt,
    })
    .from(billLineItems)
    .innerJoin(bills, eq(billLineItems.billId, bills.id))
    .where(
      and(
        eq(billLineItems.businessId, businessId),
        inArray(billLineItems.masterProductId, ids),
        eq(bills.businessId, businessId),
        eq(bills.status, "confirmed"),
      ),
    );

  const out: BillLineEvent[] = [];
  for (const r of rows) {
    if (!r.masterProductId || !dec(r.quantity).gt(0)) continue;
    // A credit moves stock only when it was in stock (and is on a purchase): a purchase_return.
    const credit = r.lineKind === "credit";
    if (credit && !(r.creditInStock && r.billType === "purchase")) continue;
    const kind = credit ? "purchase_return" : r.billType;
    out.push({
      kind,
      id: r.id,
      on: r.billDate ?? istDate(r.billCreatedAt),
      rank: kind === "purchase" ? 0 : 1,
      at: r.billCreatedAt,
      masterProductId: r.masterProductId,
      billId: r.billId,
      vendorId: r.lineVendorId ?? r.billVendorId,
      billDate: r.billDate,
      quantity: r.quantity,
      unit: r.unit,
      productId: r.productId,
      stockFactor: r.stockFactor,
      stockFactorSource: r.stockFactorSource,
      amount: r.amount,
      allocatedFees: r.allocatedFees,
      landedCost: r.landedCost,
      goodsValue: r.goodsValue,
      costOfGoods: r.costOfGoods,
      grossProfit: r.grossProfit,
      creditResult: r.creditResult,
    });
  }
  return out;
}

/** Ledger rows not made by a bill: corrections, wastage, opening stock (incl. stock at creation). */
async function manualEvents(
  tx: Executor,
  businessId: string,
  ids: string[],
): Promise<ManualEvent[]> {
  const rows = await tx
    .select({
      id: inventoryTransactions.id,
      masterProductId: inventoryTransactions.masterProductId,
      type: inventoryTransactions.transactionType,
      deltaWeight: inventoryTransactions.deltaWeight,
      vendorId: inventoryTransactions.vendorId,
      valueDelta: inventoryTransactions.valueDelta,
      note: inventoryTransactions.note,
      reason: inventoryTransactions.reason,
      createdAt: inventoryTransactions.createdAt,
      lotId: stockLots.id,
      lotReceivedOn: stockLots.receivedOn,
      lotQty: stockLots.qty,
      lotBaseUnitCost: stockLots.baseUnitCost,
    })
    .from(inventoryTransactions)
    .leftJoin(stockLots, eq(inventoryTransactions.lotId, stockLots.id))
    .where(
      and(
        eq(inventoryTransactions.businessId, businessId),
        inArray(inventoryTransactions.masterProductId, ids),
        isNull(inventoryTransactions.billId),
      ),
    );

  return rows.map((r) => {
    const lot =
      r.lotId && r.lotQty && r.lotBaseUnitCost
        ? {
            id: r.lotId,
            receivedOn: r.lotReceivedOn,
            qty: r.lotQty,
            baseUnitCost: r.lotBaseUnitCost,
          }
        : null;
    return {
      kind: "manual" as const,
      id: r.id,
      // Costed opening stock counts from the day it was received; anything else from the IST day
      // it was recorded.
      on: lot?.receivedOn ?? istDate(r.createdAt),
      rank: lot ? 0 : 1,
      at: r.createdAt,
      masterProductId: r.masterProductId,
      type: r.type as ManualEvent["type"],
      deltaWeight: r.deltaWeight,
      vendorId: r.vendorId,
      valueDelta: r.valueDelta,
      note: r.note,
      reason: r.reason,
      lot,
    };
  });
}

/**
 * The original cost of a costed manual inflow: its recorded total (value_delta), with the goods part
 * at the lot's base cost and the rest as fees, so landed and base cost per unit come back unchanged.
 */
function manualLotCost(
  e: ManualEvent,
  lot: NonNullable<ManualEvent["lot"]>,
): { goods: string; fees: string } {
  const goods = dec(lot.qty).mul(dec(lot.baseUnitCost));
  const total = e.valueDelta == null ? goods : dec(e.valueDelta);
  return { goods: goods.toFixed(), fees: total.minus(goods).toFixed() };
}

/**
 * A sale line's goods value for profit. Stored since goods_value exists; for older lines it comes back
 * exactly from a previous profit (goods = profit + fees + cost), otherwise the line amount stands in.
 */
function saleGoods(e: BillLineEvent): { value: string; exact: boolean } {
  if (e.goodsValue != null) return { value: e.goodsValue, exact: true };
  if (e.grossProfit != null && e.costOfGoods != null) {
    const v = dec(e.grossProfit)
      .plus(dec(e.allocatedFees ?? "0"))
      .plus(dec(e.costOfGoods));
    return { value: fmt(v), exact: true };
  }
  return { value: e.amount, exact: false };
}

/** Pack specs of the party products on the lines, by product id (only products that have one). */
async function packSpecs(tx: Executor, lines: BillLineEvent[]): Promise<Map<string, PackSpec>> {
  const ids = [...new Set(lines.flatMap((l) => (l.productId ? [l.productId] : [])))];
  const out = new Map<string, PackSpec>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      id: products.id,
      packUnit: products.packUnit,
      packQty: products.packQty,
      packQtyUnit: products.packQtyUnit,
    })
    .from(products)
    .where(inArray(products.id, ids));
  for (const r of rows) {
    if (r.packUnit && r.packQty && r.packQtyUnit) {
      out.set(r.id, { packUnit: r.packUnit, packQty: r.packQty, packQtyUnit: r.packQtyUnit });
    }
  }
  return out;
}
