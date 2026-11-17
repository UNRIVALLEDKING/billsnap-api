import { PassThrough, type Writable } from "node:stream";
import ExcelJS from "exceljs";
import type { ExportDataset } from "../exports.schema";
import { sanitizeFormula } from "./sanitizer";

export const CURRENCY_FORMAT = "₹#,##0.00";
export const QUANTITY_FORMAT = "#,##0.000";
export const NUMBER_FORMAT = "#,##0.00";

/**
 * Streams the 3-sheet Excel workbook (Summary, Itemized, Vendor Spend) to a writable stream.
 * Employs ExcelJS streaming WorkbookWriter to cap memory at <= 256 MB.
 * Applies formula sanitization (SEC-10), frozen header rows, bold headers, and currency formatting.
 */
export async function streamXlsxWorkbook(
  dataset: ExportDataset,
  destination: Writable,
): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: destination,
    useStyles: true,
  });

  // --- Sheet 1: Summary ---
  const summarySheet = workbook.addWorksheet("Summary", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  summarySheet.columns = [
    { header: "Bill ID", key: "id", width: 38 },
    { header: "Date", key: "billDate", width: 14 },
    { header: "Type", key: "type", width: 12 },
    { header: "Invoice #", key: "invoiceNumber", width: 20 },
    { header: "Vendor Name", key: "vendorName", width: 28 },
    { header: "GSTIN", key: "gstin", width: 18 },
    { header: "Subtotal", key: "subtotal", width: 16, style: { numFmt: CURRENCY_FORMAT } },
    { header: "CGST", key: "cgst", width: 14, style: { numFmt: CURRENCY_FORMAT } },
    { header: "SGST", key: "sgst", width: 14, style: { numFmt: CURRENCY_FORMAT } },
    { header: "IGST", key: "igst", width: 14, style: { numFmt: CURRENCY_FORMAT } },
    { header: "Cess", key: "cess", width: 14, style: { numFmt: CURRENCY_FORMAT } },
    { header: "Total", key: "total", width: 18, style: { numFmt: CURRENCY_FORMAT } },
    { header: "Status", key: "status", width: 14 },
  ];

  const summaryHeader = summarySheet.getRow(1);
  summaryHeader.font = { bold: true };
  summaryHeader.commit();

  let sumSubtotal = 0;
  let sumCgst = 0;
  let sumSgst = 0;
  let sumIgst = 0;
  let sumCess = 0;
  let sumTotal = 0;

  for (const row of dataset.summary) {
    sumSubtotal += Number(row.subtotal) || 0;
    sumCgst += Number(row.cgst) || 0;
    sumSgst += Number(row.sgst) || 0;
    sumIgst += Number(row.igst) || 0;
    sumCess += Number(row.cess) || 0;
    sumTotal += Number(row.total) || 0;

    summarySheet
      .addRow({
        id: sanitizeFormula(row.id),
        billDate: row.billDate ? sanitizeFormula(row.billDate) : "",
        type: sanitizeFormula(row.type),
        invoiceNumber: row.invoiceNumber ? sanitizeFormula(row.invoiceNumber) : "",
        vendorName: row.vendorName ? sanitizeFormula(row.vendorName) : "",
        gstin: row.gstin ? sanitizeFormula(row.gstin) : "",
        subtotal: Number(row.subtotal) || 0,
        cgst: Number(row.cgst) || 0,
        sgst: Number(row.sgst) || 0,
        igst: Number(row.igst) || 0,
        cess: Number(row.cess) || 0,
        total: Number(row.total) || 0,
        status: sanitizeFormula(row.status),
      })
      .commit();
  }

  // Totals row for Summary
  const summaryTotalsRow = summarySheet.addRow({
    id: "Total",
    billDate: "",
    type: "",
    invoiceNumber: "",
    vendorName: "",
    gstin: "",
    subtotal: sumSubtotal,
    cgst: sumCgst,
    sgst: sumSgst,
    igst: sumIgst,
    cess: sumCess,
    total: sumTotal,
    status: "",
  });
  summaryTotalsRow.font = { bold: true };
  summaryTotalsRow.commit();
  await summarySheet.commit();

  // --- Sheet 2: Itemized ---
  const itemizedSheet = workbook.addWorksheet("Itemized", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  itemizedSheet.columns = [
    { header: "Bill Date", key: "billDate", width: 14 },
    { header: "Invoice #", key: "invoiceNumber", width: 20 },
    { header: "Vendor", key: "vendorName", width: 28 },
    { header: "Item Description", key: "description", width: 32 },
    { header: "HSN/SAC", key: "hsnSac", width: 14 },
    { header: "Quantity", key: "quantity", width: 14, style: { numFmt: QUANTITY_FORMAT } },
    { header: "Unit", key: "unit", width: 10 },
    { header: "Rate", key: "rate", width: 14, style: { numFmt: CURRENCY_FORMAT } },
    { header: "Discount", key: "discount", width: 14, style: { numFmt: CURRENCY_FORMAT } },
    {
      header: "Taxable Value",
      key: "taxableValue",
      width: 16,
      style: { numFmt: CURRENCY_FORMAT },
    },
    { header: "GST %", key: "gstRate", width: 12, style: { numFmt: NUMBER_FORMAT } },
    { header: "CGST", key: "cgst", width: 14, style: { numFmt: CURRENCY_FORMAT } },
    { header: "SGST", key: "sgst", width: 14, style: { numFmt: CURRENCY_FORMAT } },
    { header: "IGST", key: "igst", width: 14, style: { numFmt: CURRENCY_FORMAT } },
    { header: "Line Total", key: "lineTotal", width: 18, style: { numFmt: CURRENCY_FORMAT } },
  ];

  const itemizedHeader = itemizedSheet.getRow(1);
  itemizedHeader.font = { bold: true };
  itemizedHeader.commit();

  let sumItemQty = 0;
  let sumItemDiscount = 0;
  let sumItemTaxable = 0;
  let sumItemCgst = 0;
  let sumItemSgst = 0;
  let sumItemIgst = 0;
  let sumItemLineTotal = 0;

  for (const item of dataset.itemized) {
    sumItemQty += Number(item.quantity) || 0;
    sumItemDiscount += Number(item.discount) || 0;
    sumItemTaxable += Number(item.taxableValue) || 0;
    sumItemCgst += Number(item.cgst) || 0;
    sumItemSgst += Number(item.sgst) || 0;
    sumItemIgst += Number(item.igst) || 0;
    sumItemLineTotal += Number(item.lineTotal) || 0;

    itemizedSheet
      .addRow({
        billDate: item.billDate ? sanitizeFormula(item.billDate) : "",
        invoiceNumber: item.invoiceNumber ? sanitizeFormula(item.invoiceNumber) : "",
        vendorName: item.vendorName ? sanitizeFormula(item.vendorName) : "",
        description: sanitizeFormula(item.description),
        hsnSac: item.hsnSac ? sanitizeFormula(item.hsnSac) : "",
        quantity: Number(item.quantity) || 0,
        unit: sanitizeFormula(item.unit),
        rate: Number(item.rate) || 0,
        discount: Number(item.discount) || 0,
        taxableValue: Number(item.taxableValue) || 0,
        gstRate: item.gstRate != null ? Number(item.gstRate) : null,
        cgst: Number(item.cgst) || 0,
        sgst: Number(item.sgst) || 0,
        igst: Number(item.igst) || 0,
        lineTotal: Number(item.lineTotal) || 0,
      })
      .commit();
  }

  const itemizedTotalsRow = itemizedSheet.addRow({
    billDate: "Total",
    invoiceNumber: "",
    vendorName: "",
    description: "",
    hsnSac: "",
    quantity: sumItemQty,
    unit: "",
    rate: null,
    discount: sumItemDiscount,
    taxableValue: sumItemTaxable,
    gstRate: null,
    cgst: sumItemCgst,
    sgst: sumItemSgst,
    igst: sumItemIgst,
    lineTotal: sumItemLineTotal,
  });
  itemizedTotalsRow.font = { bold: true };
  itemizedTotalsRow.commit();
  await itemizedSheet.commit();

  // --- Sheet 3: Vendor Spend ---
  const vendorSheet = workbook.addWorksheet("Vendor Spend", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  vendorSheet.columns = [
    { header: "Vendor Name", key: "vendorName", width: 28 },
    { header: "GSTIN", key: "gstin", width: 18 },
    { header: "Total Bills", key: "totalBills", width: 14, style: { numFmt: "#,##0" } },
    { header: "Total Spend", key: "totalSpend", width: 18, style: { numFmt: CURRENCY_FORMAT } },
    {
      header: "Total Weight/Quantity",
      key: "totalQuantity",
      width: 22,
      style: { numFmt: QUANTITY_FORMAT },
    },
  ];

  const vendorHeader = vendorSheet.getRow(1);
  vendorHeader.font = { bold: true };
  vendorHeader.commit();

  let sumVendorBills = 0;
  let sumVendorSpend = 0;
  let sumVendorQty = 0;

  for (const v of dataset.vendorSpend) {
    sumVendorBills += Number(v.totalBills) || 0;
    sumVendorSpend += Number(v.totalSpend) || 0;
    sumVendorQty += Number(v.totalQuantity) || 0;

    vendorSheet
      .addRow({
        vendorName: sanitizeFormula(v.vendorName),
        gstin: v.gstin ? sanitizeFormula(v.gstin) : "",
        totalBills: Number(v.totalBills) || 0,
        totalSpend: Number(v.totalSpend) || 0,
        totalQuantity: Number(v.totalQuantity) || 0,
      })
      .commit();
  }

  const vendorTotalsRow = vendorSheet.addRow({
    vendorName: "Total",
    gstin: "",
    totalBills: sumVendorBills,
    totalSpend: sumVendorSpend,
    totalQuantity: sumVendorQty,
  });
  vendorTotalsRow.font = { bold: true };
  vendorTotalsRow.commit();
  await vendorSheet.commit();

  await workbook.commit();
}

/**
 * Builds the 3-sheet Excel workbook and returns the result as a Buffer.
 */
export async function generateXlsx(dataset: ExportDataset): Promise<Buffer> {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];

  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  const completion = new Promise<Buffer>((resolve, reject) => {
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

  await streamXlsxWorkbook(dataset, stream);
  return completion;
}
