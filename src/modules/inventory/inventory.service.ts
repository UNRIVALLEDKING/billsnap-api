import Decimal from "decimal.js";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Executor } from "../../platform/db/client";
import { AppError, notFound } from "../../platform/errors";
import { newId } from "../../shared/ids";
import { dec, fmt } from "../../shared/money";
import { billLineItems, bills } from "../bills/bills.schema";
import { products, vendors } from "../catalog/catalog.schema";
import { normalizeProductName } from "../catalog/normalize";
import { breakEven, nextAverage, stockValue, unitCost } from "../costing/average";
import {
  feeDefinitions,
  inventoryTransactions,
  masterProducts,
  stockLots,
} from "./inventory.schema";
import { convertUnit, normalizeUnit } from "./units";

export type MasterProductView = {
  id: string;
  business_id: string;
  display_name: string;
  name_norm: string;
  category: string | null;
  standard_unit: string;
  current_stock_weight: string;
  reorder_level: string | null;
  /** Costing, per standard unit (docs/COSTING_PLAN.md section 7). */
  avg_cost: string | null;
  stock_value: string;
  last_landed_cost: string | null;
  last_purchase_at: string | null;
  break_even: string | null;
  created_at: string;
  updated_at: string;
  recent_vendors?: { id: string; name: string }[];
  /** Detail only: each vendor's latest lot, cheapest landed cost first. */
  vendor_costs?: VendorCostView[];
  /** Detail only: confirmed sale lines on this item that have no cost. */
  unknown_cost_sales?: number;
};

export type VendorCostView = {
  vendor_id: string;
  vendor_name: string;
  received_on: string | null;
  base_unit_cost: string;
  fees_per_unit: string;
  landed_unit_cost: string;
};

export type StockLotView = {
  id: string;
  bill_id: string | null;
  invoice_number: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  received_on: string | null;
  qty: string;
  remaining_qty: string;
  base_unit_cost: string;
  fees_per_unit: string;
  landed_unit_cost: string;
};

type CostRow = {
  avgCost: string | null;
  stockValue: string;
  lastLandedCost: string | null;
  lastPurchaseAt: string | null;
};

function costFields(r: CostRow) {
  const avg = r.avgCost == null ? null : fmt(r.avgCost, 4);
  const last = r.lastLandedCost == null ? null : fmt(r.lastLandedCost, 4);
  return {
    avg_cost: avg,
    stock_value: fmt(r.stockValue),
    last_landed_cost: last,
    last_purchase_at: r.lastPurchaseAt,
    break_even: breakEven(avg, last),
  };
}

export type InventoryTransactionView = {
  id: string;
  business_id: string;
  master_product_id: string;
  bill_id: string | null;
  invoice_number: string | null;
  bill_date: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  transaction_type: string;
  delta_weight: string;
  resulting_stock_weight: string;
  unit_cost: string | null;
  value_delta: string | null;
  note: string | null;
  /** Wastage only: spoiled, damaged, expired, theft or other. */
  reason: string | null;
  created_at: string;
};

// ---- Queries -----------------------------------------------------------------------------------------

export type ListMasterProductsOpts = {
  query?: string | undefined;
  category?: string | undefined;
  limit?: number | undefined;
  in_stock_only?: boolean | undefined;
};

export type InStockInventorySummary = {
  totalItems: number;
  totalStockWeight: string;
  totalStockValue: string;
  lowStockCount: number;
};

export type InStockInventoryResponse = {
  summary: InStockInventorySummary;
  items: MasterProductView[];
};

export type MasterCategoryView = {
  category: string;
  productCount: number;
  inStockCount: number;
};

