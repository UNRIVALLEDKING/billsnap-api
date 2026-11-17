import { describe, expect, test } from "bun:test";
import { fyOf, fyRange } from "./fy";

describe("fyOf", () => {
  test("April starts a new year, March ends the old one", () => {
    expect(fyOf("2025-04-01")).toBe("2025-26");
    expect(fyOf("2026-03-31")).toBe("2025-26");
    expect(fyOf("2026-04-01")).toBe("2026-27");
    expect(fyOf("2026-01-15")).toBe("2025-26");
  });

  test("century rollover", () => {
    expect(fyOf("2099-05-01")).toBe("2099-00");
  });

  test("rejects bad dates", () => {
    for (const bad of ["2025-13-01", "25-04-01", "2025/04/01", ""]) {
      expect(() => fyOf(bad)).toThrow(TypeError);
    }
  });
});

describe("fyRange", () => {
  test("returns inclusive bounds", () => {
    expect(fyRange("2025-26")).toEqual({ from: "2025-04-01", to: "2026-03-31" });
    expect(fyRange("2099-00")).toEqual({ from: "2099-04-01", to: "2100-03-31" });
  });

  test("round trips with fyOf", () => {
    const { from, to } = fyRange("2024-25");
    expect(fyOf(from)).toBe("2024-25");
    expect(fyOf(to)).toBe("2024-25");
  });

  test("rejects inconsistent labels", () => {
    for (const bad of ["2025-27", "2025", "25-26"]) expect(() => fyRange(bad)).toThrow(TypeError);
  });
});
