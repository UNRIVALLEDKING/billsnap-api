import { describe, expect, test } from "bun:test";
import { chargeBasis, computeConfirmedTotal, diffLines } from "./bills.math";

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

describe("diffLines", () => {
  const l = (
    description: string,
    masterProductId: string | null,
    quantity: string,
    rate: string,
  ) => ({
    description,
    masterProductId,
    quantity,
    unit: "kg",
    rate,
    amount: (Number(quantity) * Number(rate)).toFixed(2),
  });

  test("pairs lines by stock item and reports only real changes", () => {
    const before = [l("Tomato", "m1", "10.000", "30.0000"), l("Onion", "m2", "5.000", "20.0000")];
    const after = [l("Onion", "m2", "5", "20"), l("Tomato", "m1", "12.000", "30.0000")];
    expect(diffLines(before, after)).toEqual({
      added: [],
      removed: [],
      changed: [
        {
          description: "Tomato",
          before: {
            description: "Tomato",
            quantity: "10.000",
            unit: "kg",
            rate: "30.0000",
            amount: "300.00",
          },
          after: {
            description: "Tomato",
            quantity: "12.000",
            unit: "kg",
            rate: "30.0000",
            amount: "360.00",
          },
        },
      ],
    });
  });

  test("added and removed lines; unlinked lines pair by description", () => {
    const before = [l("Loose Bag", null, "1", "10"), l("Garlic", "m3", "2", "100")];
    const after = [l("loose bag", null, "1", "10"), l("Ginger", "m4", "3", "80")];
    const d = diffLines(before, after);
    expect(d.added.map((x) => x.description)).toEqual(["Ginger"]);
    expect(d.removed.map((x) => x.description)).toEqual(["Garlic"]);
    // Same line, only the spelling changed.
    expect(d.changed.map((x) => x.description)).toEqual(["loose bag"]);
  });
});

describe("chargeBasis", () => {
  const feeTypes = [
    { name: "Transport / Tempo", category: "transport", defaultBasis: "weight" },
    { name: "Hamali / Loading & Unloading", category: "hamali", defaultBasis: "packs" },
    { name: "Ice Box Packaging", category: "packaging", defaultBasis: "packs" },
    { name: "Wooden Crate Packaging", category: "packaging", defaultBasis: "value" },
    { name: "APMC / Mandi Cess", category: "cess", defaultBasis: "value" },
    { name: "Station charge", category: "transport", defaultBasis: "packs" },
  ];
  const basis = (label: string, more: { category?: string; basis?: string } = {}) =>
    chargeBasis({ label, ...more }, feeTypes);

  test("the charge's own basis wins", () => {
    expect(basis("Ice box", { basis: "value" })).toBe("value");
  });

  test("matched to a fee type by name", () => {
    expect(basis("Ice box")).toBe("packs");
    expect(basis("ICE BOXES")).toBe("packs");
    expect(basis("Station charges")).toBe("packs");
    expect(basis("Hamali")).toBe("packs");
    expect(basis("Mandi cess")).toBe("value");
    expect(basis("Tempo")).toBe("weight");
  });

  test("by category only when one fee type has it; otherwise the bill's basis", () => {
    expect(basis("Coolie", { category: "hamali" })).toBe("packs");
    expect(basis("Bardana", { category: "packaging" })).toBeNull();
    expect(basis("Stn chg")).toBeNull();
    expect(basis("Misc", { basis: "bogus" })).toBeNull();
  });
});

describe("totals with credits from earlier bills", () => {
  test("bill #17550: 36560 of goods + 13400 of charges - 1890 Less Broccoli = 48070", () => {
    expect(
      computeConfirmedTotal({
        lineAmounts: ["6750", "5460", "6300", "2520", "1600", "5200", "8100", "150", "280", "200"],
        creditAmounts: ["1890.00"],
        cgst: "0",
        sgst: "0",
        igst: "0",
        cess: "0",
        taxesIncluded: false,
        otherCharges: "13400.00",
        discountTotal: "0",
        roundOff: "0",
      }),
    ).toBe("48070.00");
  });

  test("discount and credits both come off", () => {
    expect(computeConfirmedTotal({ ...base, creditAmounts: ["20.00", "5.50"] })).toBe("332.50");
  });

  test("a goods line turned into a credit shows in the edit diff", () => {
    const goods = {
      description: "Broccoli",
      masterProductId: "b",
      quantity: "27",
      unit: "kg",
      rate: "70",
      amount: "1890.00",
    };
    expect(diffLines([goods], [{ ...goods, lineKind: "credit" }])).toEqual({
      added: [
        {
          description: "Broccoli",
          quantity: "27",
          unit: "kg",
          rate: "70",
          amount: "1890.00",
          line_kind: "credit",
        },
      ],
      removed: [
        { description: "Broccoli", quantity: "27", unit: "kg", rate: "70", amount: "1890.00" },
      ],
      changed: [],
    });
  });
});