export async function listMasterProducts(
  db: Executor,
  businessId: string,
  opts?: ListMasterProductsOpts,
): Promise<MasterProductView[]> {
  // The app loads the whole stock list and searches it locally, so return everything by default.
  const asked = opts?.limit;
  const limit = asked && Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 5000) : 5000;
  const conditions = [eq(masterProducts.businessId, businessId)];

  if (opts?.query) {
    const q = `%${opts.query.trim().toLowerCase()}%`;
    const searchFilter = or(
      ilike(masterProducts.displayName, q),
      ilike(masterProducts.nameNorm, q),
    );
    if (searchFilter) conditions.push(searchFilter);
  }

  if (opts?.category) {
    conditions.push(eq(masterProducts.category, opts.category.trim()));
  }

  if (opts?.in_stock_only) {
    // Negative stock counts as "in stock" so oversold items stay visible.
    conditions.push(ne(masterProducts.currentStockWeight, "0"));
  }

  const rows = await db
    .select()
    .from(masterProducts)
    .where(and(...conditions))
    .orderBy(asc(masterProducts.displayName))
    .limit(limit);

  // Vendors who supplied each item, in one query, so the app can search the list by vendor.
  const supplied = new Map<string, { id: string; name: string }[]>();
  if (rows.length > 0) {
    const pairs = await db
      .selectDistinct({
        masterProductId: inventoryTransactions.masterProductId,
        id: vendors.id,
        name: vendors.displayName,
      })
      .from(inventoryTransactions)
      .innerJoin(vendors, eq(inventoryTransactions.vendorId, vendors.id))
      .where(
        and(
          eq(inventoryTransactions.businessId, businessId),
          eq(inventoryTransactions.transactionType, "purchase_in"),
        ),
      );
    for (const v of pairs) {
      const list = supplied.get(v.masterProductId) ?? [];
      list.push({ id: v.id, name: v.name });
      supplied.set(v.masterProductId, list);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    business_id: r.businessId,
    display_name: r.displayName,
    name_norm: r.nameNorm,
    category: r.category,
    standard_unit: r.standardUnit,
    current_stock_weight: fmt(r.currentStockWeight, 3),
    reorder_level: r.reorderLevel ? fmt(r.reorderLevel, 3) : null,
    ...costFields(r),
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    recent_vendors: supplied.get(r.id) ?? [],
  }));
}

export async function listInStockInventory(
  db: Executor,
  businessId: string,
  opts?: { query?: string | undefined; category?: string | undefined; limit?: number | undefined },
): Promise<InStockInventoryResponse> {
  const items = await listMasterProducts(db, businessId, {
    ...opts,
    in_stock_only: true,
  });

  let totalWeight = new Decimal(0);
  let totalValue = new Decimal(0);
  let lowStockCount = 0;

  for (const item of items) {
    const stock = dec(item.current_stock_weight);
    totalWeight = totalWeight.plus(stock);
    totalValue = totalValue.plus(dec(item.stock_value));
    if (item.reorder_level != null) {
      const reorder = dec(item.reorder_level);
      if (stock.lte(reorder)) {
        lowStockCount++;
      }
    }
  }

  return {
    summary: {
      totalItems: items.length,
      totalStockWeight: fmt(totalWeight, 3),
      totalStockValue: fmt(totalValue, 2),
      lowStockCount,
    },
    items,
  };
}

export async function listMasterCategories(
  db: Executor,
  businessId: string,
): Promise<MasterCategoryView[]> {
  const rows = await db
    .select({
      category: sql<string>`coalesce(nullif(trim(${masterProducts.category}), ''), 'Uncategorized')`,
      productCount: sql<number>`count(*)::int`,
      inStockCount: sql<number>`count(*) filter (where ${masterProducts.currentStockWeight} <> 0)::int`,
    })
    .from(masterProducts)
    .where(eq(masterProducts.businessId, businessId))
    .groupBy(sql`coalesce(nullif(trim(${masterProducts.category}), ''), 'Uncategorized')`)
    .orderBy(sql`coalesce(nullif(trim(${masterProducts.category}), ''), 'Uncategorized')`);

  return rows.map((r) => ({
    category: r.category,
    productCount: Number(r.productCount),
    inStockCount: Number(r.inStockCount),
  }));
}

export async function getMasterProduct(
  db: Executor,
  businessId: string,
  id: string,
): Promise<MasterProductView> {
  const [row] = await db
    .select()
    .from(masterProducts)
    .where(and(eq(masterProducts.businessId, businessId), eq(masterProducts.id, id)))
    .limit(1);

  if (!row) throw notFound("master_product");

  // Query recent vendors who supplied this product
  const recentVendors = await db
    .select({
      id: vendors.id,
      name: vendors.displayName,
    })
    .from(inventoryTransactions)
    .innerJoin(vendors, eq(inventoryTransactions.vendorId, vendors.id))
    .where(
      and(
        eq(inventoryTransactions.businessId, businessId),
        eq(inventoryTransactions.masterProductId, id),
      ),
    )
    .orderBy(desc(inventoryTransactions.createdAt))
    .limit(5);

  // Deduplicate vendors by ID
  const uniqueVendors = Array.from(new Map(recentVendors.map((v) => [v.id, v])).values());

  const [unknown] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(billLineItems)
    .where(
      and(
        eq(billLineItems.businessId, businessId),
        eq(billLineItems.masterProductId, id),
        eq(billLineItems.billType, "sale"),
        eq(billLineItems.isConfirmed, true),
        isNull(billLineItems.costOfGoods),
      ),
    );

  return {
    id: row.id,
    business_id: row.businessId,
    display_name: row.displayName,
    name_norm: row.nameNorm,
    category: row.category,
    standard_unit: row.standardUnit,
    current_stock_weight: fmt(row.currentStockWeight, 3),
    reorder_level: row.reorderLevel ? fmt(row.reorderLevel, 3) : null,
    ...costFields(row),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    recent_vendors: uniqueVendors,
    vendor_costs: await latestCostPerVendor(db, businessId, id),
    unknown_cost_sales: Number(unknown?.n ?? 0),
  };
}

