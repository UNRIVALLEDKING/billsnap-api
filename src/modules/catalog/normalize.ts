// Deterministic name normalization for alias lookups (DATA_MODEL "Name normalization").
// Changing these rules needs a migration that recomputes every *_norm column.

const VENDOR_SUFFIXES = [
  ["private", "limited"],
  ["pvt", "ltd"],
  ["and", "co"],
  ["and", "sons"],
  ["ltd"],
  ["llp"],
];

const UNIT_ALIASES: Readonly<Record<string, string>> = {
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  gm: "g",
  gms: "g",
  gram: "g",
  grams: "g",
  ltr: "l",
  ltrs: "l",
  lt: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  mls: "ml",
  pc: "pcs",
  piece: "pcs",
  pieces: "pcs",
};
const UNIT_TOKEN = /^(\d+(?:\.\d+)?)?([a-z]+)$/;

function baseNormalize(input: string): string[] {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/['’`]/gu, "")
    .replace(/(?<=\d)\.(?=\d)/gu, "E000") // keep a decimal point between digits
    .replace(/[^\p{L}\p{N}\p{M}E000]+/gu, " ")
    .replaceAll("E000", ".")
    .split(" ")
    .filter(Boolean);
}

/** Vendor names: normalized, with trailing legal suffixes dropped. */
export function normalizeVendorName(input: string): string {
  let tokens = baseNormalize(input);
  for (let again = true; again; ) {
    again = false;
    for (const suffix of VENDOR_SUFFIXES) {
      if (
        tokens.length > suffix.length &&
        suffix.every((w, i) => tokens.at(i - suffix.length) === w)
      ) {
        tokens = tokens.slice(0, tokens.length - suffix.length);
        again = true;
        break;
      }
    }
  }
  return tokens.join(" ");
}

/** Product descriptions: normalized, unit tokens canonicalised but kept ("1kg sugar" != "sugar"). */
export function normalizeProductName(input: string): string {
  return baseNormalize(input)
    .map((token) => {
      const m = UNIT_TOKEN.exec(token);
      const unit = m?.[2] ? UNIT_ALIASES[m[2]] : undefined;
      return m && unit ? `${m[1] ?? ""}${unit}` : token;
    })
    .join(" ");
}
