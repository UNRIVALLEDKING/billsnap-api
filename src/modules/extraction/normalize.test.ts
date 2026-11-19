import { describe, expect, test } from "bun:test";
import {
  canonicalUnit,
  isOwnParty,
  normalizeDeduction,
  normalizeExtraction,
  normalizeInvoiceNumber,
  normalizeLine,
  parseBillDate,
  parseNumber,
} from "./normalize";
import { type ExtractedLine, type ExtractionOutput, extractionOutput } from "./schema";

const NOW = new Date("2026-10-30T10:00:00Z");

const line = (o: Partial<Record<keyof ExtractedLine, string | null | string[]>> = {}) =>
  extractionOutput.shape.line_items.parse([o])[0] as ExtractedLine;

const bill = (o: Record<string, unknown> = {}): ExtractionOutput =>
  extractionOutput.parse({ is_bill: true, line_items: [], ...o });

describe("parseNumber", () => {
  const cases: Array<[string | null, string | null]> = [
    ["1250.50", "1250.5"],
    ["₹ 1,25,000.00", "125000"],
    ["Rs. 1,250/-", "1250"],
    ["INR 99", "99"],
    ["-", null],
    ["", null],
    ["  ", null],
    [null, null],
    ["(50.25)", "-50.25"],
    ["-12.5", "-12.5"],
    [".5", "0.5"],
    ["12%", "12"],
    ["abc", null],
    ["1e5", null],
  ];
  test.each(cases)("%p -> %p", (input, expected) => {
    expect(parseNumber(input)?.toString() ?? null).toBe(expected);
  });
});

describe("canonicalUnit", () => {
  test("maps synonyms, defaults to pcs and flags unknown", () => {
    expect(canonicalUnit("KGS")).toEqual({ unit: "kg", known: true });
    expect(canonicalUnit("Ltr.")).toEqual({ unit: "l", known: true });
    expect(canonicalUnit(null)).toEqual({ unit: "pcs", known: true });
    expect(canonicalUnit("  ")).toEqual({ unit: "pcs", known: true });
    expect(canonicalUnit("Carton")).toEqual({ unit: "carton", known: false });
  });
});

describe("normalizeLine", () => {
  test("drops a line with no quantity, rate or amount", () => {
    expect(normalizeLine(line({ description: "Total" }))).toBeNull();
  });

  test("computes the amount from quantity, rate and discount", () => {
    const l = normalizeLine(
      line({ description: "Rice", quantity: "5", rate: "80", discount: "10" }),
    );
    expect(l).toMatchObject({ amount: "390.00", printedAmount: null, discount: "10.00" });
  });

  test("missing rate: quantity defaults to 1 and rate derives from the amount", () => {
    const l = normalizeLine(line({ description: "Freight", amount: "400" }));
    expect(l).toMatchObject({ quantity: "1.000", rate: "400.0000", amount: "400.00" });
  });

  test("missing rate with a quantity: rate = (amount + discount) / quantity to 4 dp", () => {
    const l = normalizeLine(line({ description: "Oil", quantity: "3", amount: "100" }));
    expect(l).toMatchObject({ quantity: "3.000", rate: "33.3333", amount: "100.00" });
  });

  test("missing quantity with a rate derives it to 3 dp", () => {
    const l = normalizeLine(line({ description: "Dal", rate: "90", amount: "100" }));
    expect(l).toMatchObject({ quantity: "1.111", rate: "90.0000" });
  });

  test("missing quantity without an amount defaults to 1", () => {
    expect(normalizeLine(line({ description: "Dal", rate: "90" }))).toMatchObject({
      quantity: "1.000",
      amount: "90.00",
    });
  });

  test("flags math_line when all three disagree beyond tolerance", () => {
    const l = normalizeLine(
      line({ description: "Rice", quantity: "5", rate: "80", amount: "450" }),
    );
    expect(l?.flags).toContain("math_line");
    expect(l?.printedAmount).toBe("450.00");
    expect(l?.amount).toBe("400.00");
  });

  test("tolerates rounding noise", () => {
    const l = normalizeLine(
      line({ description: "Rice", quantity: "3", rate: "33.33", amount: "100" }),
    );
    expect(l?.flags).not.toContain("math_line");
  });

  test("tax-inclusive price: the taxable value becomes the printed amount", () => {
    const l = normalizeLine(
      line({
        description: "Soap",
        quantity: "10",
        rate: "50",
        amount: "590",
        taxable_value: "500",
        cgst: "45",
        sgst: "45",
      }),
    );
    expect(l).toMatchObject({ printedAmount: "500.00", amount: "500.00", cgst: "45.00" });
    expect(l?.flags).not.toContain("math_line");
  });

  test("uncertain quantity, rate or amount sets low_confidence", () => {
    for (const f of ["quantity", "rate", "amount"]) {
      const l = normalizeLine(
        line({ description: "x", quantity: "1", rate: "2", amount: "2", uncertain_fields: [f] }),
      );
      expect(l?.flags).toContain("low_confidence");
    }
  });

  test("excess precision is rounded and flagged", () => {
    const l = normalizeLine(line({ description: "x", quantity: "1.23456", rate: "2.123456" }));
    expect(l).toMatchObject({ quantity: "1.235", rate: "2.1235" });
    expect(l?.flags).toContain("low_confidence");
  });

  test("unknown unit and invalid GST slab are flagged", () => {
    const l = normalizeLine(
      line({ description: "x", quantity: "1", rate: "2", unit: "carton", gst_rate: "7" }),
    );
    expect(l?.flags).toEqual(expect.arrayContaining(["unit_unknown", "gst_rate_invalid"]));
    expect(l?.unit).toBe("carton");
  });
});

