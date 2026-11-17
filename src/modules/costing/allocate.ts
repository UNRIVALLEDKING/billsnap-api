import type Decimal from "decimal.js";
import { dec, fmt } from "../../shared/money";

/**
 * Splits one invoice's fees, bill discount and (when it is a cost) GST over that invoice's own lines.
 * Nothing here looks at other invoices: each bill's fees land only on that bill's quantities.
 *
 * Pure and money-safe (decimal strings in, decimal strings out). The app runs the same cases from
 * fixtures.json through its Dart port, so change both together.
 */

export type FeeSplitBasis = "weight" | "value";

export type AllocLine = {
  /** Line amount as printed/confirmed: qty x rate - line discount. */
  value: string;
  /** Line GST + cess. */
  tax: string;
  /** Quantity in kg, or null when the line's unit is not a weight (pcs, box, unknown). */
  weightKg: string | null;
};

export type AllocInput = {
  lines: AllocLine[];
  /** Sum of the bill's charges (transport, packing, hamali...). */
  fees: string;
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

export type AllocResult = {
  /** Basis actually used; differs from the requested one when a fallback applied. */
  basis: FeeSplitBasis | "equal";
  fallback: "not_weighable" | "no_weight" | "no_value" | null;
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

export function allocateCharges(input: AllocInput): AllocResult {
  const { lines } = input;
  const values = lines.map((l) => {
    const v = dec(l.value);
    return v.gt(0) ? v : ZERO;
  });
  const valueSum = values.reduce((a, b) => a.plus(b), ZERO);

  // Fee basis, with fallbacks: a non-weight unit anywhere -> value; nothing weighs -> value; no value -> equal.
  let basis: AllocResult["basis"] = input.basis;
  let fallback: AllocResult["fallback"] = null;
  let feeWeights: Decimal[] = values;
  if (input.basis === "weight") {
    if (lines.some((l) => l.weightKg == null)) {
      basis = "value";
      fallback = "not_weighable";
    } else {
      const kg = lines.map((l) => {
        const k = dec(l.weightKg as string);
        return k.gt(0) ? k : ZERO;
      });
      if (kg.reduce((a, b) => a.plus(b), ZERO).gt(0)) feeWeights = kg;
      else {
        basis = "value";
        fallback = "no_weight";
      }
    }
  }
  if (basis === "value" && valueSum.lte(0) && lines.length > 0) {
    basis = "equal";
    fallback = "no_value";
    feeWeights = lines.map(() => dec("1"));
  }

  const feeShares = splitPaise(input.fees, feeWeights);
  const discountShares = splitPaise(input.discount, values);
  const billTaxShares = splitPaise(input.billTax, values);

  return {
    basis,
    fallback,
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
