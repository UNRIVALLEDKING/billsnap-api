import type Decimal from "decimal.js";
import { dec, fmt } from "../../shared/money";

/**
 * Splits one invoice's fees, bill discount and (when it is a cost) GST over that invoice's own lines.
 * Nothing here looks at other invoices: each bill's fees land only on that bill's quantities.
 *
 * Pure and money-safe (decimal strings in, decimal strings out). The app runs the same cases from
 * fixtures.json through its Dart port, so change both together.
 *
 * Fee bases (docs/BILL_ACCURACY_PLAN.md section 4):
 * - "weight": by kg. Any line that is not a weight -> "value" (not_weighable); no kg at all -> "value"
 *   (no_weight).
 * - "value": by line value. No value at all -> "equal" (no_value).
 * - "packs": by the line's pack count (boxes, crates). Lines without packs came loose and get nothing.
 *   No line has packs -> "weight" (no_packs), then on down the weight rules.
 * `fallback` names the last reason a basis had to give way.
 *
 * Each charge can be split on its own basis: give `charges` and each is split separately (a charge
 * without a basis uses the bill's `basis`), then the line shares are added up. Without `charges`,
 * `fees` is split on `basis` as one charge.
 *
 * Fixture format (fixtures.json): { name, input: AllocInput, expected: AllocResult }.
 * - input.lines[]: { value, tax, weightKg: string | null, packs?: string | null }; packs absent = none.
 * - input.charges?: [{ amount, basis?: "weight" | "value" | "packs" | null }]; when present, input.fees
 *   is their sum.
 * - expected.charges is present exactly when input.charges is: [{ basis, fallback }] per charge, in
 *   order; expected.basis / fallback are then how the bill's own `basis` resolves over these lines.
 */

export type FeeSplitBasis = "weight" | "value" | "packs";

export type AllocLine = {
  /** Line amount as printed/confirmed: qty x rate - line discount. */
  value: string;
  /** Line GST + cess. */
  tax: string;
  /** Quantity in kg, or null when the line's unit is not a weight (pcs, box, unknown). */
  weightKg: string | null;
  /** Containers the line came in (its pack count); null or absent when it came loose. */
  packs?: string | null | undefined;
};

export type AllocCharge = {
  amount: string;
  /** This charge's basis; null or absent uses the bill's `basis`. */
  basis?: FeeSplitBasis | null | undefined;
};

export type AllocInput = {
  lines: AllocLine[];
  /** Sum of the bill's charges (transport, packing, hamali...). */
  fees: string;
  /** The charges one by one, each split on its own basis; when given, `fees` is their sum. */
  charges?: AllocCharge[] | undefined;
  /** Bill-level discount, shared by value. */
  discount: string;
  /** Bill-level GST not carried on the lines (lines show no tax, bill totals do). Shared by value. */
  billTax: string;
  /** True when line values already include GST. */
  taxesIncluded: boolean;
  /** True when GST is part of cost (no input credit claimable). */
  taxIsCost: boolean;
  basis: FeeSplitBasis;
};

export type AllocatedLine = {
  fees: string;
  discount: string;
  /** GST counted into cost for this line (0 when input credit applies). */
  tax: string;
  /** Value of the goods before GST, after the bill discount share. */
  goods: string;
  /** goods + fees + tax: what this line really cost (or, on a sale, what it brought in before fees). */
  cost: string;
};

export type AllocFallback = "no_packs" | "not_weighable" | "no_weight" | "no_value" | null;

export type ChargeSplit = {
  /** Basis actually used; differs from the requested one when a fallback applied. */
  basis: FeeSplitBasis | "equal";
  fallback: AllocFallback;
};

export type AllocResult = ChargeSplit & {
  /** Per charge, in order; present only when the input gave `charges`. */
  charges?: ChargeSplit[];
  lines: AllocatedLine[];
};

const ZERO = dec("0");

/**
 * Splits `total` over `weights` in whole paise; shares always add up to `total` exactly
 * (largest-remainder method, ties to the earlier line). Zero weights get nothing.
 */
