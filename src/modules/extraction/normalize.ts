// Pure mapping from the validated AI output to bill and line drafts (AI_EXTRACTION sections 4 and 5).
// All arithmetic is decimal.js through shared/money; nothing here touches a JS float.
import type Decimal from "decimal.js";
import { GST_RATES, isValidGstin } from "../../shared/gst";
import { newId } from "../../shared/ids";
import { dec, fmt, round2, sum } from "../../shared/money";
import type { ExtractedLine, ExtractionOutput } from "./schema";

export type NormalizedLine = {
  description: string;
  hsnSac: string | null;
  quantity: string;
  unit: string;
  rate: string;
  discount: string;
  /** The amount printed on the paper, or null when none was read. */
  printedAmount: string | null;
  /** quantity x rate - discount. */
  amount: string;
  taxableValue: string | null;
  gstRate: string | null;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  flags: string[];
};

export type NormalizedCharge = {
  id: string;
  label: string;
  amount: string;
  category?: string | null;
};

export type NormalizedBill = {
  vendorName: string;
  gstin: string | null;
  invoiceNumber: string;
  invoiceNumberNorm: string | null;
  billDate: string | null;
  placeOfSupply: string | null;
  isReverseCharge: boolean;
  subtotal: string | null;
  discountTotal: string;
  cgstTotal: string;
  sgstTotal: string;
  igstTotal: string;
  cessTotal: string;
  otherCharges: string;
  charges: NormalizedCharge[];
  roundOff: string;
  taxesIncluded: boolean;
  grandTotal: string | null;
  flags: string[];
  lines: NormalizedLine[];
};

/** Parses a printed number: strips currency, Indian grouping and spaces; "-" or blank is null. */
export function parseNumber(raw: string | null | undefined): Decimal | null {
  if (raw == null) return null;
  let s = raw
    .replace(/₹|rs\.?|inr|rupees?|\/-/giu, "")
    .replace(/[\s,%]/gu, "")
    .trim();
  if (s === "" || /^[-–—]+$/u.test(s)) return null;
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren?.[1] !== undefined) {
    negative = true;
    s = paren[1];
  }
  if (/^[+-]?\.\d+$/.test(s)) s = s.replace(".", "0.");
  if (/^[+-]?\d+\.$/.test(s)) s = s.slice(0, -1);
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const v = dec(s.replace(/^\+/, ""));
  return negative ? v.neg() : v;
}

const ZERO = dec("0");
const tolerance = (ref: Decimal) => maxOf(dec("0.5"), ref.abs().mul("0.001"));
const maxOf = (a: Decimal, b: Decimal) => (a.gt(b) ? a : b);

const UNIT_MAP: Readonly<Record<string, string>> = {
  kg: "kg",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  g: "g",
  gm: "g",
  gms: "g",
  gram: "g",
  grams: "g",
  l: "l",
  lt: "l",
  ltr: "l",
  ltrs: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  ml: "ml",
  pcs: "pcs",
  pc: "pcs",
  piece: "pcs",
  pieces: "pcs",
  box: "box",
  boxes: "box",
  bx: "box",
  dozen: "dozen",
  doz: "dozen",
  dz: "dozen",
  pkt: "pkt",
  pkts: "pkt",
  packet: "pkt",
  packets: "pkt",
  pack: "pkt",
  bag: "bag",
  bags: "bag",
  bundle: "bundle",
  bundles: "bundle",
  bdl: "bundle",
  m: "m",
  mtr: "m",
  mtrs: "m",
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  sqft: "sqft",
  "sq.ft": "sqft",
  "sq ft": "sqft",
  hr: "hr",
  hrs: "hr",
  hour: "hr",
  hours: "hr",
  nos: "nos",
  no: "nos",
  number: "nos",
  numbers: "nos",
};

export function canonicalUnit(raw: string | null): { unit: string; known: boolean } {
  const key = (raw ?? "").toLowerCase().replace(/\s+/gu, " ").trim().replace(/\.$/, "");
  if (key === "") return { unit: "pcs", known: true };
  if (key.length > 12 || !/^[\p{L}\p{M} .]+$/u.test(key)) return { unit: "pcs", known: false };
  const mapped = UNIT_MAP[key];
  return mapped ? { unit: mapped, known: true } : { unit: key, known: false };
}

