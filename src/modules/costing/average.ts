import type Decimal from "decimal.js";
import { dec, fmt } from "../../shared/money";

/** Cost per unit at 4 decimals (₹30.6122), or null when there is no quantity to divide by. */
export function unitCost(total: string | Decimal, qty: string | Decimal): string | null {
  const q = dec(qty);
  if (q.lte(0)) return null;
  return fmt(dec(total).div(q), 4);
}

/**
 * Moving weighted average after a purchase lot of `qty` costing `cost` in total arrives.
 * When nothing is in stock, or no cost was known before (e.g. uncosted opening stock), the new lot's
 * cost becomes the average: stock already sold below zero must not drag it.
 */
export function nextAverage(p: {
  stock: string | Decimal;
  avg: string | null;
  qty: string | Decimal;
  cost: string | Decimal;
}): string {
  const stock = dec(p.stock);
  const qty = dec(p.qty);
  const cost = dec(p.cost);
  if (p.avg == null || stock.lte(0)) return fmt(cost.div(qty), 4);
  return fmt(stock.mul(dec(p.avg)).plus(cost).div(stock.plus(qty)), 4);
}

/** Value of stock on hand at the average cost; negative or uncosted stock is worth 0. */
export function stockValue(stock: string | Decimal, avg: string | null): string {
  const s = dec(stock);
  if (avg == null || s.lte(0)) return "0.0000";
  return fmt(s.mul(dec(avg)), 4);
}

/**
 * A sale line's gross profit: its goods value (after its bill-discount share, before GST) less its
 * share of the bill's charges less the cost of the stock it took out. 2 dp.
 */
export function saleProfit(
  goods: string | Decimal,
  fees: string | Decimal,
  costOfGoods: string | Decimal,
): string {
  return fmt(dec(goods).minus(dec(fees)).minus(dec(costOfGoods)));
}

/** Lowest safe selling price per unit: the higher of the average and the last landed cost. */
export function breakEven(avg: string | null, lastLanded: string | null): string | null {
  if (avg == null) return lastLanded;
  if (lastLanded == null) return avg;
  return dec(avg).gte(dec(lastLanded)) ? avg : lastLanded;
}
