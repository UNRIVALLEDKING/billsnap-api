import { describe, expect, test } from "bun:test";
import { dec, fmt, lineAmount, round2, sum } from "./money";

describe("dec", () => {
  test("parses plain decimal strings", () => {
    expect(dec("1250.50").toString()).toBe("1250.5");
    expect(dec(" -3 ").toString()).toBe("-3");
  });

  test("rejects floats, NaN and malformed strings", () => {
    expect(() => dec(1.5 as unknown as string)).toThrow(TypeError);
    expect(() => dec(Number.NaN as unknown as string)).toThrow(TypeError);
    for (const bad of ["", "NaN", "Infinity", "1e3", "1,000", "Rs10", ".5", "1.", "--1"]) {
      expect(() => dec(bad)).toThrow(TypeError);
    }
  });
});

describe("rounding", () => {
  test("round2 is half-up", () => {
    expect(fmt(round2("1.005"))).toBe("1.01");
    expect(fmt(round2("2.675"))).toBe("2.68");
    expect(fmt(round2("1.004"))).toBe("1.00");
    expect(fmt(round2("-1.005"))).toBe("-1.01");
  });

  test("fmt pads and avoids exponent notation", () => {
    expect(fmt("5")).toBe("5.00");
    expect(fmt("0.0000001", 7)).toBe("0.0000001");
    expect(fmt("123456789012.5")).toBe("123456789012.50");
    expect(fmt("2.5", 0)).toBe("3");
  });
});

describe("arithmetic", () => {
  test("lineAmount is exact where floats are not", () => {
    expect(0.1 * 3).not.toBe(0.3);
    expect(fmt(lineAmount("3", "0.1"))).toBe("0.30");
    expect(fmt(lineAmount("2.5", "12.3456"))).toBe("30.86");
    expect(fmt(lineAmount("0.333", "100.0001"))).toBe("33.30");
  });

  test("sum of tenths is exact", () => {
    expect(fmt(sum(Array(10).fill("0.1")))).toBe("1.00");
    expect(fmt(sum([]))).toBe("0.00");
  });
});