// ---- Mutations ---------------------------------------------------------------------------------------

export type CreateMasterProductInput = {
  businessId: string;
  displayName: string;
  category?: string | null | undefined;
  standardUnit?: string | null | undefined;
  reorderLevel?: string | null | undefined;
  initialStock?: string | null | undefined;
};

export async function createMasterProduct(
  db: Executor,
  input: CreateMasterProductInput,
): Promise<MasterProductView> {
  const nameNorm = normalizeProductName(input.displayName);
  if (!nameNorm) {
    throw new AppError("validation_failed", 422, "Product name cannot be empty");
  }

  const [existing] = await db
    .select({ id: masterProducts.id })
    .from(masterProducts)
    .where(
      and(eq(masterProducts.businessId, input.businessId), eq(masterProducts.nameNorm, nameNorm)),
    )
    .limit(1);
  if (existing) {
    throw new AppError(
      "already_exists",
      409,
      `Master product "${input.displayName}" already exists`,
    );
  }

  const standardUnit = normalizeUnit(input.standardUnit ?? "kg");
  const initialStock = input.initialStock ? fmt(input.initialStock, 3) : "0.000";
  const id = newId();

  const [created] = await db
    .insert(masterProducts)
    .values({
      id,
      businessId: input.businessId,
      displayName: input.displayName.trim(),
      nameNorm,
      category: input.category?.trim() || null,
      standardUnit,
      currentStockWeight: initialStock,
      reorderLevel: input.reorderLevel ? fmt(input.reorderLevel, 3) : null,
    })
    .returning();

  if (!created) {
    throw new AppError("internal", 500, "Failed to create master product");
  }

  if (dec(initialStock).gt(0)) {
    await db.insert(inventoryTransactions).values({
      id: newId(),
      businessId: input.businessId,
      masterProductId: id,
      transactionType: "manual_adjustment",
      deltaWeight: initialStock,
      resultingStockWeight: initialStock,
      note: "Initial stock upon product creation",
    });
  }

  return {
    id: created.id,
    business_id: created.businessId,
    display_name: created.displayName,
    name_norm: created.nameNorm,
    category: created.category,
    standard_unit: created.standardUnit,
    current_stock_weight: fmt(created.currentStockWeight, 3),
    reorder_level: created.reorderLevel ? fmt(created.reorderLevel, 3) : null,
    ...costFields(created),
    created_at: created.createdAt.toISOString(),
    updated_at: created.updatedAt.toISOString(),
  };
}

export async function updateMasterProduct(
  db: Executor,
  businessId: string,
  id: string,
  input: {
    displayName?: string | undefined;
    category?: string | null | undefined;
    standardUnit?: string | undefined;
    reorderLevel?: string | null | undefined;
  },
): Promise<MasterProductView> {
  const patch: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (input.displayName !== undefined) {
    const nameNorm = normalizeProductName(input.displayName);
    if (!nameNorm) throw new AppError("validation_failed", 422, "Product name cannot be empty");
    patch.displayName = input.displayName.trim();
    patch.nameNorm = nameNorm;
  }

  if (input.category !== undefined) patch.category = input.category?.trim() || null;
  if (input.standardUnit !== undefined) {
    const unit = normalizeUnit(input.standardUnit);
    const [current] = await db
      .select({ standardUnit: masterProducts.standardUnit })
      .from(masterProducts)
      .where(and(eq(masterProducts.businessId, businessId), eq(masterProducts.id, id)))
      .limit(1);
    if (!current) throw notFound("master_product");
    if (current.standardUnit !== unit) {
      // Stored stock and ledger rows are in the old unit; relabelling them would corrupt the totals.
      const [moved] = await db
        .select({ id: inventoryTransactions.id })
        .from(inventoryTransactions)
        .where(
          and(
            eq(inventoryTransactions.businessId, businessId),
            eq(inventoryTransactions.masterProductId, id),
          ),
        )
        .limit(1);
      if (moved) {
        throw new AppError(
          "unit_locked",
          409,
          "Unit can't be changed once this product has stock history",
        );
      }
    }
    patch.standardUnit = unit;
  }
  if (input.reorderLevel !== undefined) {
    patch.reorderLevel = input.reorderLevel ? fmt(input.reorderLevel, 3) : null;
  }

  const [updated] = await db
    .update(masterProducts)
    .set(patch)
    .where(and(eq(masterProducts.businessId, businessId), eq(masterProducts.id, id)))
    .returning();

  if (!updated) throw notFound("master_product");

  return getMasterProduct(db, businessId, id);
}

