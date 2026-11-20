import { describe, expect, test } from "bun:test";
import { nameSuggestion } from "./name-spec";

const base = {
  description: "Kaffir Lime Leaves (Makroot) - 10 g",
  lineUnit: "pcs",
  stockUnit: "kg",
  itemUnits: [],
  partySpec: null,
};

describe("nameSuggestion", () => {
  test("pcs line + 10 g name + kg item -> suggestion", () => {
    expect(nameSuggestion(base)).toEqual({ pack_unit: "pcs", pack_qty: "10", pack_qty_unit: "g" });
  });
  test("a party spec wins (no name suggestion)", () => {
    const partySpec = { packUnit: "pcs", packQty: "0.02", packQtyUnit: "kg" };
    expect(nameSuggestion({ ...base, partySpec })).toBeNull();
  });
  test("same-kind line and stock units -> none", () => {
    expect(nameSuggestion({ ...base, lineUnit: "g" })).toBeNull();
    expect(nameSuggestion({ ...base, lineUnit: "kg" })).toBeNull();
  });
  test("1 pc on a pcs line -> none", () => {
    expect(nameSuggestion({ ...base, description: "Cabbage Red - 1 pc" })).toBeNull();
    expect(nameSuggestion({ ...base, description: "Zucchini - 1 pcs", lineUnit: "pc" })).toBeNull();
  });
  test("size unit not convertible to the stock unit -> none", () => {
    expect(nameSuggestion({ ...base, description: "Coconut water 200 ml" })).toBeNull();
  });
  test("size convertible through the item's own units", () => {
    const itemUnits = [{ unit: "l", perUnit: "1" }];
    expect(nameSuggestion({ ...base, description: "Coconut water 200 ml", itemUnits })).toEqual({
      pack_unit: "pcs",
      pack_qty: "200",
      pack_qty_unit: "ml",
    });
  });
  test("no size in the name -> none", () => {
    expect(nameSuggestion({ ...base, description: "Tomato" })).toBeNull();
  });
});
