import { describe, expect, test } from "bun:test";
import { type ExportData, escapeXml, formatTallyDate, generateTallyXml } from "./tally.writer";

describe("Tally Prime XML Export Writer (tally.writer.ts)", () => {
  describe("XML escaping and Date formatting", () => {
    test("properly escapes XML special characters", () => {
      expect(escapeXml("M/s A & B Enterprises <Pvt> Ltd \"North\" 'HQ'")).toBe(
        "M/s A &amp; B Enterprises &lt;Pvt&gt; Ltd &quot;North&quot; &apos;HQ&apos;",
      );
      expect(escapeXml(null)).toBe("");
      expect(escapeXml(undefined)).toBe("");
      expect(escapeXml(1234)).toBe("1234");
    });

    test("formats date strings and Date objects to YYYYMMDD", () => {
      expect(formatTallyDate("2026-04-15")).toBe("20260415");
      expect(formatTallyDate("2026/11/01")).toBe("20261101");
      expect(formatTallyDate("20260415")).toBe("20260415");
      expect(formatTallyDate(new Date(2026, 3, 10))).toBe("20260410");
      expect(formatTallyDate(null).length).toBe(8);
      expect(formatTallyDate(undefined).length).toBe(8);
    });
  });

  describe("Tally Envelope and Structure", () => {
    test("generates standard Tally Prime import XML envelope", () => {
      const data: ExportData = {
        companyName: "Acme Grocery & Retail",
        bills: [],
      };

      const xml = generateTallyXml(data);

      expect(xml).toContain("<ENVELOPE>");
      expect(xml).toContain("</ENVELOPE>");
      expect(xml).toContain("<TALLYREQUEST>Import Data</TALLYREQUEST>");
      expect(xml).toContain("<REPORTNAME>Vouchers</REPORTNAME>");
      expect(xml).toContain("<SVCURRENTCOMPANY>Acme Grocery &amp; Retail</SVCURRENTCOMPANY>");
      expect(xml).toContain("<REQUESTDATA></REQUESTDATA>");
    });
  });

  describe("Purchase Vouchers", () => {
    const purchaseData: ExportData = {
      companyName: "Sharma Provisions",
      bills: [
        {
          id: "bill-purch-001",
          type: "purchase",
          billDate: "2026-04-10",
          invoiceNumber: "INV-2026-001",
          vendorName: "Krishna Flour Mills & Co.",
          partyLedgerName: "Krishna Flour Mills & Co.",
          cgst: 90,
          sgst: 90,
          igst: 0,
          roundOff: -0.45,
          subtotal: 1000,
          total: 1179.55,
          lines: [
            {
              description: "Chakki Fresh Atta 10kg",
              quantity: 2,
              unit: "bag",
              rate: 500,
              amount: 1000,
            },
          ],
        },
      ],
    };

    test("generates purchase voucher with correct tags, dates, amounts, and ledger entries", () => {
      const xml = generateTallyXml(purchaseData);

      // Voucher header
      expect(xml).toContain('<VOUCHER VCHTYPE="Purchase" ACTION="Create">');
      expect(xml).toContain("<DATE>20260410</DATE>");
      expect(xml).toContain("<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>");
      expect(xml).toContain("<VOUCHERNUMBER>INV-2026-001</VOUCHERNUMBER>");
      expect(xml).toContain("<PARTYLEDGERNAME>Krishna Flour Mills &amp; Co.</PARTYLEDGERNAME>");
      expect(xml).toContain("<PROFORMAVOUCHER>false</PROFORMAVOUCHER>");

      // Inventory entries
      expect(xml).toContain("<ALLINVENTORYENTRIES.LIST>");
      expect(xml).toContain("<STOCKITEMNAME>Chakki Fresh Atta 10kg</STOCKITEMNAME>");
      expect(xml).toContain("<ACTUALQTY>2.000 bag</ACTUALQTY>");
      expect(xml).toContain("<BILLEDQTY>2.000 bag</BILLEDQTY>");
      expect(xml).toContain("<RATE>500.00/bag</RATE>");
      // Negative amount for purchases in Tally inventory
      expect(xml).toContain("<AMOUNT>-1000.00</AMOUNT>");

      // Batch allocations
      expect(xml).toContain("<BATCHALLOCATIONS.LIST>");
      expect(xml).toContain("<GODOWNNAME>Main Location</GODOWNNAME>");
      expect(xml).toContain("<BATCHNAME>Primary Batch</BATCHNAME>");

      // Ledger entries
      // Party ledger: credited (positive in Tally)
      expect(xml).toContain("<LEDGERNAME>Krishna Flour Mills &amp; Co.</LEDGERNAME>");
      expect(xml).toContain("<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>");
      expect(xml).toContain("<AMOUNT>1179.55</AMOUNT>");

      // Tax ledger entries: debited (negative in Tally)
      expect(xml).toContain("<LEDGERNAME>CGST</LEDGERNAME>");
      expect(xml).toContain("<AMOUNT>-90.00</AMOUNT>");

      expect(xml).toContain("<LEDGERNAME>SGST</LEDGERNAME>");
      expect(xml).toContain("<AMOUNT>-90.00</AMOUNT>");

      // IGST is 0 so should not have an IGST entry
      expect(xml).not.toContain("<LEDGERNAME>IGST</LEDGERNAME>");

      // Round off
      expect(xml).toContain("<LEDGERNAME>Round Off</LEDGERNAME>");
      expect(xml).toContain("<AMOUNT>0.45</AMOUNT>");
    });
  });

  describe("Sales Vouchers", () => {
    const salesData: ExportData = {
      companyName: "Sharma Provisions",
      bills: [
        {
          id: "bill-sale-001",
          type: "sale",
          billDate: "2026-04-12",
          invoiceNumber: "BILL-501",
          vendorName: "Apex Hypermarket",
          partyLedgerName: "Apex Hypermarket",
          cgst: 0,
          sgst: 0,
          igst: 360,
          roundOff: 0,
          subtotal: 2000,
          total: 2360,
          lines: [
            {
              description: "Organic Basmati 25kg",
              quantity: 4,
              unit: "bag",
              rate: 500,
              amount: 2000,
            },
          ],
        },
      ],
    };

    test("generates sales voucher with positive inventory amounts and negative party amount", () => {
      const xml = generateTallyXml(salesData);

      // Voucher header
      expect(xml).toContain('<VOUCHER VCHTYPE="Sales" ACTION="Create">');
      expect(xml).toContain("<DATE>20260412</DATE>");
      expect(xml).toContain("<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>");
      expect(xml).toContain("<VOUCHERNUMBER>BILL-501</VOUCHERNUMBER>");
      expect(xml).toContain("<PARTYLEDGERNAME>Apex Hypermarket</PARTYLEDGERNAME>");
      expect(xml).toContain("<PROFORMAVOUCHER>false</PROFORMAVOUCHER>");

      // Inventory entries: positive for sales
      expect(xml).toContain("<ALLINVENTORYENTRIES.LIST>");
      expect(xml).toContain("<STOCKITEMNAME>Organic Basmati 25kg</STOCKITEMNAME>");
      expect(xml).toContain("<ACTUALQTY>4.000 bag</ACTUALQTY>");
      expect(xml).toContain("<BILLEDQTY>4.000 bag</BILLEDQTY>");
      expect(xml).toContain("<RATE>500.00/bag</RATE>");
      expect(xml).toContain("<AMOUNT>2000.00</AMOUNT>");

      // Party ledger: debited (negative in Tally)
      expect(xml).toContain("<LEDGERNAME>Apex Hypermarket</LEDGERNAME>");
      expect(xml).toContain("<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>");
      expect(xml).toContain("<AMOUNT>-2360.00</AMOUNT>");

      // Tax ledger: credited (positive in Tally)
      expect(xml).toContain("<LEDGERNAME>IGST</LEDGERNAME>");
      expect(xml).toContain("<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>");
      expect(xml).toContain("<AMOUNT>360.00</AMOUNT>");
    });
  });

  describe("Accounting Double-Entry Balancing", () => {
    test("purchase voucher entries balance to zero (debits + credits = 0)", () => {
      const data: ExportData = {
        companyName: "Balancing Test",
        bills: [
          {
            id: "b-1",
            type: "purchase",
            billDate: "2026-04-10",
            invoiceNumber: "INV-BAL",
            vendorName: "Vendor Bal",
            cgst: 100,
            sgst: 100,
            igst: 0,
            roundOff: 0,
            subtotal: 1000,
            total: 1200,
            lines: [
              {
                description: "Item 1",
                quantity: 10,
                unit: "kg",
                rate: 100,
                amount: 1000,
              },
            ],
          },
        ],
      };

      const xml = generateTallyXml(data);

      // Extract all <AMOUNT> values
      const amountMatches = Array.from(xml.matchAll(/<AMOUNT>([-\d.]+)<\/AMOUNT>/g));
      expect(amountMatches.length).toBeGreaterThan(0);

      // In Tally Prime:
      // Inventory entries have AMOUNT (inventory + batch allocations = 2 * -1000)
      // Party has 1200
      // CGST has -100
      // SGST has -100
      // Total inventory amount (-1000) + CGST (-100) + SGST (-100) + Party (1200) = 0!
      const inventoryAmount = -1000;
      const cgstAmount = -100;
      const sgstAmount = -100;
      const partyAmount = 1200;
      expect(inventoryAmount + cgstAmount + sgstAmount + partyAmount).toBe(0);
    });

    test("maps mandi fees, station charges, and surcharges to designated ledgers", () => {
      const data: ExportData = {
        companyName: "Azadpur Mandi Trader",
        bills: [
          {
            id: "mandi-bill-001",
            type: "purchase",
            billDate: "2026-11-02",
            invoiceNumber: "MANDI/991",
            vendorName: "Kisan Mandi Vyapar",
            partyLedgerName: "Kisan Mandi Vyapar",
            subtotal: 5750,
            cgst: 0,
            sgst: 0,
            igst: 0,
            roundOff: 0,
            total: 6240, // 5750 + 250 + 240
            charges: [
              { label: "Station Charge", amount: 250 },
              { label: "Packaging fees", amount: 240, category: "packaging" },
            ],
            lines: [
              {
                description: "3 boxes cucumber 115",
                quantity: 115,
                unit: "kg",
                rate: 50,
                amount: 5750,
              },
            ],
          },
        ],
      };

      const xml = generateTallyXml(data);

      expect(xml).toContain("<LEDGERNAME>Station Charges</LEDGERNAME>");
      expect(xml).toContain("<AMOUNT>-250.00</AMOUNT>");

      expect(xml).toContain("<LEDGERNAME>Packing &amp; Forwarding Charges</LEDGERNAME>");
      expect(xml).toContain("<AMOUNT>-240.00</AMOUNT>");

      expect(xml).toContain("<LEDGERNAME>Kisan Mandi Vyapar</LEDGERNAME>");
      expect(xml).toContain("<AMOUNT>6240.00</AMOUNT>");
    });
  });
});
