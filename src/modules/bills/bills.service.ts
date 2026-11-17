import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/client";
import { AppError, notFound } from "../../platform/errors";
import type { Queue } from "../../platform/queue";
import { keys, type Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { dec, fmt, sum } from "../../shared/money";
import { recordAuditEvent } from "../audit/audit.service";
import { businesses, users } from "../businesses/businesses.schema";
import { lockCatalog, resolveProduct, resolveVendor } from "../catalog/catalog.service";
import { type AllocatedLine, allocateCharges, type FeeSplitBasis } from "../costing/allocate";
import { unitCost } from "../costing/average";
import { normalizeInvoiceNumber } from "../extraction/normalize";
import { recordStockIncrement } from "../inventory/inventory.service";
import { convertUnit, getUnitType } from "../inventory/units";
import { computeConfirmedTotal } from "./bills.math";
import { billFiles, billLineItems, bills, extractions } from "./bills.schema";
import { type BillView, loadBillViews } from "./bills.view";

export const EXTRACT_JOB = "bill.extract"; // handled in worker.ts

export type BillsDeps = { database: Database; storage: Storage; queue: Queue };

const wrongStatus = (status: string) =>
  new AppError("wrong_status", 409, `Not allowed while the bill is ${status}`);

async function enqueueExtract(
  queue: Queue,
  tx: Parameters<Parameters<Database["tx"]>[0]>[0],
  billId: string,
  businessId: string,
) {
  await queue.send(
    EXTRACT_JOB,
    { billId, businessId },
    { tx, retryLimit: 3, retryDelay: 30, retryBackoff: true },
  );
}

// ---- create ------------------------------------------------------------------------------------------

export type NewBillFile = { bytes: Uint8Array; mime: string; ext: string; sha256: string };
export type NewBill = {
  businessId: string;
  userId: string;
  clientRef: string;
  type: "purchase" | "sale";
  source: "share" | "camera" | "gallery" | "file";
  droppedAt: Date;
  files: NewBillFile[];
};

export async function createBill(
  d: BillsDeps,
  input: NewBill,
): Promise<{ bill: BillView; created: boolean }> {
  const find = async () => {
    const [row] = await d.database.db
      .select({ id: bills.id })
      .from(bills)
      .where(and(eq(bills.businessId, input.businessId), eq(bills.clientRef, input.clientRef)))
      .limit(1);
    return row?.id ?? null;
  };
  const view = async (id: string) => {
    const [bill] = await loadBillViews(d.database.db, input.businessId, [id]);
    if (!bill) throw notFound("Bill not found");
    return bill;
  };

  const existing = await find();
  if (existing) return { bill: await view(existing), created: false };

  const billId = newId();
  const files = input.files.map((f) => ({ ...f, id: newId() }));
  const keyOf = (f: (typeof files)[number]) => keys.billFile(input.businessId, billId, f.id, f.ext);
  const cleanup = () =>
    d.storage.deletePrefix(keys.billPrefix(input.businessId, billId)).catch(() => 0);

  await Promise.all(files.map((f) => d.storage.putObject(keyOf(f), f.bytes, f.mime)));
  let inserted: boolean;
  try {
    inserted = await d.database.tx(async (tx) => {
      const rows = await tx.db
        .insert(bills)
        .values({
          id: billId,
          businessId: input.businessId,
          clientRef: input.clientRef,
          type: input.type,
          source: input.source,
          uploadedBy: input.userId,
          droppedAt: input.droppedAt,
          fileSha256s: files.map((f) => f.sha256),
        })
        .onConflictDoNothing({ target: [bills.businessId, bills.clientRef] })
        .returning({ id: bills.id });
      if (rows.length === 0) return false;
      await tx.db.insert(billFiles).values(
        files.map((f, position) => ({
          id: f.id,
          businessId: input.businessId,
          billId,
          position,
          storageKey: keyOf(f),
          mimeType: f.mime,
          bytes: f.bytes.byteLength,
          sha256: f.sha256,
        })),
      );
      await enqueueExtract(d.queue, tx, billId, input.businessId);

      const [actor] = await tx.db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      const actorName = actor?.name || actor?.email || "User";

      await recordAuditEvent(tx.db, {
        businessId: input.businessId,
        entityType: "bill",
        entityId: billId,
        action: "created",
        actorId: input.userId,
        actorName,
        diff: {
          clientRef: input.clientRef,
          type: input.type,
          source: input.source,
          fileCount: files.length,
        },
      });

      return true;
    });
  } catch (err) {
    await cleanup();
    throw err;
  }
  if (!inserted) {
    await cleanup(); // lost a race with the same client_ref: the other request owns the bill
    const id = await find();
    if (!id) throw notFound("Bill not found");
    return { bill: await view(id), created: false };
  }
  return { bill: await view(billId), created: true };
}

// ---- read --------------------------------------------------------------------------------------------

export async function listBills(
  d: BillsDeps,
  businessId: string,
  opts: { cursor: string | null; limit: number },
): Promise<{ items: BillView[]; next_cursor: string | null }> {
  const rows = await d.database.db
    .select({ id: bills.id })
    .from(bills)
    .where(
      and(
        eq(bills.businessId, businessId),
        ne(bills.status, "discarded"),
        opts.cursor ? lt(bills.id, opts.cursor) : undefined,
      ),
    )
    .orderBy(desc(bills.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit).map((r) => r.id);
  const items = await loadBillViews(d.database.db, businessId, page);
  return { items, next_cursor: rows.length > opts.limit ? (page.at(-1) ?? null) : null };
}

export async function getBill(d: BillsDeps, businessId: string, id: string): Promise<BillView> {
  const [bill] = await loadBillViews(d.database.db, businessId, [id]);
  if (!bill) throw notFound("Bill not found");
  return bill;
}

export async function getBillFile(
  d: BillsDeps,
  businessId: string,
  billId: string,
  fileId: string,
): Promise<{ stream: ReadableStream<Uint8Array>; mime: string; bytes: number }> {
  const [f] = await d.database.db
    .select()
    .from(billFiles)
    .where(
      and(
        eq(billFiles.id, fileId),
        eq(billFiles.billId, billId),
        eq(billFiles.businessId, businessId),
      ),
    )
    .limit(1);
  if (!f) throw notFound("File not found");
  const stream = await d.storage.getObject(f.storageKey).catch(() => {
    throw notFound("File not found");
  });
  return { stream, mime: f.mimeType, bytes: f.bytes };
}

// ---- confirm -----------------------------------------------------------------------------------------

export type ConfirmLine = {
  description: string;
  productId: string | null;
  masterProductId?: string | null;
  quantity: string;
  unit: string;
  rate: string;
  discount: string;
  printedAmount: string | null;
  hsnSac: string | null;
  gstRate: string | null;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  flags: string[];
};
export type ConfirmCharge = {
  id: string;
  label: string;
  amount: string;
  category?: string | null;
};
export type ConfirmInput = {
  type: "purchase" | "sale";
  vendorId: string | null;
  vendorName: string;
  invoiceNumber: string;
  billDate: string | null;
  lines: ConfirmLine[];
  charges?: ConfirmCharge[] | undefined;
  /** How to split the charges over the lines; defaults to weight. */
  feeSplitBasis?: FeeSplitBasis | undefined;
};

export async function confirmBill(
  d: BillsDeps,
  ctx: { businessId: string; userId: string },
  billId: string,
  input: ConfirmInput,
): Promise<BillView> {
  await d.database.tx(async ({ db }) => {
    await lockCatalog(db, ctx.businessId);
    const [bill] = await db
      .select()
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.businessId, ctx.businessId)))
      .for("update");
    if (!bill) throw notFound("Bill not found");
    if (bill.status !== "needs_review") throw wrongStatus(bill.status);

    const vendorId = await resolveVendor(db, ctx.businessId, {
      vendorId: input.vendorId,
      name: input.vendorName,
      gstin: bill.counterpartyGstin,
    });

    // Landed cost: this bill's fees, discount and (when not claimable) GST are split over this bill's
    // lines only. Each stocked purchase line then enters stock as its own lot at its own cost.
    const [biz] = await db
      .select({ gstin: businesses.gstin })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .limit(1);
    const feeSplitBasis = input.feeSplitBasis ?? "weight";
    const lineTaxOf = (l: ConfirmLine) => sum([l.cgst, l.sgst, l.igst, l.cess]);
    const anyLineTax = input.lines.some((l) => lineTaxOf(l).gt(0));
    const feesTotal =
      input.charges !== undefined
        ? fmt(sum(input.charges.map((c) => c.amount)))
        : bill.otherCharges;
    const alloc = allocateCharges({
      lines: input.lines.map((l) => ({
        value: fmt(dec(l.quantity).mul(dec(l.rate)).minus(dec(l.discount))),
        tax: fmt(lineTaxOf(l)),
        weightKg:
          getUnitType(l.unit) === "weight" ? fmt(convertUnit(l.quantity, l.unit, "kg"), 3) : null,
      })),
      fees: feesTotal,
      discount: bill.discountTotal,
      billTax: anyLineTax
        ? "0"
        : fmt(sum([bill.cgstTotal, bill.sgstTotal, bill.igstTotal, bill.cessTotal])),
      taxesIncluded: bill.taxesIncluded,
      taxIsCost: !(biz?.gstin && bill.counterpartyGstin),
      basis: feeSplitBasis,
    });

    const rows = [];
    for (const [position, l] of input.lines.entries()) {
      const { id: productId, masterProductId: prodMasterId } = await resolveProduct(
        db,
        ctx.businessId,
        vendorId,
        {
          productId: l.productId,
          description: l.description,
          unit: l.unit,
          hsnSac: l.hsnSac,
          masterProductId: l.masterProductId,
        },
      );
      const masterProductId = l.masterProductId ?? prodMasterId ?? null;
      const lineId = newId();

      // Costing for this line (see allocateCharges).
      const a = alloc.lines[position] as AllocatedLine;
      const qty = dec(l.quantity);
      const costing: {
        allocatedFees: string;
        landedCost: string | null;
        landedUnitCost: string | null;
        costOfGoods: string | null;
        grossProfit: string | null;
      } = {
        allocatedFees: a.fees,
        landedCost: null,
        landedUnitCost: null,
        costOfGoods: null,
        grossProfit: null,
      };
      if (input.type === "purchase") {
        costing.landedCost = a.cost;
        costing.landedUnitCost = unitCost(a.cost, qty);
      }

      if (masterProductId && qty.gt(0)) {
        if (input.type === "purchase") {
          await recordStockIncrement(db, {
            businessId: ctx.businessId,
            masterProductId,
            deltaQuantity: l.quantity,
            quantityUnit: l.unit,
            billId,
            billLineItemId: lineId,
            vendorId,
            type: "purchase_in",
            cost: { goods: fmt(dec(a.goods).plus(dec(a.tax))), fees: a.fees },
            receivedOn: input.billDate,
          });
        } else if (input.type === "sale") {
          const moved = await recordStockIncrement(db, {
            businessId: ctx.businessId,
            masterProductId,
            deltaQuantity: qty.neg().toString(),
            quantityUnit: l.unit,
            billId,
            billLineItemId: lineId,
            vendorId,
            type: "sale_out",
          });
          // Sold at the average cost of the moment; unknown when nothing costed was ever bought.
          if (moved.valueDelta != null) {
            const cogs = dec(moved.valueDelta).neg();
            costing.costOfGoods = fmt(cogs);
            costing.grossProfit = fmt(dec(a.goods).minus(dec(a.fees)).minus(cogs));
          }
        }
      }

      rows.push({
        id: lineId,
        businessId: ctx.businessId,
        billId,
        position,
        descriptionRaw: l.description,
        productId,
        suggestedProductId: null,
        masterProductId,
        hsnSac: l.hsnSac,
        quantity: l.quantity,
        unit: l.unit,
        rate: l.rate,
        discount: l.discount,
        printedAmount: l.printedAmount,
        taxableValue: null,
        gstRate: l.gstRate,
        cgst: l.cgst,
        sgst: l.sgst,
        igst: l.igst,
        cess: l.cess,
        amount: fmt(dec(l.quantity).mul(dec(l.rate)).minus(dec(l.discount))),
        flags: l.flags,
        billDate: input.billDate,
        billType: input.type,
        vendorId,
        isConfirmed: true,
        ...costing,
      });
    }
    await db.delete(billLineItems).where(eq(billLineItems.billId, billId));
    if (rows.length > 0) await db.insert(billLineItems).values(rows);

    // Bill-level taxes follow the reviewed lines when they carry tax; otherwise the extracted totals stay.
    const lineTax = (pick: (l: ConfirmLine) => string) => sum(input.lines.map(pick));
    const fromLines = {
      cgst: lineTax((l) => l.cgst),
      sgst: lineTax((l) => l.sgst),
      igst: lineTax((l) => l.igst),
      cess: lineTax((l) => l.cess),
    };
    const linesHaveTax = Object.values(fromLines).some((v) => v.gt(0));
    const taxes = linesHaveTax
      ? {
          cgst: fmt(fromLines.cgst),
          sgst: fmt(fromLines.sgst),
          igst: fmt(fromLines.igst),
          cess: fmt(fromLines.cess),
        }
      : {
          cgst: bill.cgstTotal,
          sgst: bill.sgstTotal,
          igst: bill.igstTotal,
          cess: bill.cessTotal,
        };

    const charges = input.charges ?? bill.charges ?? [];
    const otherCharges =
      input.charges !== undefined
        ? fmt(sum(input.charges.map((c) => c.amount)))
        : bill.otherCharges;

    await db
      .update(bills)
      .set({
        type: input.type,
        status: "confirmed",
        vendorId,
        vendorNameRaw: input.vendorName.trim(),
        invoiceNumber: input.invoiceNumber,
        invoiceNumberNorm: normalizeInvoiceNumber(input.invoiceNumber),
        billDate: input.billDate,
        cgstTotal: taxes.cgst,
        sgstTotal: taxes.sgst,
        igstTotal: taxes.igst,
        cessTotal: taxes.cess,
        charges,
        otherCharges,
        feeSplitBasis,
        confirmedTotal: computeConfirmedTotal({
          lineAmounts: rows.map((r) => r.amount),
          ...taxes,
          taxesIncluded: bill.taxesIncluded,
          otherCharges,
          discountTotal: bill.discountTotal,
          roundOff: bill.roundOff,
        }),
        confirmedBy: ctx.userId,
        confirmedAt: new Date(),
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, billId));

    const [actor] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);
    const actorName = actor?.name || actor?.email || "User";

    await recordAuditEvent(db, {
      businessId: ctx.businessId,
      entityType: "bill",
      entityId: billId,
      action: "confirmed",
      actorId: ctx.userId,
      actorName,
      diff: {
        type: input.type,
        vendorName: input.vendorName,
        invoiceNumber: input.invoiceNumber,
        billDate: input.billDate,
        lineCount: rows.length,
        chargesCount: charges.length,
      },
    });
  });
  return getBill(d, ctx.businessId, billId);
}

