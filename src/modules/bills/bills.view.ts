import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../../platform/db/client";
import { dec, fmt } from "../../shared/money";
import { vendors } from "../catalog/catalog.schema";
import { loadPackSpecs } from "../catalog/catalog.service";
import { masterProducts } from "../inventory/inventory.schema";
import { loadItemUnits } from "../inventory/inventory.service";
import { type FactorSource, lineStockFactor } from "../inventory/units";
import { billFiles, billLineItems, bills, type ExtractedParties } from "./bills.schema";
import { nameSuggestion } from "./name-spec";

export type ChargeView = {
  id: string;
  label: string;
  amount: string;
  category?: string | null;
  /** weight, value or packs; null: shared on the bill's fee_split_basis. */
  basis: "weight" | "value" | "packs" | null;
};

export type BillView = {
  id: string;
  business_id: string;
  type: "purchase" | "sale";
  status: "queued" | "processing" | "needs_review" | "failed" | "confirmed" | "discarded";
  created_at: string;
  bill_date: string | null;
  vendor_name: string;
  vendor_id: string | null;
  invoice_number: string;
  gstin: string | null;
  discount_total: string;
  cgst_total: string;
  sgst_total: string;
  igst_total: string;
  cess_total: string;
  other_charges: string;
  charges: ChargeView[];
  round_off: string;
  taxes_included: boolean;
  fee_split_basis: string;
  grand_total: string | null;
  /** Computed at confirm: goods + taxes + charges - discount - credits + round-off (what is payable). */
  confirmed_total: string | null;
  flags: string[];
  /**
   * Seller and buyer as read from the paper (docs/CUSTOMER_SPECS_PLAN.md B6), so review can offer the
   * other party when the chosen one is the business itself. Both null on bills read before prompt v3.
   */
  extracted_parties: ExtractedParties;
  duplicate_of_id: string | null;
  failure_reason: string | null;
  confirmed_at: string | null;
  files: { id: string; mime_type: string }[];
  lines: LineView[];
};

export type LineView = {
  id: string;
  description: string;
  product_id: string | null;
  master_product_id: string | null;
  quantity: string;
  unit: string;
  rate: string;
  discount: string;
  printed_amount: string | null;
  /** quantity x rate - discount; on a credit line, what comes off the total. */
  amount: string;
  hsn_sac: string | null;
  gst_rate: string | null;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  /** Containers the line came in, e.g. "2.000" "box"; null when none were noted. */
  pack_count: string | null;
  pack_unit: string | null;
  /**
   * Stock units in 1 line unit (docs/CUSTOMER_SPECS_PLAN.md B7): stored at confirm; before that (or on
   * lines confirmed before factors were stored), what the rule gives today. Null without a stock item
   * or when no factor is known yet.
   */
  stock_factor: string | null;
  /** same | builtin | customer (the party's spec) | item | manual (this bill only); null as above. */
  stock_factor_source: FactorSource | null;
  /** quantity x stock_factor, in the item's stock unit (3 dp); null when either is unknown. */
  stock_qty: string | null;
  /** The pack spec of this line's party product (its customer or vendor), or null. */
  suggested_spec: { pack_unit: string; pack_qty: string; pack_qty_unit: string } | null;
  /**
   * Where suggested_spec came from: "party" (the party product's spec), "name" (a size read from the item
   * name, only when the party has none; the app applies it by sending stock_factor), or null.
   */
  suggested_spec_source: "party" | "name" | null;
  /** "goods", or "credit": deducted for an earlier bill; its amount comes off the total. */
  line_kind: "goods" | "credit";
  /** Credit only (true on goods lines): it was in stock and went back as a purchase_return. */
  credit_in_stock: boolean;
  credit_ref_bill_id: string | null;
  /** Credit only: amount less the stock value removed (+ gain, - loss); whole amount if not in stock. */
  credit_result: string | null;
  flags: string[];
  /** Costing, set at confirm; null before or when not applicable (see docs/COSTING_PLAN.md section 7). */
  allocated_fees: string | null;
  /** Goods value after the bill discount share, before GST and fees (a sale's revenue for profit). */
  goods_value: string | null;
  landed_cost: string | null;
  landed_unit_cost: string | null;
  cost_of_goods: string | null;
  gross_profit: string | null;
};

