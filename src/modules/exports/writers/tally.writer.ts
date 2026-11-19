export type TallyBillLine = {
  description: string;
  quantity: number;
  unit?: string | null | undefined;
  rate: number;
  amount: number;
  /** "credit": a deduction for an earlier bill. It is posted as a ledger entry, never as stock. */
  lineKind?: "goods" | "credit" | undefined;
  stockItemName?: string | undefined;
  godownName?: string | undefined;
  batchName?: string | undefined;
};

export type TallyCharge = {
  label: string;
  amount: number;
  category?: string | null | undefined;
};

export type TallyBill = {
  id?: string | undefined;
  type: "purchase" | "sale" | string;
  billDate?: string | Date | null | undefined;
  invoiceNumber?: string | null | undefined;
  vendorName?: string | null | undefined;
  partyLedgerName?: string | null | undefined;
  cgst?: number | null | undefined;
  sgst?: number | null | undefined;
  igst?: number | null | undefined;
  otherCharges?: number | null | undefined;
  charges?: TallyCharge[] | undefined;
  /** Bill-level discount. */
  discount?: number | null | undefined;
  /** Sum of credits from earlier bills, when no credit lines are given. */
  credits?: number | null | undefined;
  /** Invoice numbers of the earlier bills the credits refer to (for the narration). */
  creditRefs?: string[] | undefined;
  roundOff?: number | null | undefined;
  subtotal?: number | null | undefined;
  total?: number | null | undefined;
  lines?: TallyBillLine[] | undefined;
};

export type ExportData = {
  companyName?: string | undefined;
  bills: TallyBill[];
};

/**
 * Escapes characters for safe inclusion in XML elements and attributes.
 * Handles &, <, >, ", and '.
 */
export function escapeXml(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Formats a date string (YYYY-MM-DD or ISO) or Date object into Tally's YYYYMMDD format.
 */
export function formatTallyDate(dateVal: string | Date | null | undefined): string {
  if (!dateVal) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }
  if (typeof dateVal === "string") {
    const digits = dateVal.replace(/\D/g, "");
    if (digits.length >= 8) {
      return digits.slice(0, 8);
    }
  }
  const dt = new Date(dateVal);
  if (!Number.isNaN(dt.getTime())) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }
  return "20260101";
}

/** Ledger the credit from an earlier bill is posted to. */
export const VENDOR_CREDIT_LEDGER = "Vendor credit (earlier bill)";

export function resolveChargeLedgerName(
  charge: { label: string; category?: string | null | undefined },
  isPurchase: boolean,
): string {
  const cat = (charge.category || "").toLowerCase();
  const lbl = (charge.label || "").toLowerCase();

  if (cat === "freight" || /freight|bhada|transport|cartage|lorry|bheja/i.test(lbl)) {
    return isPurchase ? "Freight & Carriage Inward" : "Freight Outward";
  }
  if (cat === "packaging" || /pack|bardana|peti|box|bag|packing/i.test(lbl)) {
    return "Packing & Forwarding Charges";
  }
  if (cat === "loading" || /hamali|kooli|coolie|loading|unloading|majduri/i.test(lbl)) {
    return "Loading & Unloading Charges";
  }
  if (cat === "mandi_cess" || /cess|mandi|market\s*fee/i.test(lbl)) {
    return "Mandi Cess & Market Fees";
  }
  if (/station/i.test(lbl)) {
    return "Station Charges";
  }
  if (charge.label?.trim()) {
    return charge.label.trim();
  }
  return "Other Charges";
}

/**
 * Generates standard Tally Prime import XML string from the export data.
 */