/**
 * Deletes a master product and its stock ledger (FK cascade). Vendor products and bill lines that
 * pointed at it are unlinked first; those columns have no FK, so they would otherwise dangle.
 * Bills themselves are untouched.
 */
export async function deleteMasterProduct(
  db: Executor,
  businessId: string,
  id: string,
): Promise<void> {
  const [prod] = await db
    .select({ id: masterProducts.id })
    .from(masterProducts)
    .where(and(eq(masterProducts.businessId, businessId), eq(masterProducts.id, id)))
    .for("update");
  if (!prod) throw notFound("master_product");

  await db
    .update(products)
    .set({ masterProductId: null, updatedAt: new Date() })
    .where(and(eq(products.businessId, businessId), eq(products.masterProductId, id)));
  await db
    .update(billLineItems)
    .set({ masterProductId: null })
    .where(and(eq(billLineItems.businessId, businessId), eq(billLineItems.masterProductId, id)));
  await db
    .delete(masterProducts)
    .where(and(eq(masterProducts.businessId, businessId), eq(masterProducts.id, id)));
}

// ---- Stock Operations --------------------------------------------------------------------------------

export type RecordStockIncrementInput = {
  businessId: string;
  masterProductId: string;
  deltaQuantity: string | Decimal;
  quantityUnit?: string | null | undefined;
  billId?: string | null | undefined;
  billLineItemId?: string | null | undefined;
  vendorId?: string | null | undefined;
  type?: "purchase_in" | "sale_out" | "manual_adjustment" | "wastage" | undefined;
  note?: string | null | undefined;
  /** Wastage only: why the stock was lost. */
  reason?: string | null | undefined;
  /**
   * Purchase only: what this line really cost in total, split into goods (after bill discount, plus GST
   * when it is a cost) and this line's share of its own invoice's fees. Creates a lot.
   */
  cost?: { goods: string; fees: string } | null | undefined;
  /** Bill date of the purchase, used to order lots oldest first. */
  receivedOn?: string | null | undefined;
};

export type StockMovement = {
  resultingStock: string;
  deltaWeight: string;
  /** Cost per standard unit this movement was valued at, or null when unknown. */
  unitCost: string | null;
  /** Signed change in stock value (4 dp), or null when unknown. */
  valueDelta: string | null;
  lotId: string | null;
};

/**
 * Atomically moves stock and its value, and appends an immutable transaction record.
 * Converts the input unit to the product's standard unit.
 *
 * - Costed purchase: becomes its own lot at its own landed cost, and blends into the moving average.
 * - Outflow (sale, negative adjustment): valued at the current average; consumes lots oldest first.
 * - Uncosted inflow (opening stock, positive adjustment): valued at the current average, no lot.
 */