/** Loads bills (with files and lines) of one business in the order of `ids`; unknown ids are skipped. */
export async function loadBillViews(
  x: Executor,
  businessId: string,
  ids: string[],
): Promise<BillView[]> {
  if (ids.length === 0) return [];
  const rows = await x
    .select()
    .from(bills)
    .where(and(eq(bills.businessId, businessId), inArray(bills.id, ids)));
  const files = await x
    .select({ id: billFiles.id, billId: billFiles.billId, mimeType: billFiles.mimeType })
    .from(billFiles)
    .where(and(eq(billFiles.businessId, businessId), inArray(billFiles.billId, ids)))
    .orderBy(asc(billFiles.position));
  const lines = await x
    .select()
    .from(billLineItems)
    .where(and(eq(billLineItems.businessId, businessId), inArray(billLineItems.billId, ids)))
    .orderBy(asc(billLineItems.position));
  const vendorIds = [...new Set(rows.flatMap((b) => (b.vendorId ? [b.vendorId] : [])))];
  const names = new Map<string, string>();
  if (vendorIds.length > 0) {
    const vs = await x
      .select({ id: vendors.id, name: vendors.displayName })
      .from(vendors)
      .where(inArray(vendors.id, vendorIds));
    for (const v of vs) names.set(v.id, v.name);
  }

  const factorOf = await lineFactorPreview(x, businessId, lines);

  const byId = new Map(rows.map((b) => [b.id, b]));
  const out: BillView[] = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) continue;
    out.push({
      id: b.id,
      business_id: b.businessId,
      type: b.type,
      status: b.status,
      created_at: b.createdAt.toISOString(),
      bill_date: b.billDate,
      vendor_name: (b.vendorId ? names.get(b.vendorId) : undefined) ?? b.vendorNameRaw ?? "",
      vendor_id: b.vendorId ?? b.suggestedVendorId,
      invoice_number: b.invoiceNumber ?? "",
      gstin: b.counterpartyGstin,
      discount_total: b.discountTotal,
      cgst_total: b.cgstTotal,
      sgst_total: b.sgstTotal,
      igst_total: b.igstTotal,
      cess_total: b.cessTotal,
      other_charges: b.otherCharges,
      charges: (b.charges ?? []).map((c) => ({
        id: c.id || "",
        label: c.label || "",
        amount: c.amount || "0.00",
        category: c.category ?? null,
        basis: c.basis === "weight" || c.basis === "value" || c.basis === "packs" ? c.basis : null,
      })),
      round_off: b.roundOff,
      taxes_included: b.taxesIncluded,
      fee_split_basis: b.feeSplitBasis,
      grand_total: b.grandTotal,
      confirmed_total: b.confirmedTotal,
      flags: b.flags,
      extracted_parties: b.extractedParties ?? { seller: null, buyer: null },
      duplicate_of_id: b.duplicateOfId,
      failure_reason: b.failureReason,
      confirmed_at: b.confirmedAt?.toISOString() ?? null,
      files: files.filter((f) => f.billId === id).map((f) => ({ id: f.id, mime_type: f.mimeType })),
      lines: lines
        .filter((l) => l.billId === id)
        .map((l) => ({
          id: l.id,
          description: l.descriptionRaw,
          product_id: l.productId ?? l.suggestedProductId,
          master_product_id: l.masterProductId ?? null,
          quantity: l.quantity,
          unit: l.unit,
          rate: l.rate,
          discount: l.discount,
          printed_amount: l.printedAmount,
          amount: l.amount,
          hsn_sac: l.hsnSac,
          gst_rate: l.gstRate,
          cgst: l.cgst,
          sgst: l.sgst,
          igst: l.igst,
          cess: l.cess,
          flags: l.flags,
          pack_count: l.packCount,
          pack_unit: l.packUnit,
          ...factorOf(l),
          line_kind: l.lineKind === "credit" ? "credit" : "goods",
          credit_in_stock: l.creditInStock,
          credit_ref_bill_id: l.creditRefBillId,
          credit_result: l.creditResult,
          allocated_fees: l.allocatedFees,
          goods_value: l.goodsValue,
          landed_cost: l.landedCost,
          landed_unit_cost: l.landedUnitCost,
          cost_of_goods: l.costOfGoods,
          gross_profit: l.grossProfit,
        })),
    });
  }
  return out;
}

type LineRow = typeof billLineItems.$inferSelect;

/** The B7 fields of each line: its stock factor (stored, else today's rule), stock qty and party spec. */
async function lineFactorPreview(x: Executor, businessId: string, lines: LineRow[]) {
  const specs = await loadPackSpecs(
    x,
    businessId,
    lines.flatMap((l) => {
      const p = l.productId ?? l.suggestedProductId;
      return p ? [p] : [];
    }),
  );
  const itemIds = [
    ...new Set(lines.flatMap((l) => (l.masterProductId ? [l.masterProductId] : []))),
  ];
  const items =
    itemIds.length === 0
      ? []
      : await x
          .select({ id: masterProducts.id, standardUnit: masterProducts.standardUnit })
          .from(masterProducts)
          .where(
            and(eq(masterProducts.businessId, businessId), inArray(masterProducts.id, itemIds)),
          );
  const unitsOf = await loadItemUnits(x, businessId, itemIds);

  return (l: LineRow) => {
    const productId = l.productId ?? l.suggestedProductId;
    const spec = productId ? (specs.get(productId) ?? null) : null;
    const suggested_spec = spec
      ? {
          pack_unit: spec.packUnit,
          pack_qty: dec(spec.packQty).toFixed(),
          pack_qty_unit: spec.packQtyUnit,
        }
      : null;
    let factor: string | null = null;
    let source: FactorSource | null = null;
    const item = items.find((i) => i.id === l.masterProductId);
    let suggested = suggested_spec;
    let suggestedSource: "party" | "name" | null = spec ? "party" : null;
    if (!spec && item && l.stockFactor == null) {
      const byName = nameSuggestion({
        description: l.descriptionRaw,
        lineUnit: l.unit,
        stockUnit: item.standardUnit,
        itemUnits: (unitsOf.get(item.id) ?? []).map((r) => ({ unit: r.unit, perUnit: r.perUnit })),
        partySpec: null,
      });
      if (byName) {
        suggested = byName;
        suggestedSource = "name";
      }
    }
    if (item && l.stockFactor != null) {
      factor = l.stockFactor;
      source = (l.stockFactorSource as FactorSource | null) ?? null;
    } else if (item) {
      const own = (unitsOf.get(item.id) ?? []).map((r) => ({ unit: r.unit, perUnit: r.perUnit }));
      const found = lineStockFactor(l.unit, item.standardUnit, own, spec);
      if (found) {
        factor = fmt(found.factor, 6);
        source = found.source;
      }
    }
    return {
      stock_factor: factor === null ? null : dec(factor).toFixed(),
      stock_factor_source: source,
      stock_qty: factor === null ? null : fmt(dec(l.quantity).mul(dec(factor)), 3),
      suggested_spec: suggested,
      suggested_spec_source: suggestedSource,
    };
  };
}
