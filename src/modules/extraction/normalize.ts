// Pure mapping from the validated AI output to bill and line drafts (AI_EXTRACTION sections 4 and 5).
// All arithmetic is decimal.js through shared/money; nothing here touches a JS float.
import type Decimal from "decimal.js";
import { GST_RATES, isValidGstin } from "../../shared/gst";
import { newId } from "../../shared/ids";
import { dec, fmt, round2, sum } from "../../shared/money";
import type { ExtractedParties, ExtractedParty } from "../bills/bills.schema";
import { normalizeVendorName } from "../catalog/normalize";
import type { ExtractedDeduction, ExtractedLine, ExtractionOutput } from "./schema";

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
  /** Containers the line came in ("4.000" "box"); both null when none were read. */
  packCount: string | null;
  packUnit: string | null;
  /** "credit" for a deduction from an earlier bill ("Less Broccoli"); its positive amount comes off. */
  lineKind: "goods" | "credit";
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
  /** Seller and buyer as read (null when a side was not read). */
  extractedParties: ExtractedParties;
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

const PACK_UNITS: Readonly<Record<string, string>> = {
  box: "box",
  boxes: "box",
  bx: "box",
  carton: "box",
  cartons: "box",
  crate: "crate",
  crates: "crate",
  bori: "bori",
  bora: "bori",
  boris: "bori",
  peti: "peti",
  petis: "peti",
  nag: "nag",
  nags: "nag",
  bag: "bag",
  bags: "bag",
};
const PACK_IN_TEXT =
  /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(boxes|box|bx|cartons?|crates?|boris|bori|bora|petis|peti|nags|nag|bags?)\b/iu;

/** The container count of a line: package_count / package_unit when read, else "4 BOX" in the text. */
export function normalizePack(
  count: string | null,
  unit: string | null,
  description: string | null,
): { packCount: string | null; packUnit: string | null } {
  const toUnit = (raw: string | null) => {
    const key = (raw ?? "").toLowerCase().replace(/[\s.]+/gu, "");
    if (key === "") return "box";
    return PACK_UNITS[key] ?? (/^\p{L}{1,12}$/u.test(key) ? key : "box");
  };
  const n = parseNumber(count)?.abs();
  if (n?.gt(0)) return { packCount: fmt(n, 3), packUnit: toUnit(unit) };
  const m = PACK_IN_TEXT.exec(description ?? "");
  if (m?.[1] && m[2] && dec(m[1]).gt(0)) {
    return { packCount: fmt(dec(m[1]), 3), packUnit: toUnit(m[2]) };
  }
  return { packCount: null, packUnit: null };
}

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
    ...normalizePack(l.package_count, l.package_unit, l.description),
    lineKind: "goods",
    flags: [...flags],
  };
}

/** Strips the sign a deduction may be printed with ("-1890", "(1890)"): credits are stored positive. */
const unsigned = (v: string | null) =>
  v == null ? null : v.trim().replace(/^[-–(\s]+|[)\s]+$/gu, "");

/**
 * A deduction from an earlier bill as a credit line: "Less Broccoli 27 x 70 = 1890" becomes Broccoli,
 * 27 kg at 70, amount 1890, line kind "credit". The leading "Less" / "Minus" / ... word is dropped.
 */
export function normalizeDeduction(d: ExtractedDeduction): NormalizedLine | null {
  const description = (d.description ?? "")
    .replace(/^\s*(less|minus|kam|ghata|वापसी|return(ed)?)(?![\p{L}\p{M}])[\s:.-]*/iu, "")
    .trim();
  const l = normalizeLine({
    description,
    hsn_sac: null,
    quantity: unsigned(d.quantity),
    unit: d.unit,
    rate: unsigned(d.rate),
    discount: null,
    taxable_value: null,
    gst_rate: null,
    cgst: null,
    sgst: null,
    igst: null,
    cess: null,
    amount: unsigned(d.amount),
    package_count: null,
    package_unit: null,
    uncertain_fields: [],
  });
  return l === null ? null : { ...l, packCount: null, packUnit: null, lineKind: "credit" };
}

