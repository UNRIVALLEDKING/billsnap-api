import { describe, expect, test } from "bun:test";
import { dec, sum } from "../../shared/money";
import { type AllocInput, type AllocResult, allocateCharges, splitPaise } from "./allocate";
import { breakEven, nextAverage, stockValue, unitCost } from "./average";
import fixtures from "./fixtures.json";

type Fixture = { name: string; input: AllocInput; expected: AllocResult };

describe("allocateCharges fixtures (shared with the app)", () => {
  for (const f of fixtures as Fixture[]) {
    test(f.name, () => {
      const got = allocateCharges(f.input);
      expect(got).toEqual(f.expected);
      // Fees and discount are never created or lost.
      expect(sum(got.lines.map((l) => l.fees)).eq(dec(f.input.fees))).toBe(true);
      expect(sum(got.lines.map((l) => l.discount)).eq(dec(f.input.discount))).toBe(true);
    });
  }
});

describe("splitPaise", () => {
  test("shares always add up to the total", () => {
    for (const total of ["0.01", "1.00", "99.99", "4500.00", "1234567.89"]) {
      const shares = splitPaise(total, ["7", "13", "0.5", "29", "1"]);
      expect(sum(shares).eq(dec(total))).toBe(true);
    }
  });
  test("negative total keeps its sign", () => {
    const shares = splitPaise("-10.00", ["1", "3"]);
    expect(shares.map((s) => s.toFixed(2))).toEqual(["-2.50", "-7.50"]);
  });
  test("zero-weight lines get nothing", () => {
    const shares = splitPaise("10.00", ["0", "1", "1"]);
    expect(shares.map((s) => s.toFixed(2))).toEqual(["0.00", "5.00", "5.00"]);
  });
});

describe("average cost", () => {
  test("spreadsheet: EC landed at 90.6123/kg", () => {
    expect(unitCost("9061.23", "100")).toBe("90.6123");
    expect(unitCost("1", "0")).toBeNull();
  });

  test("three sugar invoices, each with its own fees, average to 115", () => {
    // A: 100 kg @100 + 500 fees; B: 100 kg @90 + 2000 fees; A again: 100 kg @130, no fees.
    let avg: string | null = null;
    let stock = dec("0");
    for (const lot of [
      { qty: "100", cost: "10500" },
      { qty: "100", cost: "11000" },
      { qty: "100", cost: "13000" },
    ]) {
      avg = nextAverage({ stock, avg, qty: lot.qty, cost: lot.cost });
      stock = stock.plus(dec(lot.qty));
    }
    expect(avg).toBe("115.0000");
    expect(stockValue(stock, avg)).toBe("34500.0000");
    expect(breakEven(avg, "130.0000")).toBe("130.0000");
  });

  test("a later invoice's fees do not change earlier stock's share", () => {
    // 100 kg at 105 in stock, then 50 kg with its own 1000 fees on 50 x 100 = 5000 goods.
    const avg = nextAverage({ stock: "100", avg: "105", qty: "50", cost: "6000" });
    // (10500 + 6000) / 150 = 110: the 1000 only raised the 50 kg lot to 120/kg.
    expect(avg).toBe("110.0000");
  });

  test("stock at or below zero restarts the average at the new lot", () => {
    expect(nextAverage({ stock: "-20", avg: "90", qty: "100", cost: "13000" })).toBe("130.0000");
    expect(nextAverage({ stock: "50", avg: null, qty: "100", cost: "10500" })).toBe("105.0000");
  });

  test("uncosted or negative stock is worth nothing", () => {
    expect(stockValue("50", null)).toBe("0.0000");
    expect(stockValue("-5", "100")).toBe("0.0000");
  });

  test("break-even with one side unknown", () => {
    expect(breakEven(null, null)).toBeNull();
    expect(breakEven("115.0000", null)).toBe("115.0000");
    expect(breakEven(null, "130.0000")).toBe("130.0000");
    expect(breakEven("140.0000", "130.0000")).toBe("140.0000");
  });
});
