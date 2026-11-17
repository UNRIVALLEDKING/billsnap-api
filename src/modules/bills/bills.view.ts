import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../../platform/db/client";
import { vendors } from "../catalog/catalog.schema";
import { billFiles, billLineItems, bills } from "./bills.schema";

export type ChargeView = {
  id: string;
  label: string;
  amount: string;
  category?: string | null;
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
  flags: string[];
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
  hsn_sac: string | null;
  gst_rate: string | null;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  flags: string[];
  /** Costing, set at confirm; null before or when not applicable (see docs/COSTING_PLAN.md section 7). */
  allocated_fees: string | null;
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
      })),
      round_off: b.roundOff,
      taxes_included: b.taxesIncluded,
      fee_split_basis: b.feeSplitBasis,
      grand_total: b.grandTotal,
      flags: b.flags,
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
          hsn_sac: l.hsnSac,
          gst_rate: l.gstRate,
          cgst: l.cgst,
          sgst: l.sgst,
          igst: l.igst,
          cess: l.cess,
          flags: l.flags,
          allocated_fees: l.allocatedFees,
          landed_cost: l.landedCost,
          landed_unit_cost: l.landedUnitCost,
          cost_of_goods: l.costOfGoods,
          gross_profit: l.grossProfit,
        })),
    });
  }
  return out;
}