// ---- discard / restore / retry -----------------------------------------------------------------------

export async function discardBill(d: BillsDeps, businessId: string, billId: string): Promise<void> {
  await d.database.tx(async ({ db }) => {
    const [bill] = await db
      .select({ status: bills.status })
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.businessId, businessId)))
      .for("update");
    if (!bill) throw notFound("Bill not found");
    if (bill.status === "confirmed") throw wrongStatus(bill.status);
    if (bill.status === "discarded") return;
    await db
      .update(bills)
      .set({ status: "discarded", updatedAt: new Date() })
      .where(eq(bills.id, billId));
  });
}

export async function restoreBill(
  d: BillsDeps,
  businessId: string,
  billId: string,
): Promise<BillView> {
  await d.database.tx(async (tx) => {
    const [bill] = await tx.db
      .select({ status: bills.status, failureReason: bills.failureReason })
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.businessId, businessId)))
      .for("update");
    if (!bill) throw notFound("Bill not found");
    if (bill.status !== "discarded") throw wrongStatus(bill.status);
    let next: "failed" | "queued" | "needs_review" = "needs_review";
    if (bill.failureReason) {
      next = "failed";
    } else {
      const [done] = await tx.db
        .select({ one: sql<number>`1` })
        .from(extractions)
        .where(and(eq(extractions.billId, billId), eq(extractions.status, "succeeded")))
        .limit(1);
      if (!done) next = "queued";
    }
    await tx.db
      .update(bills)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(bills.id, billId));
    if (next === "queued") await enqueueExtract(d.queue, tx, billId, businessId);
  });
  return getBill(d, businessId, billId);
}

export async function retryBill(
  d: BillsDeps,
  businessId: string,
  billId: string,
): Promise<BillView> {
  await d.database.tx(async (tx) => {
    const [bill] = await tx.db
      .select({ status: bills.status })
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.businessId, businessId)))
      .for("update");
    if (!bill) throw notFound("Bill not found");
    if (bill.status !== "failed") throw wrongStatus(bill.status);
    await tx.db
      .update(bills)
      .set({ status: "queued", failureReason: null, updatedAt: new Date() })
      .where(eq(bills.id, billId));
    await enqueueExtract(d.queue, tx, billId, businessId);
  });
  return getBill(d, businessId, billId);
}