export function generateTallyXml(exportData: ExportData): string {
  const companyName = escapeXml(exportData.companyName || "Company");
  const vouchersXml: string[] = [];

  for (const bill of exportData.bills) {
    const isPurchase = (bill.type || "").toLowerCase().includes("purchase");
    const vchType = isPurchase ? "Purchase" : "Sales";
    const dateFormatted = formatTallyDate(bill.billDate);
    const voucherNumber = escapeXml(bill.invoiceNumber || bill.id || "1");
    const partyName = escapeXml(
      bill.partyLedgerName ||
        bill.vendorName ||
        (isPurchase ? "Sundry Creditors" : "Sundry Debtors"),
    );

    const billLines = bill.lines ?? [];
    let linesTotal = 0;
    const inventoryXml: string[] = [];

    // Credit lines ("Less from earlier bills") are not stock: they are one ledger entry below.
    const creditLinesTotal = billLines
      .filter((l) => l.lineKind === "credit")
      .reduce((s, l) => s + Math.abs(Number(l.amount) || 0), 0);

    for (const line of billLines) {
      if (line.lineKind === "credit") continue;
      const qty = Number(line.quantity) || 0;
      const unit = line.unit ? line.unit.trim() : "pcs";
      const unitEsc = escapeXml(unit);
      const qtyFormatted = `${qty.toFixed(3)} ${unitEsc}`;
      const rate = Number(line.rate) || 0;
      const rateFormatted = `${rate.toFixed(2)}/${unitEsc}`;

      const rawAmount = Number(line.amount) || 0;
      linesTotal += rawAmount;

      // In Tally Prime:
      // Purchases have debits (negative inventory entry amount)
      // Sales have credits (positive inventory entry amount)
      const amtVal = isPurchase ? -Math.abs(rawAmount) : Math.abs(rawAmount);
      const amtFormatted = amtVal.toFixed(2);

      const stockItem = escapeXml(line.stockItemName || line.description || "Item");
      const godown = escapeXml(line.godownName || "Main Location");
      const batch = escapeXml(line.batchName || "Primary Batch");

      inventoryXml.push(`            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${stockItem}</STOCKITEMNAME>
              <ACTUALQTY>${qtyFormatted}</ACTUALQTY>
              <BILLEDQTY>${qtyFormatted}</BILLEDQTY>
              <RATE>${rateFormatted}</RATE>
              <AMOUNT>${amtFormatted}</AMOUNT>
              <BATCHALLOCATIONS.LIST>
                <GODOWNNAME>${godown}</GODOWNNAME>
                <BATCHNAME>${batch}</BATCHNAME>
                <AMOUNT>${amtFormatted}</AMOUNT>
                <ACTUALQTY>${qtyFormatted}</ACTUALQTY>
                <BILLEDQTY>${qtyFormatted}</BILLEDQTY>
              </BATCHALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>`);
    }

    const cgst = Number(bill.cgst) || 0;
    const sgst = Number(bill.sgst) || 0;
    const igst = Number(bill.igst) || 0;
    const roundOff = Number(bill.roundOff) || 0;
    const subtotal = Number(bill.subtotal) || linesTotal;
    const chargesTotal =
      bill.charges && bill.charges.length > 0
        ? bill.charges.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
        : Number(bill.otherCharges) || 0;
    const discount = Math.abs(Number(bill.discount) || 0);
    const credits = billLines.some((l) => l.lineKind === "credit")
      ? creditLinesTotal
      : Math.abs(Number(bill.credits) || 0);
    const total =
      Number(bill.total) ||
      subtotal + cgst + sgst + igst + chargesTotal - discount - credits + roundOff;

    const ledgerXml: string[] = [];

    // Party ledger entry:
    // For Purchase: Creditor is credited (positive amount)
    // For Sales: Debtor is debited (negative amount)
    const partyAmt = isPurchase ? Math.abs(total) : -Math.abs(total);
    ledgerXml.push(`            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${partyName}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isPurchase ? "No" : "Yes"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${partyAmt.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>`);

    // If there were no inventory lines, add an accounting ledger entry for purchase/sale
    if (billLines.length === 0) {
      const acctAmt = isPurchase ? -Math.abs(subtotal) : Math.abs(subtotal);
      ledgerXml.push(`            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${isPurchase ? "Purchase" : "Sales"}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isPurchase ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${acctAmt.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>`);
    }

    // Ledger tax entries:
    // For Purchase: Input taxes are debits (negative)
    // For Sales: Output taxes are credits (positive)
    if (Math.abs(cgst) > 0.0001) {
      const cgstAmt = isPurchase ? -Math.abs(cgst) : Math.abs(cgst);
      ledgerXml.push(`            <LEDGERENTRIES.LIST>
              <LEDGERNAME>CGST</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isPurchase ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${cgstAmt.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>`);
    }

    if (Math.abs(sgst) > 0.0001) {
      const sgstAmt = isPurchase ? -Math.abs(sgst) : Math.abs(sgst);
      ledgerXml.push(`            <LEDGERENTRIES.LIST>
              <LEDGERNAME>SGST</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isPurchase ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${sgstAmt.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>`);
    }

    if (Math.abs(igst) > 0.0001) {
      const igstAmt = isPurchase ? -Math.abs(igst) : Math.abs(igst);
      ledgerXml.push(`            <LEDGERENTRIES.LIST>
              <LEDGERNAME>IGST</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isPurchase ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${igstAmt.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>`);
    }

    // Surcharges & Fee ledger entries
    const billCharges =
      bill.charges && bill.charges.length > 0
        ? bill.charges
        : bill.otherCharges && Math.abs(bill.otherCharges) > 0.0001
          ? [{ label: "Other Charges", amount: bill.otherCharges }]
          : [];

    for (const chg of billCharges) {
      const amt = Number(chg.amount) || 0;
      if (Math.abs(amt) <= 0.0001) continue;
      const ledgerName = escapeXml(resolveChargeLedgerName(chg, isPurchase));
      const chgAmt = isPurchase ? -Math.abs(amt) : Math.abs(amt);
      ledgerXml.push(`            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${ledgerName}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isPurchase ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${chgAmt.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>`);
    }

    // Discount: reduces what is payable, so it sits on the party's side (purchase: credit, sale: debit).
    if (discount > 0.0001) {
      const discAmt = isPurchase ? discount : -discount;
      ledgerXml.push(`            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${isPurchase ? "Discount Received" : "Discount Allowed"}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isPurchase ? "No" : "Yes"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${discAmt.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>`);
    }

    // Credit from an earlier bill: sits on the party's side like the discount, so it reduces what is owed.
    // Purchase: +credit with ISDEEMEDPOSITIVE No, so party (+total) + credit balances goods + tax + charges.
    if (credits > 0.0001) {
      const credAmt = isPurchase ? credits : -credits;
      ledgerXml.push(`            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${VENDOR_CREDIT_LEDGER}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isPurchase ? "No" : "Yes"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${credAmt.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>`);
    }

    // Round off ledger entry if roundOff != 0
    if (Math.abs(roundOff) > 0.0001) {
      // In Purchase: positive roundOff increases bill total, so debit is negative.
      const roAmt = isPurchase ? -roundOff : roundOff;
      const roDeemedPos = roAmt < 0 ? "Yes" : "No";
      ledgerXml.push(`            <LEDGERENTRIES.LIST>
              <LEDGERNAME>Round Off</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${roDeemedPos}</ISDEEMEDPOSITIVE>
              <AMOUNT>${roAmt.toFixed(2)}</AMOUNT>
            </LEDGERENTRIES.LIST>`);
    }

    const refs = (bill.creditRefs ?? []).filter(Boolean);
    const narration =
      credits > 0.0001
        ? `
            <NARRATION>${escapeXml(
              refs.length > 0
                ? `Less from earlier bill ${refs.join(", ")}`
                : "Less from earlier bill",
            )}</NARRATION>`
        : "";

    const inventoryBlock = inventoryXml.length > 0 ? `\n${inventoryXml.join("\n")}` : "";
    const ledgerBlock = ledgerXml.length > 0 ? `\n${ledgerXml.join("\n")}` : "";

    vouchersXml.push(`        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${vchType}" ACTION="Create">
            <DATE>${dateFormatted}</DATE>
            <VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${voucherNumber}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${partyName}</PARTYLEDGERNAME>
            <PROFORMAVOUCHER>false</PROFORMAVOUCHER>${narration}${inventoryBlock}${ledgerBlock}
          </VOUCHER>
        </TALLYMESSAGE>`);
  }

  const vouchersBody = vouchersXml.length > 0 ? `\n${vouchersXml.join("\n")}\n      ` : "";

  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${vouchersBody}</REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
}