export async function recordStockIncrement(
  tx: Executor,
  input: RecordStockIncrementInput,
): Promise<StockMovement> {
  // Lock the master product row for update to prevent concurrent race conditions
  const [prod] = await tx
    .select({
      id: masterProducts.id,
      standardUnit: masterProducts.standardUnit,
      currentStockWeight: masterProducts.currentStockWeight,
      avgCost: masterProducts.avgCost,
      lastLandedCost: masterProducts.lastLandedCost,
      lastPurchaseAt: masterProducts.lastPurchaseAt,
    })
    .from(masterProducts)
    .where(
      and(
        eq(masterProducts.businessId, input.businessId),
        eq(masterProducts.id, input.masterProductId),
      ),
    )
    .for("update");

  if (!prod) throw notFound("master_product");

  // Convert quantity to standard unit of product
  const rawQty = dec(input.deltaQuantity);
  const convertedWeight = convertUnit(rawQty, input.quantityUnit, prod.standardUnit);

  const prevStock = dec(prod.currentStockWeight);
  const resultingStockDec = prevStock.plus(convertedWeight);
  const resultingStock = fmt(resultingStockDec, 3);
  const deltaWeight = fmt(convertedWeight, 3);

  let avg = prod.avgCost;
  let lastLanded = prod.lastLandedCost;
  let lastPurchaseAt = prod.lastPurchaseAt;
  let unitCostOut: string | null = null;
  let valueDelta: string | null = null;
  let lotId: string | null = null;

  if (input.cost && convertedWeight.gt(0)) {
    const goods = dec(input.cost.goods);
    const fees = dec(input.cost.fees);
    const total = goods.plus(fees);
    const landed = unitCost(total, convertedWeight) as string;
    avg = nextAverage({ stock: prevStock, avg, qty: convertedWeight, cost: total });
    // "Last" means latest by bill date: an old bill confirmed late must not replace today's price.
    const receivedOn = input.receivedOn ?? new Date().toISOString().slice(0, 10);
    if (!lastPurchaseAt || receivedOn >= lastPurchaseAt) {
      lastLanded = landed;
      lastPurchaseAt = receivedOn;
    }
    unitCostOut = landed;
    valueDelta = fmt(total, 4);
    lotId = newId();
    await tx.insert(stockLots).values({
      id: lotId,
      businessId: input.businessId,
      masterProductId: prod.id,
      billId: input.billId ?? null,
      billLineItemId: input.billLineItemId ?? null,
      vendorId: input.vendorId ?? null,
      receivedOn: input.receivedOn ?? null,
      qty: deltaWeight,
      baseUnitCost: unitCost(goods, convertedWeight) as string,
      feesPerUnit: unitCost(fees, convertedWeight) as string,
      landedUnitCost: landed,
      // Stock already sold below zero is covered by this lot, so only what is left stays open.
      remainingQty: prevStock.lt(0) ? fmt(Decimal.max(resultingStockDec, 0), 3) : deltaWeight,
    });
  } else {
    if (avg != null) {
      unitCostOut = avg;
      valueDelta = fmt(convertedWeight.mul(dec(avg)), 4);
    }
    if (convertedWeight.lt(0)) await consumeLots(tx, prod.id, convertedWeight.neg());
  }

  await tx
    .update(masterProducts)
    .set({
      currentStockWeight: resultingStock,
      avgCost: avg,
      stockValue: stockValue(resultingStockDec, avg),
      lastLandedCost: lastLanded,
      lastPurchaseAt,
      updatedAt: new Date(),
    })
    .where(eq(masterProducts.id, prod.id));

  await tx.insert(inventoryTransactions).values({
    id: newId(),
    businessId: input.businessId,
    masterProductId: prod.id,
    billId: input.billId ?? null,
    billLineItemId: input.billLineItemId ?? null,
    vendorId: input.vendorId ?? null,
    transactionType: input.type ?? "purchase_in",
    deltaWeight,
    resultingStockWeight: resultingStock,
    unitCost: unitCostOut,
    valueDelta,
    lotId,
    note: input.note ?? null,
    reason: input.reason ?? null,
  });

  return { resultingStock, deltaWeight, unitCost: unitCostOut, valueDelta, lotId };
}

/** Takes `qty` out of the product's open lots, oldest first. Selling past the last lot just stops. */
async function consumeLots(tx: Executor, masterProductId: string, qty: Decimal): Promise<void> {
  const open = await tx
    .select({ id: stockLots.id, remaining: stockLots.remainingQty })
    .from(stockLots)
    .where(and(eq(stockLots.masterProductId, masterProductId), gt(stockLots.remainingQty, "0")))
    .orderBy(sql`${stockLots.receivedOn} asc nulls last`, asc(stockLots.createdAt))
    .for("update");
  let left = qty;
  for (const lot of open) {
    if (left.lte(0)) break;
    const have = dec(lot.remaining);
    const take = Decimal.min(have, left);
    await tx
      .update(stockLots)
      .set({ remainingQty: fmt(have.minus(take), 3) })
      .where(eq(stockLots.id, lot.id));
    left = left.minus(take);
  }
}