describe("normalizeExtraction", () => {
  test("sums line taxes when the bill has no totals and handles other charges", () => {
    const b = normalizeExtraction(
      bill({
        counterparty: { name: "  ABC   Enterprise " },
        line_items: [
          { description: "A", quantity: "1", rate: "100", cgst: "9", sgst: "9" },
          { description: "B", quantity: "1", rate: "200", cgst: "18", sgst: "18" },
        ],
        other_charges: [
          { label: "Freight", amount: "50" },
          { label: "Packing", amount: "₹ 10" },
        ],
        grand_total: "414",
      }),
      NOW,
    );
    expect(b).toMatchObject({
      vendorName: "ABC Enterprise",
      cgstTotal: "27.00",
      sgstTotal: "27.00",
      igstTotal: "0.00",
      otherCharges: "60.00",
      taxesIncluded: false,
      grandTotal: "414.00",
    });
    expect(b.flags).not.toContain("math_total");
  });

  test("a bill-level tax total wins over line sums", () => {
    const b = normalizeExtraction(
      bill({
        cgst_total: "5",
        line_items: [{ description: "A", quantity: "1", rate: "100", cgst: "9" }],
      }),
      NOW,
    );
    expect(b.cgstTotal).toBe("5.00");
  });

  test("taxes_included when the items already reach the grand total", () => {
    const b = normalizeExtraction(
      bill({
        line_items: [{ description: "A", quantity: "1", rate: "118", cgst: "9", sgst: "9" }],
        grand_total: "118",
      }),
      NOW,
    );
    expect(b.taxesIncluded).toBe(true);
  });

  test("taxes_included is false without tax or without a grand total", () => {
    const noTax = normalizeExtraction(
      bill({ line_items: [{ description: "A", quantity: "1", rate: "100" }], grand_total: "100" }),
      NOW,
    );
    expect(noTax.taxesIncluded).toBe(false);
    const noGrand = normalizeExtraction(
      bill({ line_items: [{ description: "A", quantity: "1", rate: "100", cgst: "9" }] }),
      NOW,
    );
    expect(noGrand.taxesIncluded).toBe(false);
  });

  test("math_total when neither interpretation reconciles", () => {
    const b = normalizeExtraction(
      bill({ line_items: [{ description: "A", quantity: "1", rate: "100" }], grand_total: "250" }),
      NOW,
    );
    expect(b.flags).toContain("math_total");
  });

  test("GSTIN is uppercased and checked", () => {
    const ok = normalizeExtraction(bill({ counterparty: { gstin: "27aapfu0939f1zv" } }), NOW);
    expect(ok.gstin).toBe("27AAPFU0939F1ZV");
    expect(ok.flags).not.toContain("gstin_invalid");
    const bad = normalizeExtraction(bill({ counterparty: { gstin: "27AAPFU0939F1ZX" } }), NOW);
    expect(bad.gstin).toBe("27AAPFU0939F1ZX");
    expect(bad.flags).toContain("gstin_invalid");
    expect(normalizeExtraction(bill(), NOW).gstin).toBeNull();
  });

  test("uncertain header fields set low_confidence", () => {
    expect(normalizeExtraction(bill({ date_uncertain: true }), NOW).flags).toContain(
      "low_confidence",
    );
  });

  test("invoice number norm", () => {
    const b = normalizeExtraction(bill({ invoice_number: " inv/2026-0421 " }), NOW);
    expect(b.invoiceNumber).toBe("inv/2026-0421");
    expect(b.invoiceNumberNorm).toBe("INV20260421");
    expect(normalizeInvoiceNumber("007")).toBe("007");
    expect(normalizeInvoiceNumber("--")).toBeNull();
  });

  test("mandi dual quantity reconciles package count to billable weight in description", () => {
    const l = normalizeLine(
      line({
        description: "3 boxes cucumber 115",
        quantity: "3",
        unit: "box",
        rate: "50",
        amount: "5750",
      }),
    );
    expect(l).not.toBeNull();
    // 5750 / 50 = 115 matches the 115 in description!
    expect(l?.quantity).toBe("115.000");
    expect(l?.rate).toBe("50.0000");
    expect(l?.amount).toBe("5750.00");
    expect(l?.flags).not.toContain("math_line");
    expect([l?.packCount, l?.packUnit]).toEqual(["3.000", "box"]);
  });

  test("container count from package_count / package_unit, unit is what the rate applies to", () => {
    // Bill #17550: "E cucumber 4 BOX 150 x 45 = 6750".
    const l = normalizeLine(
      line({
        description: "E cucumber",
        quantity: "150",
        unit: "kg",
        rate: "45",
        amount: "6750",
        package_count: "4",
        package_unit: "BOX",
      }),
    );
    expect([l?.quantity, l?.unit, l?.amount, l?.packCount, l?.packUnit]).toEqual([
      "150.000",
      "kg",
      "6750.00",
      "4.000",
      "box",
    ]);
    // Baby corn: 90 packets at 90 in 2 boxes stays in pcs.
    const corn = normalizeLine(
      line({
        description: "Baby corn",
        quantity: "90",
        unit: "pcs",
        rate: "90",
        amount: "8100",
        package_count: "2",
        package_unit: "boxes",
      }),
    );
    expect([corn?.quantity, corn?.unit, corn?.packCount, corn?.packUnit]).toEqual([
      "90.000",
      "pcs",
      "2.000",
      "box",
    ]);
  });

  test("a container count left in the text is still picked up", () => {
    const l = normalizeLine(
      line({
        description: "E CUCUMBER 4 BOX",
        quantity: "150",
        unit: "kg",
        rate: "45",
        amount: "6750",
      }),
    );
    expect([l?.packCount, l?.packUnit]).toEqual(["4.000", "box"]);
    const none = normalizeLine(
      line({ description: "Guava", quantity: "1", rate: "150", amount: "150" }),
    );
    expect([none?.packCount, none?.packUnit]).toEqual([null, null]);
  });

  test("extracts structured charges and calculates otherCharges total", () => {
    const b = normalizeExtraction(
      bill({
        other_charges: [
          { label: "Station charge", amount: "250.00" },
          { label: "Packaging fees", amount: "240.00" },
        ],
        grand_total: "490.00",
      }),
      NOW,
    );
    expect(b.charges.length).toBe(2);
    expect(b.charges[0]?.label).toBe("Station charge");
    expect(b.charges[0]?.amount).toBe("250.00");
    expect(b.charges[1]?.label).toBe("Packaging fees");
    expect(b.charges[1]?.amount).toBe("240.00");
    expect(b.otherCharges).toBe("490.00");
    expect(b.flags).not.toContain("math_total");
  });
});

