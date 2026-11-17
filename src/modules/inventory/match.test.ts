import { describe, expect, test } from "bun:test";
import { normalizeProductName } from "../catalog/normalize";
import { type MatchableItem, matchMasterProduct } from "./match";

const item = (displayName: string): MatchableItem => ({
  id: displayName,
  displayName,
  nameNorm: normalizeProductName(displayName),
});

const ITEMS = [
  "Tomato (Desi)",
  "Tomato (Hybrid)",
  "Tomato (Cherry)",
  "Spinach (Palak)",
  "Spinach (Baby)",
  "Onion (Red, Nashik)",
  "Onion (Big, Bellary)",
  "Onion (White)",
  "Potato (Jyoti)",
  "Potato (New, Nayi Aloo)",
  "Okra (Bhindi)",
  "Green Chilli (Hari Mirch)",
  "Apple (Shimla)",
  "Apple (Kashmiri)",
  "Apple (Fuji)",
  "Apple (Royal Gala)",
  "Apple (Green)",
  "Banana (Robusta)",
].map(item);

const match = (d: string, items = ITEMS) => matchMasterProduct(d, items)?.displayName ?? null;

describe("matchMasterProduct", () => {
  test("Hindi name resolves to the everyday variety", () => {
    expect(match("TAMATAR")).toBe("Tomato (Desi)");
  });

  test("bracket alias wins over a generic same-name item", () => {
    expect(match("Palak")).toBe("Spinach (Palak)");
  });

  test("name plus variant picks that variant", () => {
    expect(match("Onion Red")).toBe("Onion (Red, Nashik)");
    expect(match("Onion Red Nashik")).toBe("Onion (Red, Nashik)");
    expect(match("pyaz white")).toBe("Onion (White)");
  });

  test("an exact normalised name wins", () => {
    expect(match("tomato (hybrid)")).toBe("Tomato (Hybrid)");
  });

  test("ambiguous plain name returns null", () => {
    expect(match("Apple")).toBeNull();
    expect(match("seb")).toBeNull();
  });

  test("unrelated or longer different products return null", () => {
    expect(match("Hammer")).toBeNull();
    expect(match("Tomato Sauce 500g")).toBeNull();
    expect(match("Onion Powder")).toBeNull();
    expect(match("")).toBeNull();
  });

  test("plurals and Hindi in the item's own brackets", () => {
    expect(match("Tomatoes")).toBe("Tomato (Desi)");
    expect(match("bhindi")).toBe("Okra (Bhindi)");
    expect(match("hari mirch")).toBe("Green Chilli (Hari Mirch)");
    expect(match("Banana")).toBe("Banana (Robusta)");
  });

  test("a single candidate still needs a decent score", () => {
    expect(match("Tomato", [item("Tomato (Desi)")])).toBe("Tomato (Desi)");
    expect(match("Mango Pickle", [item("Mango (Alphonso)")])).toBeNull();
  });
});