export function splitPaise(total: string | Decimal, weights: Array<string | Decimal>): Decimal[] {
  const t = dec(total);
  const w = weights.map((x) => dec(x));
  const wSum = w.reduce((a, b) => a.plus(b), ZERO);
  if (w.length === 0 || t.isZero() || wSum.lte(0)) return w.map(() => ZERO);

  const sign = t.isNegative() ? -1 : 1;
  const paise = t.abs().mul(100);
  const raw = w.map((x) => paise.mul(x).div(wSum));
  const floors = raw.map((r) => r.floor());
  let left = paise.minus(floors.reduce((a, b) => a.plus(b), ZERO)).toNumber();
  const order = raw
    .map((r, i) => ({ i, rem: r.minus(floors[i] as Decimal) }))
    .filter(({ i }) => (w[i] as Decimal).gt(0))
    .sort((a, b) => b.rem.comparedTo(a.rem) || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] as Decimal).plus(1);
    left -= 1;
  }
  return floors.map((f) => f.div(100).mul(sign));
}

/** The shares a fee is split by on `requested`, falling back as described at the top. */
function feeWeights(
  lines: AllocLine[],
  values: Decimal[],
  valueSum: Decimal,
  requested: FeeSplitBasis,
): ChargeSplit & { weights: Decimal[] } {
  let basis: ChargeSplit["basis"] = requested;
  let fallback: AllocFallback = null;
  let weights: Decimal[] = values;
  const positive = (s: string | null | undefined) => {
    const d = s == null ? ZERO : dec(s);
    return d.gt(0) ? d : ZERO;
  };
  const total = (xs: Decimal[]) => xs.reduce((a, b) => a.plus(b), ZERO);

  if (basis === "packs") {
    const packs = lines.map((l) => positive(l.packs));
    if (total(packs).gt(0)) return { basis, fallback, weights: packs };
    basis = "weight";
    fallback = "no_packs";
  }
  if (basis === "weight") {
    if (lines.some((l) => l.weightKg == null)) {
      basis = "value";
      fallback = "not_weighable";
    } else {
      const kg = lines.map((l) => positive(l.weightKg));
      if (total(kg).gt(0)) return { basis, fallback, weights: kg };
      basis = "value";
      fallback = "no_weight";
    }
  }
  if (basis === "value" && valueSum.lte(0) && lines.length > 0) {
    basis = "equal";
    fallback = "no_value";
    weights = lines.map(() => dec("1"));
  }
  return { basis, fallback, weights };
}

export function allocateCharges(input: AllocInput): AllocResult {
  const { lines } = input;
  const values = lines.map((l) => {
    const v = dec(l.value);
    return v.gt(0) ? v : ZERO;
  });
  const valueSum = values.reduce((a, b) => a.plus(b), ZERO);

  const bill = feeWeights(lines, values, valueSum, input.basis);
  let feeShares: Decimal[];
  let charges: ChargeSplit[] | undefined;
  if (input.charges) {
    // Each charge on its own basis, in whole paise, then added up per line.
    feeShares = lines.map(() => ZERO);
    charges = input.charges.map((c) => {
      const split = feeWeights(lines, values, valueSum, c.basis ?? input.basis);
      splitPaise(c.amount, split.weights).forEach((share, i) => {
        feeShares[i] = (feeShares[i] as Decimal).plus(share);
      });
      return { basis: split.basis, fallback: split.fallback };
    });
  } else {
    feeShares = splitPaise(input.fees, bill.weights);
  }
  const discountShares = splitPaise(input.discount, values);
  const billTaxShares = splitPaise(input.billTax, values);

  return {
    basis: bill.basis,
    fallback: bill.fallback,
    ...(charges ? { charges } : {}),
    lines: lines.map((l, i) => {
      const lineTax = dec(l.tax);
      const billTax = billTaxShares[i] as Decimal;
      const disc = discountShares[i] as Decimal;
      const fee = feeShares[i] as Decimal;
      const gross = dec(l.value);
      const beforeTax = input.taxesIncluded ? gross.minus(lineTax).minus(billTax) : gross;
      const goods = beforeTax.minus(disc);
      const tax = input.taxIsCost ? lineTax.plus(billTax) : ZERO;
      return {
        fees: fmt(fee),
        discount: fmt(disc),
        tax: fmt(tax),
        goods: fmt(goods),
        cost: fmt(goods.plus(fee).plus(tax)),
      };
    }),
  };
}
