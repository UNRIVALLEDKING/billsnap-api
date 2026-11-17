import { expect, test } from "bun:test";
import { canonicalUnit } from "./normalize";
import { extractionOutput, incompleteRead } from "./schema";

const parse = (o: object) => extractionOutput.parse({ is_bill: true, line_items: [], ...o });

test("a read with no numbers at all is rejected", () => {
  expect(
    incompleteRead(parse({ line_items: [{ description: "Tomato", quantity: "10" }] })),
  ).not.toBeNull();
});

test("a read with amounts or a total is usable", () => {
  expect(
    incompleteRead(parse({ line_items: [{ description: "Tomato", amount: "300" }] })),
  ).toBeNull();
  expect(incompleteRead(parse({ grand_total: "300" }))).toBeNull();
});

test("something that isn't a bill is not treated as incomplete", () => {
  expect(incompleteRead(extractionOutput.parse({ is_bill: false, line_items: [] }))).toBeNull();
});

test("garbage in the unit field falls back to pcs", () => {
  expect(canonicalUnit("kg崇 rate: 30.00 -> wait, rate=")).toEqual({ unit: "pcs", known: false });
});