describe("deductions from an earlier bill", () => {
  test('"Less Broccoli 27 x 70 = 1890" is a credit line, not a discount, and the total reconciles', () => {
    const b = normalizeExtraction(
      bill({
        line_items: [
          { description: "Baby corn", quantity: "90", unit: "pcs", rate: "90", amount: "8100" },
        ],
        deductions: [
          { description: "Less Broccoli", quantity: "27", unit: "kg", rate: "70", amount: "-1890" },
        ],
        other_charges: [{ label: "Station charge", amount: "1300" }],
        discount_total: null,
        grand_total: "7510",
      }),
      NOW,
    );
    expect(b.discountTotal).toBe("0.00");
    expect(b.flags).not.toContain("math_total");
    expect(
      b.lines.map((l) => [l.description, l.quantity, l.unit, l.rate, l.amount, l.lineKind]),
    ).toEqual([
      ["Baby corn", "90.000", "pcs", "90.0000", "8100.00", "goods"],
      ["Broccoli", "27.000", "kg", "70.0000", "1890.00", "credit"],
    ]);
    expect(b.lines[1]?.flags).toEqual([]);
  });

  test("Hindi and other words for a deduction are dropped from the item name", () => {
    for (const word of ["Minus", "KAM", "ghata:", "वापसी", "Return -"]) {
      const l = normalizeDeduction({
        description: `${word} Tomato`,
        quantity: "5",
        unit: "kg",
        rate: "20",
        amount: "100",
      });
      expect([l?.description, l?.amount, l?.lineKind]).toEqual(["Tomato", "100.00", "credit"]);
    }
    // A name that only starts like one is kept.
    expect(
      normalizeDeduction({
        description: "Lessar beans",
        quantity: "1",
        unit: "kg",
        rate: "1",
        amount: "1",
      })?.description,
    ).toBe("Lessar beans");
  });

  test("older reads without deductions still parse", () => {
    expect(extractionOutput.parse({ is_bill: true }).deductions).toEqual([]);
  });
});

