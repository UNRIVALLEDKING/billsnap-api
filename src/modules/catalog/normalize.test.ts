import { describe, expect, test } from "bun:test";
import { normalizeProductName, normalizeVendorName } from "./normalize";

describe("normalizeVendorName", () => {
  const cases: Array<[string, string]> = [
    ["Sharma Traders", "sharma traders"],
    ["  SHARMA   TRADERS ", "sharma traders"],
    ["Sharma Traders Pvt. Ltd.", "sharma traders"],
    ["Sharma Traders Private Limited", "sharma traders"],
    ["Sharma Traders LLP", "sharma traders"],
    ["Gupta & Co", "gupta"],
    ["Gupta and Sons", "gupta"],
    ["Gupta & Sons Ltd", "gupta"],
    ["Ram's Enterprise", "rams enterprise"],
    ["A-1 Fruits/Veg", "a 1 fruits veg"],
    ["Ｆｕｌｌｗｉｄｔｈ", "fullwidth"],
    ["श्री गणेश ट्रेडर्स", "श्री गणेश ट्रेडर्स"],
    ["Ltd", "ltd"],
    ["Tata & Sons", "tata"],
  ];
  test.each(cases)("%s -> %s", (input, expected) => {
    expect(normalizeVendorName(input)).toBe(expected);
  });
});

describe("normalizeProductName", () => {
  const cases: Array<[string, string]> = [
    ["Sugar 5 Kgs", "sugar 5 kg"],
    ["Sugar 5kgs", "sugar 5kg"],
    ["Oil 1 Ltr", "oil 1 l"],
    ["Oil 1.5ltr", "oil 1.5l"],
    ["1kg Sugar", "1kg sugar"],
    ["Sugar", "sugar"],
    ["Brocolli  (Large)", "brocolli large"],
    ["Parle-G 100 gms", "parle g 100 g"],
    ["Tata Salt & Pepper", "tata salt and pepper"],
  ];
  test.each(cases)("%s -> %s", (input, expected) => {
    expect(normalizeProductName(input)).toBe(expected);
  });

  test("1kg sugar and sugar stay different", () => {
    expect(normalizeProductName("1kg sugar")).not.toBe(normalizeProductName("sugar"));
  });

  test("products keep legal-looking suffixes", () => {
    expect(normalizeProductName("Gupta Ltd")).toBe("gupta ltd");
  });
});