export async function listInventoryTransactions(
  db: Executor,
  businessId: string,
  masterProductId: string,
  limit = 50,
): Promise<InventoryTransactionView[]> {
  const rows = await db
    .select({
      id: inventoryTransactions.id,
      businessId: inventoryTransactions.businessId,
      masterProductId: inventoryTransactions.masterProductId,
      billId: inventoryTransactions.billId,
      vendorId: inventoryTransactions.vendorId,
      transactionType: inventoryTransactions.transactionType,
      deltaWeight: inventoryTransactions.deltaWeight,
      resultingStockWeight: inventoryTransactions.resultingStockWeight,
      unitCost: inventoryTransactions.unitCost,
      valueDelta: inventoryTransactions.valueDelta,
      note: inventoryTransactions.note,
      reason: inventoryTransactions.reason,
      createdAt: inventoryTransactions.createdAt,
      vendorName: vendors.displayName,
      invoiceNumber: bills.invoiceNumber,
      billDate: bills.billDate,
    })
    .from(inventoryTransactions)
    .leftJoin(vendors, eq(inventoryTransactions.vendorId, vendors.id))
    .leftJoin(bills, eq(inventoryTransactions.billId, bills.id))
    .where(
      and(
        eq(inventoryTransactions.businessId, businessId),
        eq(inventoryTransactions.masterProductId, masterProductId),
      ),
    )
    .orderBy(desc(inventoryTransactions.createdAt))
    .limit(Math.min(limit, 100));

  return rows.map((r) => ({
    id: r.id,
    business_id: r.businessId,
    master_product_id: r.masterProductId,
    bill_id: r.billId,
    invoice_number: r.invoiceNumber,
    bill_date: r.billDate,
    vendor_id: r.vendorId,
    vendor_name: r.vendorName,
    transaction_type: r.transactionType,
    delta_weight: fmt(r.deltaWeight, 3),
    resulting_stock_weight: fmt(r.resultingStockWeight, 3),
    unit_cost: r.unitCost == null ? null : fmt(r.unitCost, 4),
    value_delta: r.valueDelta == null ? null : fmt(r.valueDelta, 4),
    note: r.note,
    reason: r.reason,
    created_at: r.createdAt.toISOString(),
  }));
}

// ---- Wastage -----------------------------------------------------------------------------------------

export const WASTAGE_REASONS = ["spoiled", "damaged", "expired", "theft", "other"] as const;

