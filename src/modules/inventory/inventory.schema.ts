import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "../businesses/businesses.schema";
import { vendors } from "../catalog/catalog.schema";

const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const masterProducts = pgTable(
  "master_products",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    displayName: text("display_name").notNull(),
    nameNorm: text("name_norm").notNull(),
    category: text("category"),
    standardUnit: text("standard_unit").notNull().default("kg"),
    currentStockWeight: numeric("current_stock_weight", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
    reorderLevel: numeric("reorder_level", { precision: 14, scale: 3 }),
    /** Moving weighted average landed cost per standard unit; null until a costed purchase arrives. */
    avgCost: numeric("avg_cost", { precision: 14, scale: 4 }),
    /** max(stock, 0) x avg_cost. */
    stockValue: numeric("stock_value", { precision: 16, scale: 4 }).notNull().default("0"),
    lastLandedCost: numeric("last_landed_cost", { precision: 14, scale: 4 }),
    lastPurchaseAt: date("last_purchase_at", { mode: "string" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("master_products_business_idx").on(t.businessId),
    unique("master_products_business_norm_uq").on(t.businessId, t.nameNorm),
  ],
);

export const inventoryTransactions = pgTable(
  "inventory_transactions",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    masterProductId: uuid("master_product_id")
      .notNull()
      .references(() => masterProducts.id, { onDelete: "cascade" }),
    billId: uuid("bill_id"),
    billLineItemId: uuid("bill_line_item_id"),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    transactionType: text("transaction_type").notNull(), // 'purchase_in', 'sale_out', 'purchase_return', 'manual_adjustment', 'wastage'
    deltaWeight: numeric("delta_weight", { precision: 14, scale: 3 }).notNull(),
    resultingStockWeight: numeric("resulting_stock_weight", { precision: 14, scale: 3 }).notNull(),
    /** Cost per standard unit this movement was valued at; null when no cost is known. */
    unitCost: numeric("unit_cost", { precision: 14, scale: 4 }),
    /** Signed change in stock value; null when no cost is known. */
    valueDelta: numeric("value_delta", { precision: 16, scale: 4 }),
    lotId: uuid("lot_id"),
    note: text("note"),
    /** Wastage only: spoiled, damaged, expired, theft or other. */
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("inventory_tx_business_product_idx").on(
      t.businessId,
      t.masterProductId,
      t.createdAt.desc(),
    ),
    index("inventory_tx_bill_idx").on(t.billId),
  ],
);

/**
 * One purchase line received into stock: that invoice's own quantity with that invoice's own fees.
 * Fees on one bill never reach another bill's lot.
 */
export const stockLots = pgTable(
  "stock_lots",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    masterProductId: uuid("master_product_id")
      .notNull()
      .references(() => masterProducts.id, { onDelete: "cascade" }),
    billId: uuid("bill_id"),
    billLineItemId: uuid("bill_line_item_id"),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    receivedOn: date("received_on", { mode: "string" }),
    /** In the product's standard unit. */
    qty: numeric("qty", { precision: 14, scale: 3 }).notNull(),
    baseUnitCost: numeric("base_unit_cost", { precision: 14, scale: 4 }).notNull(),
    feesPerUnit: numeric("fees_per_unit", { precision: 14, scale: 4 }).notNull(),
    landedUnitCost: numeric("landed_unit_cost", { precision: 14, scale: 4 }).notNull(),
    /** Reduced oldest-first as stock goes out. */
    remainingQty: numeric("remaining_qty", { precision: 14, scale: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("stock_lots_product_received_idx").on(
      t.businessId,
      t.masterProductId,
      t.receivedOn,
      t.createdAt,
    ),
    index("stock_lots_open_idx")
      .on(t.masterProductId, t.receivedOn, t.createdAt)
      .where(sql`${t.remainingQty} > 0`),
  ],
);

/**
 * Pack sizes and other units of an item (docs/BILL_ACCURACY_PLAN.md section 3): `per_unit` is how many
 * stock units (the item's standard_unit) are in 1 of `unit`. Baby corn counted in pcs: box -> 45,
 * kg -> 5 (approx). 'suggested' rows are learned from confirmed bills and never replace a 'user' row.
 */
export const itemUnits = pgTable(
  "item_units",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    masterProductId: uuid("master_product_id")
      .notNull()
      .references(() => masterProducts.id, { onDelete: "cascade" }),
    unit: text("unit").notNull(),
    perUnit: numeric("per_unit", { precision: 14, scale: 6 }).notNull(),
    approx: boolean("approx").notNull().default(false),
    /** 'user' (entered) or 'suggested' (learned from a bill). */
    source: text("source").notNull().default("user"),
    createdAt: createdAt(),
  },
  (t) => [unique("item_units_product_unit_uq").on(t.masterProductId, t.unit)],
);

export const feeCategoryEnum = pgEnum("fee_category", [
  "transport",
  "hamali",
  "packaging",
  "cess",
  "other",
]);

export const feeBasisEnum = pgEnum("fee_basis", ["weight", "value"]);

export const feeDefinitions = pgTable(
  "fee_definitions",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    name: text("name").notNull(),
    category: text("category").notNull().default("other"),
    defaultBasis: text("default_basis").notNull().default("weight"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("fee_defs_business_active_idx").on(t.businessId, t.isActive)],
);
