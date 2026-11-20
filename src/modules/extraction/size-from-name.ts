import { dec } from "../../shared/money";

export type NameSize = { qty: string; unit: "g" | "kg" | "ml" | "l" | "pcs" };

const UNITS: Record<string, NameSize["unit"]> = {
  g: "g",
  gm: "g",
  gms: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  ml: "ml",
  l: "l",
  ltr: "l",
  ltrs: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  pc: "pcs",
  pcs: "pcs",
  piece: "pcs",
  pieces: "pcs",
};

const ALTERNATION = Object.keys(UNITS)
  .sort((a, b) => b.length - a.length)
  .join("|");

// A number (decimals allowed), optional spaces, then a unit that is not followed by a letter or digit.
// The number may not continue a longer number or sit inside a word (but "5x200g" reads as 200 g).
const TOKEN = new RegExp(
  String.raw`(?<![\d.,])(?<![a-wyz])(\d+(?:\.\d+)?)\s*(${ALTERNATION})(?![a-z\d])`,
  "gi",
);

/**
 * The pack size an item name carries ("Leeks - 100 g", "Mango (1 Kg)"): the LAST quantity+unit token,
 * or null. Numbers without a unit (years, percents, "x 5" counts) and containers (box, crate, pkt)
 * are never sizes. Shared fixtures: size-from-name.fixtures.json (the Flutter app runs the same file).
 */
export function sizeFromName(name: string): NameSize | null {
  let found: NameSize | null = null;
  for (const m of name.matchAll(TOKEN)) {
    const unit = UNITS[(m[2] as string).toLowerCase()];
    const qty = dec(m[1] as string);
    if (unit && qty.gt(0)) found = { qty: qty.toFixed(), unit };
  }
  return found;
}
