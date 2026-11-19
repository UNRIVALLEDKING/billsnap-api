import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses, users } from "../businesses/businesses.schema";
import { products, vendors } from "../catalog/catalog.schema";

export const billType = pgEnum("bill_type", ["purchase", "sale"]);
export const billStatus = pgEnum("bill_status", [
  "queued",
  "processing",
  "needs_review",
  "failed",
  "confirmed",
  "discarded",
]);
export const billSource = pgEnum("bill_source", ["share", "camera", "gallery", "file"]);
export const extractionStatus = pgEnum("extraction_status", [
  "succeeded",
  "invalid_output",
  "error",
]);

const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const moneyZero = (name: string) => money(name).notNull().default("0");

export const bills = pgTable(
  "bills",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    clientRef: uuid("client_ref").notNull(),
    type: billType("type").notNull(),
    status: billStatus("status").notNull().default("queued"),
    source: billSource("source").notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    droppedAt: timestamp("dropped_at", { withTimezone: true }).notNull(),

    vendorId: uuid("vendor_id").references(() => vendors.id),
    vendorNameRaw: text("vendor_name_raw"),
    counterpartyGstin: text("counterparty_gstin"),
    suggestedVendorId: uuid("suggested_vendor_id").references(() => vendors.id),

    invoiceNumber: text("invoice_number"),
    invoiceNumberNorm: text("invoice_number_norm"),
    billDate: date("bill_date", { mode: "string" }),
    placeOfSupply: text("place_of_supply"),
    isReverseCharge: boolean("is_reverse_charge").notNull().default(false),

    subtotal: money("subtotal"),
    discountTotal: moneyZero("discount_total"),
    cgstTotal: moneyZero("cgst_total"),
    sgstTotal: moneyZero("sgst_total"),
    igstTotal: moneyZero("igst_total"),
    cessTotal: moneyZero("cess_total"),
    otherCharges: moneyZero("other_charges"),
    charges: jsonb("charges")
      .$type<
        Array<{
          id: string;
          label: string;
          amount: string;
          category?: string | null;
          /** weight, value or packs: how the charge was shared (docs/BILL_ACCURACY_PLAN.md section 4). */
          basis?: string | null;
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    roundOff: moneyZero("round_off"),
    taxesIncluded: boolean("taxes_included").notNull().default(false),
    /** The bill's basis for charges without their own: "weight" (default), "value" or "packs". */
    feeSplitBasis: text("fee_split_basis").notNull().default("weight"),
    /** The total printed on the paper, as read by the AI. */
    grandTotal: money("grand_total"),
    /** Computed at confirm from the reviewed lines; what the ledger and merges rely on. */
    confirmedTotal: money("confirmed_total"),

    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    /** Both sides as read (docs/CUSTOMER_SPECS_PLAN.md B6); null on bills read before prompt v3. */
    extractedParties: jsonb("extracted_parties").$type<ExtractedParties>(),
    duplicateOfId: uuid("duplicate_of_id").references((): AnyPgColumn => bills.id),
    failureReason: text("failure_reason"),
    latestExtractionId: uuid("latest_extraction_id"),
    /** Hex sha256 of each file, for duplicate lookups. */
    fileSha256s: text("file_sha256s").array().notNull().default(sql`'{}'::text[]`),

    confirmedBy: uuid("confirmed_by").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("bills_business_client_ref_uq").on(t.businessId, t.clientRef),
    index("bills_business_id_desc_idx").on(t.businessId, t.id.desc()),
    index("bills_vendor_idx").on(t.vendorId),
    index("bills_suggested_vendor_idx").on(t.suggestedVendorId),
    index("bills_invoice_idx")
      .on(t.businessId, t.invoiceNumberNorm)
      .where(sql`${t.invoiceNumberNorm} is not null`),
    index("bills_sha_idx").using("gin", t.fileSha256s),
  ],
);

export const billFiles = pgTable(
  "bill_files",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("bill_files_bill_position_uq").on(t.billId, t.position)],
);

