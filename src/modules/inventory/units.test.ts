import { describe, expect, test } from "bun:test";
import { convertUnit, getUnitType, normalizeUnit } from "./units";

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
