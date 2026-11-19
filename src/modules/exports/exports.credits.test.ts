import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import {
  buildExportDataset,
  buildTallyBills,
  type ExportBillRow,
  type ExportLineRow,
} from "./exports.dataset";
import { generateItemizedCsv, generateSummaryCsv } from "./writers/csv.writer";
import { generateTallyXml, VENDOR_CREDIT_LEDGER } from "./writers/tally.writer";
import { generateXlsx } from "./writers/xlsx.writer";

// Bill #17550: 36,560 of goods + 13,400 of charges - 1,890 credit (Less Broccoli) = 48,070 payable.
const refId = "00000000-0000-4000-8000-0000000000aa";
const bill = (over: Partial<ExportBillRow> = {}): ExportBillRow =>
  ({
    id: "bill-17550",
    businessId: "biz",
    type: "purchase",
    status: "confirmed",
    vendorId: null,
    vendorNameRaw: "Sai Vegetables",
    counterpartyGstin: null,
    invoiceNumber: "17550",
    billDate: "2026-11-01",
    subtotal: "36560.00",
    discountTotal: "0.00",
    cgstTotal: "0.00",
    sgstTotal: "0.00",
    igstTotal: "0.00",
    cessTotal: "0.00",
    otherCharges: "13400.00",
    charges: [
      { id: "c1", label: "Freight", amount: "10000.00", category: "freight" },
      { id: "c2", label: "Hamali", amount: "3400.00", category: "loading" },
    ],
    roundOff: "0.00",
    taxesIncluded: false,
    grandTotal: "50000.00",
    confirmedTotal: "48070.00",
    ...over,
  }) as unknown as ExportBillRow;

const line = (over: Partial<ExportLineRow>): ExportLineRow =>
  ({
    billId: "bill-17550",
    descriptionRaw: "Item",
    hsnSac: null,
    quantity: "1.000",
    unit: "kg",
    rate: "1.0000",
    discount: "0.00",
    taxableValue: null,
    gstRate: null,
    cgst: "0.00",
    sgst: "0.00",
    igst: "0.00",
    amount: "0.00",
    lineKind: "goods",
    creditRefBillId: null,
    ...over,
  }) as unknown as ExportLineRow;

const lines = [
  line({
    descriptionRaw: "Tomato",
    quantity: "100.000",
    rate: "200.0000",
    amount: "20000.00",
    taxableValue: "20000.00",
  }),
  line({
    descriptionRaw: "Onion",
    quantity: "165.000",
    rate: "100.0000",
    amount: "16560.00",
    taxableValue: "16560.00",
  }),
  line({
    descriptionRaw: "Broccoli",
    quantity: "27.000",
    rate: "70.0000",
    amount: "1890.00",
    lineKind: "credit",
    creditRefBillId: refId,
  }),
];
const refInvoices = new Map([[refId, "17321"]]);
const dataset = () =>
  buildExportDataset({ bills: [bill()], lines, vendors: new Map(), refInvoices });

const rowOf = (ws: ExcelJS.Worksheet | undefined, n: number): unknown[] =>
  ((ws?.getRow(n).values ?? []) as unknown[]).slice(1);