export type WastageReport = {
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

const IST_OFFSET = "+05:30";

/** Wastage between two local (IST) days, both inclusive, valued as recorded at the time. */
export async function wastageReport(
  db: Executor,
  businessId: string,
  range: { from?: string | undefined; to?: string | undefined },
): Promise<WastageReport> {
  const conditions = [
    eq(inventoryTransactions.businessId, businessId),
    eq(inventoryTransactions.transactionType, "wastage"),
  ];
  if (range.from) {
    const start = new Date(`${range.from}T00:00:00${IST_OFFSET}`);
    conditions.push(gte(inventoryTransactions.createdAt, start));
  }
  if (range.to) {
    const end = new Date(`${range.to}T00:00:00${IST_OFFSET}`);
    end.setUTCDate(end.getUTCDate() + 1);
    conditions.push(lt(inventoryTransactions.createdAt, end));
  }

  const rows = await db
    .select({
      masterProductId: inventoryTransactions.masterProductId,
      name: masterProducts.displayName,
      unit: masterProducts.standardUnit,
      deltaWeight: inventoryTransactions.deltaWeight,
      valueDelta: inventoryTransactions.valueDelta,
      reason: inventoryTransactions.reason,
    })
    .from(inventoryTransactions)
    .innerJoin(masterProducts, eq(inventoryTransactions.masterProductId, masterProducts.id))
    .where(and(...conditions));

  type Bucket = { qty: Decimal; value: Decimal };
  type Acc = Bucket & {
    id: string;
    name: string;
    unit: string;
    entries: number;
    uncosted: number;
    reasons: Map<string, Bucket>;
  };
  const byItem = new Map<string, Acc>();
  let totalValue = new Decimal(0);
  let entries = 0;
  let uncosted = 0;

  for (const r of rows) {
    let acc = byItem.get(r.masterProductId);
    if (!acc) {
      acc = {
        id: r.masterProductId,
        name: r.name,
        unit: r.unit,
        qty: new Decimal(0),
        value: new Decimal(0),
        entries: 0,
        uncosted: 0,
        reasons: new Map(),
      };
      byItem.set(r.masterProductId, acc);
    }
    const qty = dec(r.deltaWeight).abs();
    const value = r.valueDelta == null ? new Decimal(0) : dec(r.valueDelta).abs();
    acc.qty = acc.qty.plus(qty);
    acc.value = acc.value.plus(value);
    acc.entries++;
    entries++;
    if (r.valueDelta == null) {
      acc.uncosted++;
      uncosted++;
    }
    totalValue = totalValue.plus(value);
    const key = r.reason ?? "other";
    const bucket = acc.reasons.get(key) ?? { qty: new Decimal(0), value: new Decimal(0) };
    bucket.qty = bucket.qty.plus(qty);
    bucket.value = bucket.value.plus(value);
    acc.reasons.set(key, bucket);
  }

  const items = [...byItem.values()]
    .sort((a, b) => b.value.comparedTo(a.value) || a.name.localeCompare(b.name))
    .map((a) => ({
      master_product_id: a.id,
      name: a.name,
      unit: a.unit,
      qty: fmt(a.qty, 3),
      value_lost: fmt(a.value, 2),
      entries: a.entries,
      uncosted_entries: a.uncosted,
      by_reason: [...a.reasons.entries()]
        .sort((x, y) => y[1].value.comparedTo(x[1].value))
        .map(([reason, b]) => ({ reason, qty: fmt(b.qty, 3), value_lost: fmt(b.value, 2) })),
    }));

  return {
    summary: { value_lost: fmt(totalValue, 2), entries, uncosted_entries: uncosted },
    items,
  };
}

// ---- Costing queries ---------------------------------------------------------------------------------

/** Each vendor's most recent lot of this product, cheapest landed cost first. */
async function latestCostPerVendor(
  db: Executor,
  businessId: string,
  masterProductId: string,
): Promise<VendorCostView[]> {
  const rows = await db
    .select({
      vendorId: stockLots.vendorId,
      vendorName: vendors.displayName,
      receivedOn: stockLots.receivedOn,
      baseUnitCost: stockLots.baseUnitCost,
      feesPerUnit: stockLots.feesPerUnit,
      landedUnitCost: stockLots.landedUnitCost,
    })
    .from(stockLots)
    .innerJoin(vendors, eq(stockLots.vendorId, vendors.id))
    .where(
      and(
        eq(stockLots.businessId, businessId),
        eq(stockLots.masterProductId, masterProductId),
        isNotNull(stockLots.vendorId),
      ),
    )
    .orderBy(sql`${stockLots.receivedOn} desc nulls last`, desc(stockLots.createdAt))
    .limit(500);

  const latest = new Map<string, VendorCostView>();
  for (const r of rows) {
    if (!r.vendorId || latest.has(r.vendorId)) continue;
    latest.set(r.vendorId, {
      vendor_id: r.vendorId,
      vendor_name: r.vendorName,
      received_on: r.receivedOn,
      base_unit_cost: fmt(r.baseUnitCost, 4),
      fees_per_unit: fmt(r.feesPerUnit, 4),
      landed_unit_cost: fmt(r.landedUnitCost, 4),
    });
  }
  return [...latest.values()].sort((a, b) =>
    dec(a.landed_unit_cost).comparedTo(dec(b.landed_unit_cost)),
  );
}

/** Purchase lots of a product, newest first; `open` keeps only lots with stock left. */
export async function listStockLots(
  db: Executor,
  businessId: string,
  masterProductId: string,
  opts?: { open?: boolean | undefined; limit?: number | undefined },
): Promise<StockLotView[]> {
  const conditions = [
    eq(stockLots.businessId, businessId),
    eq(stockLots.masterProductId, masterProductId),
  ];
  if (opts?.open) conditions.push(gt(stockLots.remainingQty, "0"));
  const rows = await db
    .select({
      id: stockLots.id,
      billId: stockLots.billId,
      invoiceNumber: bills.invoiceNumber,
      vendorId: stockLots.vendorId,
      vendorName: vendors.displayName,
      receivedOn: stockLots.receivedOn,
      qty: stockLots.qty,
      remainingQty: stockLots.remainingQty,
      baseUnitCost: stockLots.baseUnitCost,
      feesPerUnit: stockLots.feesPerUnit,
      landedUnitCost: stockLots.landedUnitCost,
    })
    .from(stockLots)
    .leftJoin(vendors, eq(stockLots.vendorId, vendors.id))
    .leftJoin(bills, eq(stockLots.billId, bills.id))
    .where(and(...conditions))
    .orderBy(sql`${stockLots.receivedOn} desc nulls last`, desc(stockLots.createdAt))
    .limit(Math.min(Math.max(opts?.limit ?? 50, 1), 100));

  return rows.map((r) => ({
    id: r.id,
    bill_id: r.billId,
    invoice_number: r.invoiceNumber,
    vendor_id: r.vendorId,
    vendor_name: r.vendorName,
    received_on: r.receivedOn,
    qty: fmt(r.qty, 3),
    remaining_qty: fmt(r.remainingQty, 3),
    base_unit_cost: fmt(r.baseUnitCost, 4),
    fees_per_unit: fmt(r.feesPerUnit, 4),
    landed_unit_cost: fmt(r.landedUnitCost, 4),
  }));
}

// ---- Fee Definitions ---------------------------------------------------------------------------------

export type FeeDefinitionView = {
  id: string;
  business_id: string;
  name: string;
  category: string;
  default_basis: string;
  is_active: boolean;
  created_at: string;
};

export type CreateFeeDefinitionInput = {
  name: string;
  category?: string | undefined;
  defaultBasis?: "weight" | "value" | undefined;
};

export type UpdateFeeDefinitionInput = {
  name?: string | undefined;
  category?: string | undefined;
  defaultBasis?: "weight" | "value" | undefined;
  isActive?: boolean | undefined;
};

export async function listFeeDefinitions(
  db: Executor,
  businessId: string,
  opts?: { includeInactive?: boolean },
): Promise<FeeDefinitionView[]> {
  const conditions = [eq(feeDefinitions.businessId, businessId)];
  if (!opts?.includeInactive) {
    conditions.push(eq(feeDefinitions.isActive, true));
  }

  const rows = await db
    .select()
    .from(feeDefinitions)
    .where(and(...conditions))
    .orderBy(asc(feeDefinitions.name));

  return rows.map((r) => ({
    id: r.id,
    business_id: r.businessId,
    name: r.name,
    category: r.category,
    default_basis: r.defaultBasis,
    is_active: r.isActive,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function getFeeDefinition(
  db: Executor,
  businessId: string,
  feeId: string,
): Promise<FeeDefinitionView> {
  const [row] = await db
    .select()
    .from(feeDefinitions)
    .where(and(eq(feeDefinitions.businessId, businessId), eq(feeDefinitions.id, feeId)))
    .limit(1);

  if (!row) {
    throw notFound("fee_definition");
  }

  return {
    id: row.id,
    business_id: row.businessId,
    name: row.name,
    category: row.category,
    default_basis: row.defaultBasis,
    is_active: row.isActive,
    created_at: row.createdAt.toISOString(),
  };
}

export async function createFeeDefinition(
  db: Executor,
  businessId: string,
  data: CreateFeeDefinitionInput,
): Promise<FeeDefinitionView> {
  const name = data.name.trim();
  if (!name) {
    throw new AppError("invalid_fee", 400, "Fee name cannot be empty");
  }

  const id = newId();
  const [created] = await db
    .insert(feeDefinitions)
    .values({
      id,
      businessId,
      name,
      category: data.category?.trim() || "other",
      defaultBasis: data.defaultBasis || "weight",
      isActive: true,
    })
    .returning();

  if (!created) {
    throw new AppError("db_error", 500, "Failed to create fee definition");
  }

  return {
    id: created.id,
    business_id: created.businessId,
    name: created.name,
    category: created.category,
    default_basis: created.defaultBasis,
    is_active: created.isActive,
    created_at: created.createdAt.toISOString(),
  };
}

export async function updateFeeDefinition(
  db: Executor,
  businessId: string,
  feeId: string,
  data: UpdateFeeDefinitionInput,
): Promise<FeeDefinitionView> {
  const [existing] = await db
    .select()
    .from(feeDefinitions)
    .where(and(eq(feeDefinitions.businessId, businessId), eq(feeDefinitions.id, feeId)))
    .limit(1);

  if (!existing) {
    throw notFound("fee_definition");
  }

  const values: Partial<typeof feeDefinitions.$inferInsert> = {};
  if (data.name !== undefined) values.name = data.name.trim();
  if (data.category !== undefined) values.category = data.category.trim();
  if (data.defaultBasis !== undefined) values.defaultBasis = data.defaultBasis;
  if (data.isActive !== undefined) values.isActive = data.isActive;

  const [updated] = await db
    .update(feeDefinitions)
    .set(values)
    .where(and(eq(feeDefinitions.businessId, businessId), eq(feeDefinitions.id, feeId)))
    .returning();

  if (!updated) {
    throw notFound("fee_definition");
  }

  return {
    id: updated.id,
    business_id: updated.businessId,
    name: updated.name,
    category: updated.category,
    default_basis: updated.defaultBasis,
    is_active: updated.isActive,
    created_at: updated.createdAt.toISOString(),
  };
}

export async function deleteFeeDefinition(
  db: Executor,
  businessId: string,
  feeId: string,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(feeDefinitions)
    .where(and(eq(feeDefinitions.businessId, businessId), eq(feeDefinitions.id, feeId)))
    .limit(1);

  if (!existing) {
    throw notFound("fee_definition");
  }

  // Soft-delete by marking as inactive
  await db
    .update(feeDefinitions)
    .set({ isActive: false })
    .where(and(eq(feeDefinitions.businessId, businessId), eq(feeDefinitions.id, feeId)));
}