function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** `date_iso` when valid, else `date_raw` read as DD/MM/YY(YY) (two-digit years are 20YY); null when neither. */
export function parseBillDate(iso: string | null, raw: string | null): string | null {
  const i = iso?.trim();
  if (i && isValidIsoDate(i)) return i;
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const year = m[3] as string;
  const full = `${year.length === 2 ? "20" : ""}${year}-${(m[2] as string).padStart(2, "0")}-${(m[1] as string).padStart(2, "0")}`;
  return isValidIsoDate(full) ? full : null;
}

function isDateSuspect(date: string, now: Date): boolean {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const ahead = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2));
  const behind = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 18, now.getUTCDate()));
  return date > day(ahead) || date < day(behind);
}

/** Uppercase, no whitespace or punctuation, leading zeros kept; null when nothing is left. */
export function normalizeInvoiceNumber(raw: string): string | null {
  const n = raw.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
  return n === "" ? null : n;
}

const GST_RATE_SET = new Set<string>(GST_RATES);

export function normalizeLine(l: ExtractedLine): NormalizedLine | null {
  let q = parseNumber(l.quantity);
  let r = parseNumber(l.rate);
  const a = parseNumber(l.amount);
  if (q === null && r === null && a === null) return null;

  const flags = new Set<string>();
  const d = parseNumber(l.discount) ?? ZERO;
  const tv = parseNumber(l.taxable_value);
  const hadAll = q !== null && r !== null && a !== null;

  if (r === null) {
    q = q ?? dec("1");
    if (a !== null && !q.isZero()) {
      r = a.plus(d).div(q).toDecimalPlaces(4);
    } else {
      r = ZERO;
      flags.add("low_confidence");
    }
  } else if (q === null) {
    q = a !== null && !r.isZero() ? a.plus(d).div(r).toDecimalPlaces(3) : dec("1");
  }
  if (q.decimalPlaces() > 3) {
    q = q.toDecimalPlaces(3);
    flags.add("low_confidence");
  }
  if (r.decimalPlaces() > 4) {
    r = r.toDecimalPlaces(4);
    flags.add("low_confidence");
  }
  if (l.uncertain_fields.some((f) => /^(quantity|qty|rate|amount)$/iu.test(f.trim()))) {
    flags.add("low_confidence");
  }

  let computed = round2(q.mul(r).minus(d));
  let printed = a === null ? null : round2(a);
  if (printed !== null && tv !== null) {
    const taxableMatches = computed.minus(tv).abs().lte(tolerance(tv));
    const printedMatches = computed.minus(printed).abs().lte(tolerance(printed));
    // The printed line amount does not match but the taxable value does: the price is tax inclusive.
    if (taxableMatches && !printedMatches) printed = round2(tv);
  }

  // Dual quantity reconciliation: if container count was parsed as qty, check if printed / r exists in description.
  if (
    hadAll &&
    printed !== null &&
    !r.isZero() &&
    computed.minus(printed).abs().gt(tolerance(printed))
  ) {
    const impliedQty = printed.plus(d).div(r);
    const impliedStr = fmt(impliedQty, 3).replace(/\.?0+$/, "");
    const regex = new RegExp(
      `(^|\\s|[^0-9.])${impliedStr.replace(".", "\\.")}($|\\s|[^0-9.]|kg|kilo|g|gm)`,
    );
    if (regex.test(l.description ?? "")) {
      q = impliedQty;
      computed = round2(q.mul(r).minus(d));
    }
  }

  if (hadAll && printed !== null && computed.minus(printed).abs().gt(tolerance(printed))) {
    flags.add("math_line");
  }

  const { unit, known } = canonicalUnit(l.unit);
  if (!known) flags.add("unit_unknown");

  const description = (l.description ?? "").replace(/\s+/gu, " ").trim();
  if (description === "") flags.add("low_confidence");

  const gst = parseNumber(l.gst_rate);
  if (gst !== null && !GST_RATE_SET.has(gst.toString())) flags.add("gst_rate_invalid");

  const tax = (v: string | null) => fmt(parseNumber(v) ?? ZERO);
  const hsn = (l.hsn_sac ?? "").replace(/\s+/gu, "");
  return {
    description,
    hsnSac: hsn === "" ? null : hsn,
    quantity: fmt(q, 3),
    unit,
    rate: fmt(r, 4),
    discount: fmt(d),
    printedAmount: printed === null ? null : fmt(printed),
    amount: fmt(computed),
    taxableValue: tv === null ? null : fmt(tv),
    gstRate: gst === null ? null : fmt(gst),
    cgst: tax(l.cgst),
    sgst: tax(l.sgst),
    igst: tax(l.igst),
    cess: tax(l.cess),
    flags: [...flags],
  };
}

