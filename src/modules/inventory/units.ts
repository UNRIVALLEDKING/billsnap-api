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
