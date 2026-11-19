import { dec, fmt, sum } from "../../shared/money";

export type ConfirmTotals = {
  /** Goods lines only. */
  lineAmounts: string[];
  /** Credit lines from earlier bills ("Less Broccoli"): positive amounts that come off the total. */
  creditAmounts?: string[] | undefined;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  taxesIncluded: boolean;
  otherCharges: string;
  discountTotal: string;
  roundOff: string;
};

/**
 * goods + (taxes_included ? 0 : taxes) + other_charges - discount_total - credits + round_off, as a
 * 2 dp string.
 */
export function computeConfirmedTotal(t: ConfirmTotals): string {
  const taxes = t.taxesIncluded ? "0" : sum([t.cgst, t.sgst, t.igst, t.cess]).toString();
  return fmt(
    sum(t.lineAmounts)
      .plus(taxes)
      .plus(t.otherCharges)
      .minus(t.discountTotal)
      .minus(sum(t.creditAmounts ?? []))
      .plus(t.roundOff),
  );
}

export type DiffLine = {
  description: string;
  masterProductId: string | null;
  quantity: string;
  unit: string;
  rate: string;
  amount: string;
  /** 'goods' (default) or 'credit'. */
  lineKind?: string | undefined;
};
type LineSummary = {
  description: string;
  quantity: string;
  unit: string;
  rate: string;
  amount: string;
  /** Only on credit lines. */
  line_kind?: "credit";
};
export type LinesDiff = {
  added: LineSummary[];
  removed: LineSummary[];
  changed: Array<{ description: string; before: LineSummary; after: LineSummary }>;
};

const isCredit = (l: DiffLine) => l.lineKind === "credit";
const summary = (l: DiffLine): LineSummary => ({
  description: l.description,
  quantity: l.quantity,
  unit: l.unit,
  rate: l.rate,
  amount: l.amount,
  ...(isCredit(l) ? { line_kind: "credit" as const } : {}),
});
const keyOf = (l: DiffLine) =>
  `${isCredit(l) ? "credit:" : ""}${l.masterProductId ?? `desc:${l.description.trim().toLowerCase()}`}`;
const sameLine = (a: DiffLine, b: DiffLine) =>
  a.description === b.description &&
  a.unit === b.unit &&
  dec(a.quantity).eq(dec(b.quantity)) &&
  dec(a.rate).eq(dec(b.rate)) &&
  dec(a.amount).eq(dec(b.amount));

/**
 * What an edit did to a bill's lines, for its history entry. Lines pair up by stock item (or by
 * description when unlinked), in order; unchanged pairs are left out.
 */
export function diffLines(before: DiffLine[], after: DiffLine[]): LinesDiff {
  const unmatched = [...before];
  const out: LinesDiff = { added: [], removed: [], changed: [] };
  for (const a of after) {
    const i = unmatched.findIndex((b) => keyOf(b) === keyOf(a));
    if (i < 0) {
      out.added.push(summary(a));
      continue;
    }
    const [b] = unmatched.splice(i, 1) as [DiffLine];
    if (!sameLine(b, a)) {
      out.changed.push({ description: a.description, before: summary(b), after: summary(a) });
    }
  }
  out.removed = unmatched.map(summary);
  return out;
}

// ---- Charge basis (docs/BILL_ACCURACY_PLAN.md section 4) ---------------------------------------------

export type ChargeBasis = "weight" | "value" | "packs";
const BASES: readonly string[] = ["weight", "value", "packs"];
const asBasis = (s: string | null | undefined): ChargeBasis | null =>
  s && BASES.includes(s) ? (s as ChargeBasis) : null;

/** Lowercase words, punctuation dropped, simple plurals cut ("Station charges" -> "station charge"). */
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .map((w) =>
      w.endsWith("xes") ? w.slice(0, -2) : /[^s]s$/.test(w) && w.length > 3 ? w.slice(0, -1) : w,
    )
    .join(" ");

/**
 * A charge's own basis: the one sent with it, else its fee type's default (matched by name, e.g.
 * "Ice box" to "Ice Box Packaging", or by category when only one fee type has it), else null for the
 * bill's fee_split_basis.
 */
export function chargeBasis(
  charge: {
    label: string;
    category?: string | null | undefined;
    basis?: string | null | undefined;
  },
  feeTypes: ReadonlyArray<{ name: string; category: string; defaultBasis: string }>,
): ChargeBasis | null {
  const own = asBasis(charge.basis);
  if (own) return own;
  const label = words(charge.label);
  if (label.length >= 3) {
    for (const f of feeTypes) {
      const parts = [f.name, ...f.name.split(/[/&]/)].map(words).filter((p) => p.length >= 3);
      if (
        parts.some((p) => p === label || p.startsWith(`${label} `) || label.startsWith(`${p} `))
      ) {
        return asBasis(f.defaultBasis);
      }
    }
  }
  const category = charge.category ? words(charge.category) : "";
  if (category) {
    const same = feeTypes.filter((f) => words(f.category) === category);
    const bases = new Set(same.map((f) => f.defaultBasis));
    if (bases.size === 1) return asBasis(same[0]?.defaultBasis);
  }
  return null;
}
