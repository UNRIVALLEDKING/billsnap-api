import { describe, expect, test } from "bun:test";
import {
  builtinFactor,
  convertUnit,
  getUnitType,
  lineStockFactor,
  normalizeUnit,
  stockFactor,
} from "./units";

describe("units", () => {
  test("unit normalization", () => {
    expect(normalizeUnit("  KG ")).toBe("kg");
    expect(normalizeUnit(null)).toBe("pcs");
    expect(normalizeUnit("")).toBe("pcs");
  });

  test("unit types", () => {
    expect(getUnitType("kg")).toBe("weight");
    expect(getUnitType("g")).toBe("weight");
    expect(getUnitType("quintal")).toBe("weight");
    expect(getUnitType("litre")).toBe("volume");
    expect(getUnitType("ml")).toBe("volume");
    expect(getUnitType("pcs")).toBe("count");
    expect(getUnitType("dozen")).toBe("count");
    expect(getUnitType("mystery")).toBe("unknown");
  });

  test("weight conversions", () => {
    // 500 grams to kg = 0.5 kg
    expect(convertUnit("500", "g", "kg").toString()).toBe("0.5");
    // 2.5 kg to g = 2500 g
    expect(convertUnit("2.5", "kg", "g").toString()).toBe("2500");
    // 3 quintal to kg = 300 kg
    expect(convertUnit("3", "quintal", "kg").toString()).toBe("300");
    // 1 tonne to kg = 1000 kg
    expect(convertUnit("1", "tonne", "kg").toString()).toBe("1000");
    // 50 kg to quintal = 0.5 quintal
    expect(convertUnit("50", "kg", "quintal").toString()).toBe("0.5");
  });

  test("volume conversions", () => {
    // 750 ml to l = 0.75 l
    expect(convertUnit("750", "ml", "l").toString()).toBe("0.75");
    // 2 litre to ml = 2000 ml
    expect(convertUnit("2", "litre", "ml").toString()).toBe("2000");
  });

  test("count conversions", () => {
    // 2 dozen to pcs = 24 pcs
    expect(convertUnit("2", "dozen", "pcs").toString()).toBe("24");
    // 12 pcs to dozen = 1 dozen
    expect(convertUnit("12", "pcs", "dozen").toString()).toBe("1");
  });

  test("incompatible units return value as-is", () => {
    // 5 pcs to kg (cannot convert directly)
    expect(convertUnit("5", "pcs", "kg").toString()).toBe("5");
  });
});

describe("stock conversion rule (BILL_ACCURACY_PLAN section 3)", () => {
  const f = (d: { toFixed(): string } | null) => d?.toFixed() ?? null;
  const babyCorn = [
    { unit: "box", perUnit: "45" },
    { unit: "kg", perUnit: "5" },
  ];

  test("same unit is 1; same kind uses the built-in factor", () => {
    expect(f(stockFactor("pcs", "pcs", []))).toBe("1");
    expect(f(stockFactor("g", "kg", []))).toBe("0.001");
    expect(f(stockFactor("quintal", "kg", []))).toBe("100");
    expect(f(stockFactor("ml", "l", []))).toBe("0.001");
    expect(f(stockFactor("dozen", "pcs", []))).toBe("12");
  });

  test("containers and other kinds need the item's own factor", () => {
    expect(builtinFactor("box", "pcs")).toBeNull();
    expect(builtinFactor("pkt", "pcs")).toBeNull();
    expect(stockFactor("pcs", "kg", [])).toBeNull();
    expect(stockFactor("box", "kg", [])).toBeNull();
    expect(f(stockFactor("box", "pcs", babyCorn))).toBe("45");
    expect(f(stockFactor("kg", "pcs", babyCorn))).toBe("5");
    expect(f(stockFactor("box", "kg", [{ unit: "box", perUnit: "37.5" }]))).toBe("37.5");
  });

  test("one built-in step to an own unit: 500 g of baby corn is 2.5 pcs", () => {
    expect(f(stockFactor("g", "pcs", babyCorn))).toBe("0.005");
    expect(stockFactor("l", "pcs", babyCorn)).toBeNull();
  });

  test("the built-in factor wins over an own row for a unit of the same kind", () => {
    expect(f(stockFactor("g", "kg", [{ unit: "g", perUnit: "5" }]))).toBe("0.001");
  });
});

describe("line conversion with party specs (CUSTOMER_SPECS_PLAN B7)", () => {
  const r = (x: ReturnType<typeof lineStockFactor>) => (x ? [x.factor.toFixed(), x.source] : null);
  const flipkart = { packUnit: "box", packQty: "200", packQtyUnit: "g" };
  const itemBox = [{ unit: "box", perUnit: "5" }];

  test("same, then built-in, before any spec", () => {
    expect(r(lineStockFactor("kg", "kg", itemBox, flipkart))).toEqual(["1", "same"]);
    expect(r(lineStockFactor("g", "kg", itemBox, flipkart))).toEqual(["0.001", "builtin"]);
  });

  test("the party spec comes before the item's own units", () => {
    expect(r(lineStockFactor("box", "kg", itemBox, flipkart))).toEqual(["0.2", "customer"]);
    expect(
      r(lineStockFactor("box", "kg", [], { packUnit: "box", packQty: "0.25", packQtyUnit: "kg" })),
    ).toEqual(["0.25", "customer"]);
    // A spec in pcs on a kg item converts through the item's pcs factor (1 pcs = 0.02 kg).
    expect(
      r(
        lineStockFactor("box", "kg", [{ unit: "pcs", perUnit: "0.02" }], {
          packUnit: "box",
          packQty: "12",
          packQtyUnit: "pcs",
        }),
      ),
    ).toEqual(["0.24", "customer"]);
  });

  test("a spec for another pack unit, or one that can't convert, falls through to the item", () => {
    expect(r(lineStockFactor("box", "kg", itemBox, { ...flipkart, packUnit: "crate" }))).toEqual([
      "5",
      "item",
    ]);
    expect(
      r(
        lineStockFactor("box", "kg", itemBox, {
          packUnit: "box",
          packQty: "12",
          packQtyUnit: "pcs",
        }),
      ),
    ).toEqual(["5", "item"]);
  });

  test("nothing known is null", () => {
    expect(lineStockFactor("box", "kg", [], null)).toBeNull();
    expect(lineStockFactor("box", "kg", [], { ...flipkart, packUnit: "crate" })).toBeNull();
  });
});