describe("dates", () => {
  const cases: Array<[string | null, string | null, string | null]> = [
    ["2026-10-21", "21/10/26", "2026-10-21"],
    ["2026-10-21", null, "2026-10-21"],
    [null, "21/10/26", "2026-10-21"],
    [null, "5-3-2026", "2026-03-05"],
    [null, "21.10.2026", "2026-10-21"],
    ["2026-13-45", "01/02/26", "2026-02-01"],
    ["garbage", "31/02/26", null],
    [null, null, null],
  ];
  test.each(cases)("iso %p raw %p -> %p", (iso, raw, expected) => {
    expect(parseBillDate(iso, raw)).toBe(expected);
  });

  test("date_suspect: future beyond 2 days or older than 18 months", () => {
    const flag = (d: string) => normalizeExtraction(bill({ date_iso: d }), NOW).flags;
    expect(flag("2026-11-01")).not.toContain("date_suspect");
    expect(flag("2026-11-02")).toContain("date_suspect");
    expect(flag("2025-05-01")).not.toContain("date_suspect");
    expect(flag("2025-04-29")).toContain("date_suspect");
  });

  test("a missing date is null and not suspect", () => {
    const b = normalizeExtraction(bill(), NOW);
    expect(b.billDate).toBeNull();
    expect(b.flags).not.toContain("date_suspect");
  });
});

