import { fmt, sum } from "../../shared/money";

export type ConfirmTotals = {
  lineAmounts: string[];
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  taxesIncluded: boolean;
  otherCharges: string;
  discountTotal: string;
  roundOff: string;
};

/** sum(amount) + (taxes_included ? 0 : taxes) + other_charges - discount_total + round_off, as a 2 dp string. */
export function computeConfirmedTotal(t: ConfirmTotals): string {
  const taxes = t.taxesIncluded ? "0" : sum([t.cgst, t.sgst, t.igst, t.cess]).toString();
  return fmt(
    sum(t.lineAmounts).plus(taxes).plus(t.otherCharges).minus(t.discountTotal).plus(t.roundOff),
  );
}
