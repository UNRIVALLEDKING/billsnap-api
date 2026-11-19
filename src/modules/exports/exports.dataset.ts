import { fmt, sum } from "../../shared/money";
import { computeConfirmedTotal } from "../bills/bills.math";
import type { billLineItems, bills } from "../bills/bills.schema";
import type {
  ExportDataset,
  ExportItemRow,
  ExportSummaryRow,
  ExportVendorSpendRow,
} from "./exports.schema";
import type { TallyBill, TallyBillLine } from "./writers/tally.writer";

export type ExportBillRow = typeof bills.$inferSelect;
export type ExportLineRow = typeof billLineItems.$inferSelect;
export type VendorInfo = { name: string; gstin: string | null };

const num = (v: string | null | undefined): number => Number(v) || 0;
const isCredit = (l: Pick<ExportLineRow, "lineKind">) => l.lineKind === "credit";

/** Goods, credits and the payable for one bill, worked out with Decimal and returned as numbers. */
export function billMoney(b: ExportBillRow, lines: ExportLineRow[]) {
  const goodsLines = lines.filter((l) => !isCredit(l));
  const creditLines = lines.filter(isCredit);
  const goods =
    lines.length > 0 ? fmt(sum(goodsLines.map((l) => l.amount ?? "0"))) : fmt(b.subtotal ?? "0");
  const credits = fmt(sum(creditLines.map((l) => l.amount ?? "0")));
  const charges =
    b.charges && b.charges.length > 0
      ? fmt(sum(b.charges.map((c) => c.amount || "0")))
      : fmt(b.otherCharges ?? "0");
  const payable =
    b.confirmedTotal ??
    computeConfirmedTotal({
      lineAmounts: [goods],
      creditAmounts: [credits],
      cgst: b.cgstTotal,
      sgst: b.sgstTotal,
      igst: b.igstTotal,
      cess: b.cessTotal,
      taxesIncluded: b.taxesIncluded,
      otherCharges: charges,
      discountTotal: b.discountTotal,
      roundOff: b.roundOff,
    });
  return {
    goods: Number(goods),
    credits: Number(credits),
    charges: Number(charges),
    payable: Number(payable),
  };
}

