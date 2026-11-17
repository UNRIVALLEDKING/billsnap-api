import { describe, expect, test } from "bun:test";
import { computeConfirmedTotal } from "./bills.math";

const base = {
  lineAmounts: ["100.00", "200.50"],
  cgst: "9.00",
  sgst: "9.00",
  igst: "0.00",
  cess: "0.00",
  taxesIncluded: false,
  otherCharges: "50.00",
  discountTotal: "10.00",
  roundOff: "-0.50",
};

describe("computeConfirmedTotal", () => {
  test("adds taxes when they are not included", () => {
    expect(computeConfirmedTotal(base)).toBe("358.00");
  });

  test("skips taxes when included", () => {
    expect(computeConfirmedTotal({ ...base, taxesIncluded: true })).toBe("340.00");
  });

  test("no float drift", () => {
    expect(
      computeConfirmedTotal({
        ...base,
        lineAmounts: ["0.10", "0.20"],
        cgst: "0",
        sgst: "0",
        otherCharges: "0",
        discountTotal: "0",
        roundOff: "0",
      }),
    ).toBe("0.30");
  });
});
