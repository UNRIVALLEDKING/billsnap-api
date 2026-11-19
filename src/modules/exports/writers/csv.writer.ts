import { PassThrough } from "node:stream";
import { ZipArchive } from "archiver";
import type { ExportDataset } from "../exports.schema";
import { sanitizeFormula } from "./sanitizer";

export const UTF8_BOM = "\uFEFF";

export const CREDIT_KIND_LABEL = "Credit from earlier bill";

const PLAIN_NUMBER = /^-?[0-9]+([.][0-9]+)?$/;

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  // A plain negative number (a credit's amount) is data, not a formula: keep its minus sign.
  const str =
    typeof value === "string" && !PLAIN_NUMBER.test(value) ? sanitizeFormula(value) : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

function formatMoney(num: number | string | null | undefined): string {
  const n = Number(num) || 0;
  return n.toFixed(2);
}

function formatQty(num: number | string | null | undefined): string {
  const n = Number(num) || 0;
  return n.toFixed(3);
}

export function generateSummaryCsv(dataset: ExportDataset): string {
  const lines: string[] = [];

  const headers = [
    "Bill ID",
    "Date",
    "Type",
    "Invoice #",
    "Vendor Name",
    "GSTIN",
    "Subtotal",
    "CGST",
    "SGST",
    "IGST",
    "Cess",
    "Other Charges",
    "Discount",
    "Credits (Less from earlier bills)",
    "Round Off",
    "Total",
    "Status",
  ];
  lines.push(headers.map(escapeCsvField).join(","));

  let sumSubtotal = 0;
  let sumCgst = 0;
  let sumSgst = 0;
  let sumIgst = 0;
  let sumCess = 0;
  let sumCharges = 0;
  let sumDiscount = 0;
  let sumCredits = 0;
  let sumRoundOff = 0;
  let sumTotal = 0;

  for (const row of dataset.summary) {
    sumSubtotal += Number(row.subtotal) || 0;
    sumCgst += Number(row.cgst) || 0;
    sumSgst += Number(row.sgst) || 0;
    sumIgst += Number(row.igst) || 0;
    sumCess += Number(row.cess) || 0;
    sumCharges += Number(row.otherCharges) || 0;
    sumDiscount += Number(row.discount) || 0;
    sumCredits += Number(row.credits) || 0;
    sumRoundOff += Number(row.roundOff) || 0;
    sumTotal += Number(row.total) || 0;

    const cells = [
      row.id,
      row.billDate ?? "",
      row.type,
      row.invoiceNumber ?? "",
      row.vendorName ?? "",
      row.gstin ?? "",
      formatMoney(row.subtotal),
      formatMoney(row.cgst),
      formatMoney(row.sgst),
      formatMoney(row.igst),
      formatMoney(row.cess),
      formatMoney(row.otherCharges),
      formatMoney(row.discount),
      formatMoney(row.credits),
      formatMoney(row.roundOff),
      formatMoney(row.total),
      row.status,
    ];
    lines.push(cells.map(escapeCsvField).join(","));
  }

  // Totals row
  const totals = [
    "Total",
    "",
    "",
    "",
    "",
    "",
    formatMoney(sumSubtotal),
    formatMoney(sumCgst),
    formatMoney(sumSgst),
    formatMoney(sumIgst),
    formatMoney(sumCess),
    formatMoney(sumCharges),
    formatMoney(sumDiscount),
    formatMoney(sumCredits),
    formatMoney(sumRoundOff),
    formatMoney(sumTotal),
    "",
  ];
  lines.push(totals.map(escapeCsvField).join(","));

  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

export function generateItemizedCsv(dataset: ExportDataset): string {
  const lines: string[] = [];

  const headers = [
    "Bill Date",
    "Invoice #",
    "Vendor",
    "Item Description",
    "HSN/SAC",
    "Quantity",
    "Unit",
    "Rate",
    "Discount",
    "Taxable Value",
    "GST %",
    "CGST",
    "SGST",
    "IGST",
    "Line Total",
    "Line Kind",
    "Credit Ref Invoice",
  ];
  lines.push(headers.map(escapeCsvField).join(","));

  let sumQty = 0;
  let sumDiscount = 0;
  let sumTaxable = 0;
  let sumCgst = 0;
  let sumSgst = 0;
  let sumIgst = 0;
  let sumLineTotal = 0;

  for (const item of dataset.itemized) {
    // A credit is a deduction, not goods bought: it stays out of quantity, discount and GST totals.
    if (item.lineKind !== "credit") {
      sumQty += Number(item.quantity) || 0;
      sumDiscount += Number(item.discount) || 0;
      sumTaxable += Number(item.taxableValue) || 0;
      sumCgst += Number(item.cgst) || 0;
      sumSgst += Number(item.sgst) || 0;
      sumIgst += Number(item.igst) || 0;
    }
    sumLineTotal += Number(item.lineTotal) || 0;

    const cells = [
      item.billDate ?? "",
      item.invoiceNumber ?? "",
      item.vendorName ?? "",
      item.description,
      item.hsnSac ?? "",
      formatQty(item.quantity),
      item.unit,
      formatMoney(item.rate),
      formatMoney(item.discount),
      formatMoney(item.taxableValue),
      item.gstRate != null ? Number(item.gstRate).toFixed(2) : "",
      formatMoney(item.cgst),
      formatMoney(item.sgst),
      formatMoney(item.igst),
      formatMoney(item.lineTotal),
      item.lineKind === "credit" ? CREDIT_KIND_LABEL : "Item",
      item.creditRefInvoice ?? "",
    ];
    lines.push(cells.map(escapeCsvField).join(","));
  }

  // Totals row
  const totals = [
    "Total",
    "",
    "",
    "",
    "",
    formatQty(sumQty),
    "",
    "",
    formatMoney(sumDiscount),
    formatMoney(sumTaxable),
    "",
    formatMoney(sumCgst),
    formatMoney(sumSgst),
    formatMoney(sumIgst),
    formatMoney(sumLineTotal),
    "",
    "",
  ];
  lines.push(totals.map(escapeCsvField).join(","));

  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

export function generateVendorSpendCsv(dataset: ExportDataset): string {
  const lines: string[] = [];

  const headers = ["Vendor Name", "GSTIN", "Total Bills", "Total Spend", "Total Weight/Quantity"];
  lines.push(headers.map(escapeCsvField).join(","));

  let sumBills = 0;
  let sumSpend = 0;
  let sumQty = 0;

  for (const v of dataset.vendorSpend) {
    sumBills += Number(v.totalBills) || 0;
    sumSpend += Number(v.totalSpend) || 0;
    sumQty += Number(v.totalQuantity) || 0;

    const cells = [
      v.vendorName,
      v.gstin ?? "",
      String(v.totalBills),
      formatMoney(v.totalSpend),
      formatQty(v.totalQuantity),
    ];
    lines.push(cells.map(escapeCsvField).join(","));
  }

  // Totals row
  const totals = ["Total", "", String(sumBills), formatMoney(sumSpend), formatQty(sumQty)];
  lines.push(totals.map(escapeCsvField).join(","));

  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

/**
 * Bundles Summary.csv, Itemized.csv, and Vendor_Spend.csv into a zip archive with archiver.
 * All files include the UTF-8 BOM so regional characters render cleanly in Excel.
 */
export async function generateCsvZip(dataset: ExportDataset): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];

  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<Buffer>((resolve, reject) => {
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    archive.on("error", reject);
  });

  archive.pipe(stream);

  archive.append(generateSummaryCsv(dataset), { name: "Summary.csv" });
  archive.append(generateItemizedCsv(dataset), { name: "Itemized.csv" });
  archive.append(generateVendorSpendCsv(dataset), { name: "Vendor_Spend.csv" });

  await archive.finalize();
  return done;
}

/**
 * Single CSV generator default (Summary sheet).
 */
export function generateCsv(dataset: ExportDataset): string {
  return generateSummaryCsv(dataset);
}