describe("exports: credit lines (Less from earlier bills)", () => {
  test("summary row reconciles for bill #17550 and total is the payable", () => {
    const s = dataset().summary[0];
    if (!s) throw new Error("no summary row");
    expect(s.subtotal).toBe(36560);
    expect(s.otherCharges).toBe(13400);
    expect(s.credits).toBe(1890);
    expect(s.total).toBe(48070);
    const taxes = s.cgst + s.sgst + s.igst + s.cess;
    const sum =
      s.subtotal +
      (s.otherCharges ?? 0) +
      taxes -
      (s.discount ?? 0) -
      (s.credits ?? 0) +
      (s.roundOff ?? 0);
    expect(sum).toBeCloseTo(s.total, 2);
  });

  test("falls back to computing the payable when confirmed_total is missing", () => {
    const s = buildExportDataset({
      bills: [bill({ confirmedTotal: null })],
      lines,
      vendors: new Map(),
    }).summary[0];
    expect(s?.total).toBe(48070);
  });

  test("itemised credit row: Less prefix, kind, negative amount, ref invoice, no taxable value", () => {
    const rows = dataset().itemized;
    const c = rows[2];
    expect(c?.description).toBe("Less: Broccoli");
    expect(c?.lineKind).toBe("credit");
    expect(c?.quantity).toBe(27);
    expect(c?.rate).toBe(70);
    expect(c?.lineTotal).toBe(-1890);
    expect(c?.creditRefInvoice).toBe("17321");
    expect(c?.taxableValue).toBe(0);
    expect(rows[0]?.lineKind).toBe("goods");
  });

  test("vendor spend uses the payable and leaves credits out of quantity", () => {
    const v = dataset().vendorSpend[0];
    expect(v?.totalSpend).toBe(48070);
    expect(v?.totalQuantity).toBe(265);
  });

  test("CSV: same columns and rows as the sheets; credit excluded from quantity and taxable totals", () => {
    const ds = dataset();
    const summary = generateSummaryCsv(ds).split("\r\n");
    expect(summary[0]).toContain(
      "Cess,Other Charges,Discount,Credits (Less from earlier bills),Round Off,Total,Status",
    );
    expect(summary[1]).toContain(
      "36560.00,0.00,0.00,0.00,0.00,13400.00,0.00,1890.00,0.00,48070.00,confirmed",
    );
    expect(summary[2]).toContain(
      "Total,,,,,,36560.00,0.00,0.00,0.00,0.00,13400.00,0.00,1890.00,0.00,48070.00",
    );

    const items = generateItemizedCsv(ds).split("\r\n");
    expect(items[0]).toContain("Line Total,Line Kind,Credit Ref Invoice");
    expect(items[3]).toContain(
      "Less: Broccoli,,27.000,kg,70.00,0.00,0.00,,0.00,0.00,0.00,-1890.00,Credit from earlier bill,17321",
    );
    expect(items[4]).toContain("Total,,,,,265.000,,,0.00,36560.00,,0.00,0.00,0.00,34670.00");
  });

  test("XLSX: summary and itemised sheets carry the credit columns and rows", async () => {
    const buf = await generateXlsx(dataset());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const sum = wb.getWorksheet("Summary");
    const hdr = rowOf(sum, 1);
    const col = (h: string) => hdr.indexOf(h);
    expect(hdr).toContain("Credits (Less from earlier bills)");
    const r = rowOf(sum, 2);
    expect(r[col("Credits (Less from earlier bills)")]).toBe(1890);
    expect(r[col("Other Charges")]).toBe(13400);
    expect(r[col("Total")]).toBe(48070);
    expect(sum?.getRow(3).getCell(col("Total") + 1).value).toBe(48070);

    const it = wb.getWorksheet("Itemized");
    const ih = rowOf(it, 1);
    const cr = rowOf(it, 4);
    expect(cr[ih.indexOf("Item Description")]).toBe("Less: Broccoli");
    expect(cr[ih.indexOf("Line Total")]).toBe(-1890);
    expect(cr[ih.indexOf("Line Kind")]).toBe("Credit from earlier bill");
    expect(cr[ih.indexOf("Credit Ref Invoice")]).toBe("17321");
    const tot = rowOf(it, 5);
    expect(tot[ih.indexOf("Quantity")]).toBe(265);
    expect(tot[ih.indexOf("Line Total")]).toBe(34670);
  });

  describe("Tally XML", () => {
    const xml = generateTallyXml({
      companyName: "Co",
      bills: buildTallyBills({ bills: [bill()], lines, vendors: new Map(), refInvoices }),
    });

    test("credit is a ledger entry, not an inventory entry", () => {
      expect(xml).not.toContain("<STOCKITEMNAME>Broccoli");
      expect(xml.match(/<ALLINVENTORYENTRIES.LIST>/g)?.length).toBe(2);
      expect(xml).toContain(`<LEDGERNAME>${VENDOR_CREDIT_LEDGER}</LEDGERNAME>`);
      expect(xml).toContain("<NARRATION>Less from earlier bill 17321</NARRATION>");
    });

    test("voucher balances: signed amounts sum to zero and party = payable", () => {
      let net = 0;
      const inv = xml.matchAll(/<ALLINVENTORYENTRIES.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES.LIST>/g);
      // The first AMOUNT is the line's; the batch allocation repeats it.
      for (const m of inv) net += Number(/<AMOUNT>([-\d.]+)<\/AMOUNT>/.exec(m[0])?.[1]);
      const amounts: Record<string, number> = {};
      for (const m of xml.matchAll(/<LEDGERENTRIES.LIST>[\s\S]*?<\/LEDGERENTRIES.LIST>/g)) {
        const name = /<LEDGERNAME>(.*?)<\/LEDGERNAME>/.exec(m[0])?.[1] ?? "";
        const amt = Number(/<AMOUNT>([-\d.]+)<\/AMOUNT>/.exec(m[0])?.[1]);
        const pos = /<ISDEEMEDPOSITIVE>(\w+)</.exec(m[0])?.[1];
        // Tally convention: deemed-positive entries are debits and carry negative amounts.
        expect(pos === "Yes").toBe(amt < 0);
        amounts[name] = amt;
        net += amt;
      }
      expect(amounts["Sai Vegetables"]).toBe(48070);
      expect(amounts[VENDOR_CREDIT_LEDGER]).toBe(1890);
      expect(net).toBeCloseTo(0, 2);
    });

    test("a bill with a discount and no credits still balances and has no credit ledger", () => {
      const b = bill({ confirmedTotal: "49660.00", discountTotal: "300.00" });
      const l = lines.filter((x) => x.lineKind !== "credit");
      const x = generateTallyXml({
        bills: buildTallyBills({ bills: [b], lines: l, vendors: new Map() }),
      });
      expect(x).not.toContain(VENDOR_CREDIT_LEDGER);
      expect(x).toContain("<LEDGERNAME>Discount Received</LEDGERNAME>");
    });
  });
});