export function normalizeExtraction(
  out: ExtractionOutput,
  now: Date = new Date(),
  party?: PartyContext,
): NormalizedBill {
  const flags = new Set<string>();
  const goods = out.line_items.map(normalizeLine).filter((l): l is NormalizedLine => l !== null);
  const credits = out.deductions
    .map(normalizeDeduction)
    .filter((l): l is NormalizedLine => l !== null);
  const lines = [...goods, ...credits];

  const taxTotal = (bill: string | null, pick: (l: NormalizedLine) => string) =>
    parseNumber(bill) ?? sum(goods.map(pick));
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
  const items = sum(goods.map((l) => l.amount));
  const credited = sum(credits.map((l) => l.amount));

  const base = items.plus(other).minus(discount).minus(credited).plus(roundOff);
  const withoutTax = grand !== null && base.minus(grand).abs().lte(1);
  const withTax = grand !== null && base.plus(tax).minus(grand).abs().lte(1);
  const taxesIncluded = tax.gt(0) && withoutTax && !withTax;
  if (grand !== null && !withoutTax && !withTax) flags.add("math_total");

  const counterparty = pickCounterparty(out, party);
  for (const f of counterparty.flags) flags.add(f);
  const gstin = counterparty.gstin;
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
    vendorName: counterparty.name,
    gstin,
    extractedParties: counterparty.parties,
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

// ---- Our own business on the bill (docs/CUSTOMER_SPECS_PLAN.md B6) -----------------------------------

/** The business reading the bill: its name, other names on bills, and GSTIN. */
export type OwnBusiness = { name: string; gstin: string | null; aliases: readonly string[] };

const cleanGstin = (raw: string | null | undefined): string | null => {
  const g = (raw ?? "").toUpperCase().replace(/\s+/gu, "");
  return g === "" ? null : g;
};

/**
 * True when a party on a bill is our own business: by GSTIN when both have one (it decides), else by
 * the normalised name against the business name and its aliases.
 */
export function isOwnParty(
  p: { name: string | null; gstin: string | null },
  own: OwnBusiness,
): boolean {
  const g = cleanGstin(p.gstin);
  const og = cleanGstin(own.gstin);
  if (g && og && isValidGstin(g) && isValidGstin(og)) return g === og;
  const n = normalizeVendorName(p.name ?? "");
  if (n === "") return false;
  return [own.name, ...own.aliases].some((a) => normalizeVendorName(a) === n);
}

/** Who reads the bill and as what: lets the normaliser tell our side from the other party. */
export type PartyContext = { billType: "purchase" | "sale"; own: OwnBusiness };

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/gu, " ").trim();

function cleanParty(
  p: { name: string | null; gstin: string | null } | null,
): ExtractedParty | null {
  if (!p) return null;
  const name = squash(p.name);
  const gstin = cleanGstin(p.gstin);
  return name === "" && gstin === null ? null : { name, gstin };
}

/**
 * The bill's other party (docs/CUSTOMER_SPECS_PLAN.md B6). The side that is our business is "us"; the
 * counterparty is the other side. When neither side is us, it goes by type (sale: buyer, purchase:
 * seller), flagged `seller_unknown` on a sale. Our side on the "wrong" type is flagged
 * `looks_like_sale` / `looks_like_purchase`. Without context (or sides) the model's `counterparty`
 * stands, unless it is our business.
 */
export function pickCounterparty(
  out: ExtractionOutput,
  ctx?: PartyContext,
): { name: string; gstin: string | null; flags: string[]; parties: ExtractedParties } {
  const seller = cleanParty(out.seller);
  const buyer = cleanParty(out.buyer);
  const parties = { seller, buyer };
  const legacy = cleanParty(out.counterparty);
  const result = (p: ExtractedParty | null, flags: string[] = []) => ({
    name: p?.name ?? "",
    gstin: p?.gstin ?? null,
    flags,
    parties,
  });
  if (!ctx) return result(legacy);

  const us = (p: ExtractedParty | null) => p !== null && isOwnParty(p, ctx.own);
  const sellerUs = us(seller);
  const buyerUs = us(buyer);
  const flags: string[] = [];
  let chosen: ExtractedParty | null;
  if (sellerUs && !buyerUs) {
    chosen = buyer;
    if (ctx.billType === "purchase") flags.push("looks_like_sale");
  } else if (buyerUs && !sellerUs) {
    chosen = seller;
    if (ctx.billType === "sale") flags.push("looks_like_purchase");
  } else {
    chosen = sellerUs ? null : ctx.billType === "sale" ? buyer : seller;
    if (ctx.billType === "sale" && !sellerUs) flags.push("seller_unknown");
  }
  if (chosen === null && legacy && !us(legacy)) chosen = legacy;
  // The same party read twice: the counterparty block may carry the GSTIN the side missed.
  if (chosen && chosen.gstin === null && legacy?.gstin && !us(legacy)) {
    const same = normalizeVendorName(legacy.name) === normalizeVendorName(chosen.name);
    if (same) chosen = { ...chosen, gstin: legacy.gstin };
  }
  return result(chosen, flags);
}
