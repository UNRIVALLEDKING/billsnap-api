import Decimal from "decimal.js";
import { dec } from "../../shared/money";

export type UnitType = "weight" | "volume" | "count" | "unknown";

interface UnitDef {
  type: UnitType;
  /** Factor relative to base unit of the type (base: kg for weight, l for volume, pcs for count). */
  toBase: Decimal;
}

const U = (type: UnitType, factor: string | number): UnitDef => ({
  type,
  toBase: new Decimal(factor),
});

const UNIT_MAP: Record<string, UnitDef> = {
  // Weight (base: kg)
  kg: U("weight", "1"),
  kilogram: U("weight", "1"),
  kilograms: U("weight", "1"),
  kgs: U("weight", "1"),
  g: U("weight", "0.001"),
  gm: U("weight", "0.001"),
  gram: U("weight", "0.001"),
  grams: U("weight", "0.001"),
  mg: U("weight", "0.000001"),
  quintal: U("weight", "100"),
  qtl: U("weight", "100"),
  tonne: U("weight", "1000"),
  ton: U("weight", "1000"),
  t: U("weight", "1000"),
  lb: U("weight", "0.45359237"),
  pound: U("weight", "0.45359237"),
  oz: U("weight", "0.02834952"),

  // Volume (base: l)
  l: U("volume", "1"),
  ltr: U("volume", "1"),
  litre: U("volume", "1"),
  liter: U("volume", "1"),
  litres: U("volume", "1"),
  ml: U("volume", "0.001"),
  millilitre: U("volume", "0.001"),

  // Count (base: pcs)
  pcs: U("count", "1"),
  pc: U("count", "1"),
  piece: U("count", "1"),
  pieces: U("count", "1"),
  unit: U("count", "1"),
  units: U("count", "1"),
  nos: U("count", "1"),
  no: U("count", "1"),
  box: U("count", "1"),
  boxes: U("count", "1"),
  pkt: U("count", "1"),
  packet: U("count", "1"),
  packets: U("count", "1"),
  pack: U("count", "1"),
  dozen: U("count", "12"),
  dz: U("count", "12"),
};

export function normalizeUnit(raw: string | null | undefined): string {
  if (!raw) return "pcs";
  const cleaned = raw.trim().toLowerCase();
  return cleaned;
}

export function getUnitType(unitStr: string): UnitType {
  const u = normalizeUnit(unitStr);
  return UNIT_MAP[u]?.type ?? "unknown";
}

/**
 * Converts a quantity from one unit to target unit.
 * If units are of the same type (e.g. grams -> kg), exact decimal conversion is performed.
 * If units are of different or unknown types, the quantity is returned as-is.
 * Not for stock: stock goes through stockFactor below, which never passes a number through.
 */
