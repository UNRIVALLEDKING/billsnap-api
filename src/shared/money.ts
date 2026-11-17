import Decimal from "decimal.js";

/** Isolated Decimal constructor: half-up rounding (ties away from zero), generous precision. */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Money = Decimal;

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Parses a plain decimal string ("1250.50"). Numbers, NaN, Infinity, exponents and blanks are rejected. */
export function dec(value: string | Decimal): Decimal {
  if (value instanceof Decimal) return new D(value);
  if (typeof value !== "string") {
    throw new TypeError(`money must be a decimal string, got ${typeof value}`);
  }
  const s = value.trim();
  if (!NUMERIC.test(s)) throw new TypeError(`invalid decimal string: "${value}"`);
  return new D(s);
}

/** Rounds to 2 decimal places, half-up. */
export function round2(value: string | Decimal): Decimal {
  return dec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Fixed-point string with `dp` places (default 2), half-up; never exponent notation. */
export function fmt(value: string | Decimal, dp = 2): string {
  return dec(value).toFixed(dp, Decimal.ROUND_HALF_UP);
}

/** quantity x rate rounded to 2 dp: the line amount. */
export function lineAmount(qty: string | Decimal, rate: string | Decimal): Decimal {
  return round2(dec(qty).mul(dec(rate)));
}

export function sum(values: Array<string | Decimal>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new D(0));
}
