import { sizeFromName } from "../extraction/size-from-name";
import {
  builtinFactor,
  type ItemUnitFactor,
  normalizeUnit,
  type PackSpec,
  stockFactor,
} from "../inventory/units";

export type SuggestedSpec = { pack_unit: string; pack_qty: string; pack_qty_unit: string };

/**
 * A pack size read from the item name (docs/CUSTOMER_SPECS_PLAN.md B7), offered only when the party has
 * no spec: the line unit neither equals nor converts built-in to the stock unit, and the name's size
 * is another kind than the line unit and converts to the stock unit (built-in or the item's own units).
 * Line pcs + "10 g" + stock kg -> 1 pcs = 10 g. Never applied by the server: the app sends the factor.
 */
export function nameSuggestion(input: {
  description: string;
  lineUnit: string | null | undefined;
  stockUnit: string;
  itemUnits: readonly ItemUnitFactor[];
  partySpec: PackSpec | null;
}): SuggestedSpec | null {
  if (input.partySpec) return null;
  const line = normalizeUnit(input.lineUnit);
  if (line === normalizeUnit(input.stockUnit) || builtinFactor(line, input.stockUnit)) return null;
  const size = sizeFromName(input.description);
  if (!size || builtinFactor(line, size.unit)) return null;
  if (!stockFactor(size.unit, input.stockUnit, input.itemUnits)) return null;
  return { pack_unit: line, pack_qty: size.qty, pack_qty_unit: size.unit };
}