export function convertUnit(
  quantity: string | Decimal,
  fromUnitRaw: string | null | undefined,
  toUnitRaw: string | null | undefined,
): Decimal {
  const q = typeof quantity === "string" ? dec(quantity) : quantity;
  const from = normalizeUnit(fromUnitRaw);
  const to = normalizeUnit(toUnitRaw);

  if (from === to) return q;

  const defFrom = UNIT_MAP[from];
  const defTo = UNIT_MAP[to];

  if (!defFrom || !defTo || defFrom.type !== defTo.type) {
    // Incompatible or custom unit: cannot convert automatically, return as-is
    return q;
  }

  // Convert: value * fromFactor / toFactor
  const inBase = q.mul(defFrom.toBase);
  const inTarget = inBase.div(defTo.toBase);

  // Round to 3 decimal places for quantities/weights
  return inTarget.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

// ---- Stock conversion rule (docs/BILL_ACCURACY_PLAN.md section 3) ---------------------------------------

/** Units that name a container: their size depends on the item, so no built-in factor applies. */
const CONTAINERS = new Set(["box", "boxes", "pkt", "packet", "packets", "pack"]);

/**
 * Built-in factor, how many `to` are in 1 `from`, for two units of one kind (kg and g, l and ml, pcs
 * and dozen). Null when the kinds differ, a unit is unknown, or either is a container.
 */
export function builtinFactor(
  fromRaw: string | null | undefined,
  toRaw: string | null | undefined,
): Decimal | null {
  const from = normalizeUnit(fromRaw);
  const to = normalizeUnit(toRaw);
  if (from === to) return new Decimal(1);
  const a = UNIT_MAP[from];
  const b = UNIT_MAP[to];
  if (!a || !b || a.type !== b.type || CONTAINERS.has(from) || CONTAINERS.has(to)) return null;
  return a.toBase.div(b.toBase);
}

/** An item's own unit: `perUnit` stock units are in 1 `unit` (an item_units row). */
export type ItemUnitFactor = { unit: string; perUnit: string };

/**
 * How many stock units are in 1 `from`, or null when unknown (the caller must ask, never pass the
 * number through):
 * 1. same unit -> 1; 2. same kind -> built-in factor; 3. the item's own row for that unit;
 * 4. one built-in step to an own row (500 g of an item counted in pcs, with 1 kg ~ 5 pcs).
 */
export function stockFactor(
  fromRaw: string | null | undefined,
  stockUnit: string,
  itemUnits: readonly ItemUnitFactor[],
): Decimal | null {
  const builtin = builtinFactor(fromRaw, stockUnit);
  if (builtin) return builtin;
  const from = normalizeUnit(fromRaw);
  const own = itemUnits.find((u) => normalizeUnit(u.unit) === from);
  if (own) return dec(own.perUnit);
  for (const u of itemUnits) {
    const hop = builtinFactor(from, u.unit);
    if (hop) return hop.mul(dec(u.perUnit));
  }
  return null;
}

// ---- Line conversion with party pack specs (docs/CUSTOMER_SPECS_PLAN.md B7) ---------------------------

/** A party product's pack size: 1 `packUnit` holds `packQty` `packQtyUnit` (1 box = 0.2 kg). */
export type PackSpec = { packUnit: string; packQty: string; packQtyUnit: string };

/**
 * Where a line's stock factor came from: same unit, built-in, the party's pack spec ("customer", for
 * customers and vendors alike), the item's own units, or chosen on review for one bill ("manual").
 */
export type FactorSource = "same" | "builtin" | "customer" | "item" | "manual";

/**
 * Sources replay keeps as stored: a party spec or a review choice belongs to the bill, so later spec
 * edits never rewrite it. Same, built-in and item factors are recomputed, so editing an item's own
 * unit re-counts the stock received in it (docs/BILL_ACCURACY_PLAN.md section 3).
 */
export const STORED_SOURCES: ReadonlySet<string> = new Set<FactorSource>(["customer", "manual"]);

/** Stock units in 1 pack of `spec`, or null when its qty unit doesn't convert to the stock unit. */
export function specFactor(
  spec: PackSpec,
  stockUnit: string,
  itemUnits: readonly ItemUnitFactor[],
): Decimal | null {
  const inner = stockFactor(spec.packQtyUnit, stockUnit, itemUnits);
  return inner ? dec(spec.packQty).mul(inner) : null;
}

/**
 * The stock factor of a bill line, in order: 1. same unit; 2. built-in; 3. the line's party product
 * spec when its pack unit is the line unit; 4. the item's own units. Null when unknown.
 */
export function lineStockFactor(
  fromRaw: string | null | undefined,
  stockUnit: string,
  itemUnits: readonly ItemUnitFactor[],
  spec: PackSpec | null,
): { factor: Decimal; source: FactorSource } | null {
  const from = normalizeUnit(fromRaw);
  if (from === normalizeUnit(stockUnit)) return { factor: new Decimal(1), source: "same" };
  const builtin = builtinFactor(from, stockUnit);
  if (builtin) return { factor: builtin, source: "builtin" };
  if (spec && normalizeUnit(spec.packUnit) === from) {
    const f = specFactor(spec, stockUnit, itemUnits);
    if (f?.gt(0)) return { factor: f, source: "customer" };
  }
  const own = stockFactor(from, stockUnit, itemUnits);
  return own ? { factor: own, source: "item" } : null;
}