export function normalizeExtraction(out: ExtractionOutput, now: Date = new Date()): NormalizedBill {
  const flags = new Set<string>();
  const lines = out.line_items.map(normalizeLine).filter((l): l is NormalizedLine => l !== null);

  const taxTotal = (bill: string | null, pick: (l: NormalizedLine) => string) =>
    parseNumber(bill) ?? sum(lines.map(pick));
  const cgst = taxTotal(out.cgst_total, (l) => l.cgst);
  const sgst = taxTotal(out.sgst_total, (l) => l.sgst);
  const igst = taxTotal(out.igst_total, (l) => l.igst);
  const cess = taxTotal(out.cess_total, (l) => l.cess);
  const tax = cgst.plus(sgst).plus(igst).plus(cess);

  const charges: NormalizedCharge[] = [];
  for (const c of out.other_charges) {
    const amt = parseNumber(c.amount);
    if (amt !== null && !amt.isZero()) {
      charges.push({
        id: newId(),
        label: (c.label ?? "Other charge").trim(),
        amount: fmt(amt),
        category: c.category ?? null,
      });
    }
  }
  const other = sum(charges.map((c) => c.amount));
  const discount = parseNumber(out.discount_total) ?? ZERO;
  const roundOff = parseNumber(out.round_off) ?? ZERO;
  const grand = parseNumber(out.grand_total);
  const items = sum(lines.map((l) => l.amount));

  const base = items.plus(other).minus(discount).plus(roundOff);
  const withoutTax = grand !== null && base.minus(grand).abs().lte(1);
  const withTax = grand !== null && base.plus(tax).minus(grand).abs().lte(1);
  const taxesIncluded = tax.gt(0) && withoutTax && !withTax;
  if (grand !== null && !withoutTax && !withTax) flags.add("math_total");

  const gstinRaw = (out.counterparty.gstin ?? "").toUpperCase().replace(/\s+/gu, "");
  const gstin = gstinRaw === "" ? null : gstinRaw;
  if (gstin !== null && !isValidGstin(gstin)) flags.add("gstin_invalid");

  const billDate = parseBillDate(out.date_iso, out.date_raw);
  if (billDate !== null && isDateSuspect(billDate, now)) flags.add("date_suspect");

  if (
    out.counterparty.name_uncertain ||
    out.counterparty.gstin_uncertain ||
    out.invoice_number_uncertain ||
    out.date_uncertain ||
    out.grand_total_uncertain
  ) {
    flags.add("low_confidence");
  }
  if (out.multiple_invoices) flags.add("multiple_invoices");

  const invoiceNumber = (out.invoice_number ?? "").replace(/\s+/gu, " ").trim();
  const subtotal = parseNumber(out.subtotal);
  const pos = (out.place_of_supply ?? "").trim();
  return {
    vendorName: (out.counterparty.name ?? "").replace(/\s+/gu, " ").trim(),
    gstin,
    invoiceNumber,
    invoiceNumberNorm: normalizeInvoiceNumber(invoiceNumber),
    billDate,
    placeOfSupply: pos === "" ? null : pos,
    isReverseCharge: out.reverse_charge,
    subtotal: subtotal === null ? null : fmt(subtotal),
    discountTotal: fmt(discount),
    cgstTotal: fmt(cgst),
    sgstTotal: fmt(sgst),
    igstTotal: fmt(igst),
    cessTotal: fmt(cess),
    otherCharges: fmt(other),
    charges,
    roundOff: fmt(roundOff),
    taxesIncluded,
    grandTotal: grand === null ? null : fmt(grand),
    flags: [...flags],
    lines,
  };
}