export const billLineItems = pgTable(
  "bill_line_items",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    descriptionRaw: text("description_raw").notNull(),
    productId: uuid("product_id").references(() => products.id),
    suggestedProductId: uuid("suggested_product_id").references(() => products.id),
    masterProductId: uuid("master_product_id"),
    hsnSac: text("hsn_sac"),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    unit: text("unit").notNull(),
    rate: numeric("rate", { precision: 14, scale: 4 }).notNull(),
    discount: moneyZero("discount"),
    /** Amount printed on the paper for this line (null when none). */
    printedAmount: money("printed_amount"),
    taxableValue: money("taxable_value"),
    gstRate: numeric("gst_rate", { precision: 5, scale: 2 }),
    cgst: moneyZero("cgst"),
    sgst: moneyZero("sgst"),
    igst: moneyZero("igst"),
    cess: moneyZero("cess"),
    /** quantity x rate - discount. */
    amount: money("amount").notNull(),
    /** Containers the line came in, e.g. 2 "box" (docs/BILL_ACCURACY_PLAN.md section 3). */
    packCount: numeric("pack_count", { precision: 10, scale: 3 }),
    packUnit: text("pack_unit"),
    /**
     * Stock units in 1 line unit used for this line (docs/CUSTOMER_SPECS_PLAN.md B7), and where it came
     * from: same | builtin | customer (the party's pack spec) | item (item_units) | manual (chosen on
     * review for this bill only). Null on lines confirmed before B7 or without a stock item.
     */
    stockFactor: numeric("stock_factor", { precision: 14, scale: 6 }),
    stockFactorSource: text("stock_factor_source"),
    /**
     * 'goods', or 'credit': an item deducted for an earlier bill ("Less Broccoli 27 x 70"). A credit's
     * amount is positive and comes off the total (docs/BILL_ACCURACY_PLAN.md section 5).
     */
    lineKind: text("line_kind").notNull().default("goods"),
    /** Credit only: the goods were in stock and go back to the vendor (a purchase_return). */
    creditInStock: boolean("credit_in_stock").notNull().default(true),
    creditRefBillId: uuid("credit_ref_bill_id").references((): AnyPgColumn => bills.id, {
      onDelete: "set null",
    }),
    /** Credit only: amount less the stock value removed; the whole amount when not in stock. */
    creditResult: money("credit_result"),
    // Costing, written at confirm (null before, or when not applicable).
    /** This line's share of the bill's charges. */
    allocatedFees: money("allocated_fees"),
    /** Goods value after the bill discount share, before GST and fees; a sale's revenue for profit. */
    goodsValue: money("goods_value"),
    /** Purchase: goods after bill discount + fees + GST when it is a cost. */
    landedCost: money("landed_cost"),
    /** Purchase: landed_cost / quantity, per line unit. */
    landedUnitCost: numeric("landed_unit_cost", { precision: 14, scale: 4 }),
    /** Sale: quantity x average cost at the time of sale. */
    costOfGoods: money("cost_of_goods"),
    /** Sale: goods value - fees share - cost_of_goods. */
    grossProfit: money("gross_profit"),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),

    // Denormalized on confirm / merge for history queries.
    billDate: date("bill_date", { mode: "string" }),
    billType: billType("bill_type"),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    isConfirmed: boolean("is_confirmed").notNull().default(false),
  },
  (t) => [
    unique("bill_line_items_bill_position_uq").on(t.billId, t.position),
    index("bill_line_items_product_idx").on(t.productId),
    index("bill_line_items_suggested_product_idx").on(t.suggestedProductId),
    index("bill_line_items_vendor_idx").on(t.vendorId),
  ],
);

export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    attempt: smallint("attempt").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    status: extractionStatus("status").notNull(),
    output: jsonb("output"),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("extractions_bill_idx").on(t.billId)],
);

export type ExtractedParty = { name: string; gstin: string | null };
/** The seller and buyer printed on a bill, as read (either may be missing). */
export type ExtractedParties = { seller: ExtractedParty | null; buyer: ExtractedParty | null };