describe("own business on the bill (CUSTOMER_SPECS_PLAN B6)", () => {
  const OWN_GSTIN = "27AAPFU0939F1ZV";
  const own = {
    name: "Samavaya Agro Pvt Ltd",
    gstin: OWN_GSTIN,
    aliases: ["Samavaya", "Samavaya Fresh"],
  };
  const zepto = { name: "Zepto Marketplace Pvt Ltd", gstin: "29AAGCB7383J1Z4" };
  const farm = { name: "Krishna Farms", gstin: "27AAACR5055K1Z7" };

  test("isOwnParty: GSTIN decides when both have one, else name or alias", () => {
    expect(isOwnParty({ name: "Anything", gstin: OWN_GSTIN.toLowerCase() }, own)).toBe(true);
    expect(isOwnParty({ name: "Samavaya", gstin: "29AAGCB7383J1Z4" }, own)).toBe(false);
    expect(isOwnParty({ name: "SAMAVAYA FRESH", gstin: null }, own)).toBe(true);
    expect(isOwnParty({ name: "Samavaya Agro Private Limited", gstin: null }, own)).toBe(true);
    expect(isOwnParty({ name: "Samavaya Traders", gstin: null }, own)).toBe(false);
    expect(isOwnParty({ name: "", gstin: null }, own)).toBe(false);
  });

  test("sale: the seller is us by alias, so the buyer is the counterparty", () => {
    const b = normalizeExtraction(
      bill({
        seller: { name: "SAMAVAYA", gstin: null },
        buyer: zepto,
        counterparty: { name: "Samavaya", gstin: null },
      }),
      NOW,
      { billType: "sale", own },
    );
    expect([b.vendorName, b.gstin]).toEqual([zepto.name, zepto.gstin]);
    expect(b.flags).not.toContain("seller_unknown");
    expect(b.extractedParties).toEqual({
      seller: { name: "SAMAVAYA", gstin: null },
      buyer: zepto,
    });
  });

  test("purchase: the buyer is us by GSTIN, so the seller is the counterparty", () => {
    const b = normalizeExtraction(
      bill({ seller: farm, buyer: { name: "S. Agro", gstin: OWN_GSTIN } }),
      NOW,
      { billType: "purchase", own },
    );
    expect([b.vendorName, b.gstin]).toEqual([farm.name, farm.gstin]);
    expect(b.flags).toEqual([]);
  });

  test("added as a purchase but we are the seller: the buyer, flagged looks_like_sale", () => {
    const b = normalizeExtraction(
      bill({ seller: { name: "Samavaya Fresh", gstin: OWN_GSTIN }, buyer: zepto }),
      NOW,
      { billType: "purchase", own },
    );
    expect(b.vendorName).toBe(zepto.name);
    expect(b.flags).toContain("looks_like_sale");
  });

  test("added as a sale but we are the buyer: the seller, flagged looks_like_purchase", () => {
    const b = normalizeExtraction(
      bill({ seller: farm, buyer: { name: "Samavaya", gstin: null } }),
      NOW,
      {
        billType: "sale",
        own,
      },
    );
    expect(b.vendorName).toBe(farm.name);
    expect(b.flags).toContain("looks_like_purchase");
  });

  test("neither side is us: chosen by type, and a sale is flagged seller_unknown", () => {
    const parties = { seller: farm, buyer: zepto };
    const sale = normalizeExtraction(bill(parties), NOW, { billType: "sale", own });
    expect(sale.vendorName).toBe(zepto.name);
    expect(sale.flags).toContain("seller_unknown");
    const purchase = normalizeExtraction(bill(parties), NOW, { billType: "purchase", own });
    expect(purchase.vendorName).toBe(farm.name);
    expect(purchase.flags).not.toContain("seller_unknown");
  });

  test("older reads without sides keep the counterparty, unless it is us", () => {
    const old = normalizeExtraction(
      bill({ counterparty: { name: "Krishna Farms", gstin: null } }),
      NOW,
      {
        billType: "purchase",
        own,
      },
    );
    expect(old.vendorName).toBe("Krishna Farms");
    expect(old.extractedParties).toEqual({ seller: null, buyer: null });
    const self = normalizeExtraction(
      bill({ counterparty: { name: "Samavaya", gstin: null } }),
      NOW,
      {
        billType: "sale",
        own,
      },
    );
    expect([self.vendorName, self.gstin]).toEqual(["", null]);
  });

  test("without context the counterparty is read as before", () => {
    const b = normalizeExtraction(
      bill({ seller: farm, buyer: zepto, counterparty: { name: " Krishna  Farms ", gstin: null } }),
      NOW,
    );
    expect(b.vendorName).toBe("Krishna Farms");
    expect(b.flags).toEqual([]);
  });
});