export function buildExportDataset(input: {
  bills: ExportBillRow[];
  lines: ExportLineRow[];
  vendors: Map<string, VendorInfo>;
  /** Invoice numbers of the earlier bills that credit lines point at. */
  refInvoices?: Map<string, string | null>;
}): ExportDataset {
  const { bills: billRows, lines, vendors, refInvoices } = input;
  const billMap = new Map(billRows.map((b) => [b.id, b]));
  const linesByBill = new Map<string, ExportLineRow[]>();
  for (const l of lines) {
    const arr = linesByBill.get(l.billId) ?? [];
    arr.push(l);
    linesByBill.set(l.billId, arr);
  }
  const vendorOf = (b: ExportBillRow | undefined) => {
    const v = b?.vendorId ? vendors.get(b.vendorId) : undefined;
    return { info: v, name: v?.name ?? b?.vendorNameRaw ?? "" };
  };

  const money = new Map(billRows.map((b) => [b.id, billMoney(b, linesByBill.get(b.id) ?? [])]));

  const summary: ExportSummaryRow[] = billRows.map((b) => {
    const { info, name } = vendorOf(b);
    const m = money.get(b.id);
    return {
      id: b.id,
      billDate: b.billDate,
      type: b.type === "purchase" ? "Purchase" : "Sale",
      invoiceNumber: b.invoiceNumber,
      vendorName: name,
      gstin: b.counterpartyGstin ?? info?.gstin ?? null,
      subtotal: m?.goods ?? 0,
      cgst: num(b.cgstTotal),
      sgst: num(b.sgstTotal),
      igst: num(b.igstTotal),
      cess: num(b.cessTotal),
      otherCharges: m?.charges ?? 0,
      discount: num(b.discountTotal),
      credits: m?.credits ?? 0,
      roundOff: num(b.roundOff),
      total: m?.payable ?? 0,
      status: b.status,
    };
  });

  const itemized: ExportItemRow[] = lines.map((l) => {
    const b = billMap.get(l.billId);
    const credit = isCredit(l);
    const refInvoice =
      credit && l.creditRefBillId ? (refInvoices?.get(l.creditRefBillId) ?? null) : null;
    return {
      billDate: b?.billDate ?? null,
      invoiceNumber: b?.invoiceNumber ?? null,
      vendorName: vendorOf(b).name,
      description: credit ? `Less: ${l.descriptionRaw}` : l.descriptionRaw,
      hsnSac: l.hsnSac,
      quantity: num(l.quantity),
      unit: l.unit,
      rate: num(l.rate),
      discount: credit ? 0 : num(l.discount),
      // A credit is a deduction, not a purchase: no taxable value or GST of its own.
      taxableValue: credit ? 0 : num(l.taxableValue),
      gstRate: credit ? null : l.gstRate != null ? Number(l.gstRate) : null,
      cgst: credit ? 0 : num(l.cgst),
      sgst: credit ? 0 : num(l.sgst),
      igst: credit ? 0 : num(l.igst),
      lineTotal: credit ? -num(l.amount) : num(l.amount),
      lineKind: credit ? "credit" : "goods",
      creditRefInvoice: refInvoice,
    };
  });

  const spend = new Map<
    string,
    { gstin: string | null; bills: Set<string>; spend: number; qty: number }
  >();
  for (const b of billRows) {
    const { info, name } = vendorOf(b);
    const key = name || "Unspecified";
    let e = spend.get(key);
    if (!e) {
      e = { gstin: b.counterpartyGstin ?? info?.gstin ?? null, bills: new Set(), spend: 0, qty: 0 };
      spend.set(key, e);
    }
    e.bills.add(b.id);
    e.spend += money.get(b.id)?.payable ?? 0;
  }
  for (const l of lines) {
    if (isCredit(l)) continue; // a credit is not a quantity bought
    const key = vendorOf(billMap.get(l.billId)).name || "Unspecified";
    const e = spend.get(key);
    if (e) e.qty += num(l.quantity);
  }
  const vendorSpend: ExportVendorSpendRow[] = [...spend.entries()].map(([name, e]) => ({
    vendorName: name,
    gstin: e.gstin,
    totalBills: e.bills.size,
    totalSpend: e.spend,
    totalQuantity: e.qty,
  }));

  return { summary, itemized, vendorSpend };
}

export function buildTallyBills(input: {
  bills: ExportBillRow[];
  lines: ExportLineRow[];
  vendors: Map<string, VendorInfo>;
  refInvoices?: Map<string, string | null>;
}): TallyBill[] {
  const { bills: billRows, lines, vendors, refInvoices } = input;
  const byBill = new Map<string, ExportLineRow[]>();
  for (const l of lines) {
    const arr = byBill.get(l.billId) ?? [];
    arr.push(l);
    byBill.set(l.billId, arr);
  }
  return billRows.map((b) => {
    const mine = byBill.get(b.id) ?? [];
    const v = b.vendorId ? vendors.get(b.vendorId) : undefined;
    const vendorName = v?.name ?? b.vendorNameRaw ?? "Cash";
    const m = billMoney(b, mine);
    const tallyLines: TallyBillLine[] = mine.map((l) => ({
      description: l.descriptionRaw,
      quantity: num(l.quantity),
      unit: l.unit,
      rate: num(l.rate),
      amount: num(l.amount),
      lineKind: isCredit(l) ? "credit" : "goods",
    }));
    const creditRefs = mine
      .filter(isCredit)
      .map((l) => (l.creditRefBillId ? refInvoices?.get(l.creditRefBillId) : null))
      .filter((x): x is string => Boolean(x));
    return {
      id: b.id,
      type: b.type,
      billDate: b.billDate,
      invoiceNumber: b.invoiceNumber,
      vendorName,
      partyLedgerName: vendorName,
      cgst: num(b.cgstTotal),
      sgst: num(b.sgstTotal),
      igst: num(b.igstTotal),
      otherCharges: num(b.otherCharges),
      charges: (b.charges ?? []).map((c) => ({
        label: c.label,
        amount: num(c.amount),
        category: c.category,
      })),
      discount: num(b.discountTotal),
      credits: m.credits,
      creditRefs: [...new Set(creditRefs)],
      roundOff: num(b.roundOff),
      subtotal: m.goods,
      total: m.payable,
      lines: tallyLines,
    };
  });
}
