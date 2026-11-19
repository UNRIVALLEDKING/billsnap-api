import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { Database, Executor } from "../../platform/db/client";
import { AppError, notFound } from "../../platform/errors";
import type { Queue } from "../../platform/queue";
import { keys, type Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { dec, fmt, sum } from "../../shared/money";
import { recordAuditEvent } from "../audit/audit.service";
import { businesses, users } from "../businesses/businesses.schema";
import { products, vendors } from "../catalog/catalog.schema";
import {
  loadPackSpecs,
  lockCatalog,
  resolveProduct,
  resolveVendor,
} from "../catalog/catalog.service";
import { type AllocatedLine, allocateCharges, type FeeSplitBasis } from "../costing/allocate";
import { unitCost } from "../costing/average";
import { isOwnParty, normalizeInvoiceNumber, type OwnBusiness } from "../extraction/normalize";
import { feeDefinitions, masterProducts } from "../inventory/inventory.schema";
import {
  loadItemUnits,
  type UnitConversionLine,
  unitConversionNeeded,
} from "../inventory/inventory.service";
import { learnPackSizes } from "../inventory/item-units";
import { replayItems } from "../inventory/replay";
import {
  builtinFactor,
  convertUnit,
  type FactorSource,
  getUnitType,
  lineStockFactor,
  normalizeUnit,
  stockFactor,
} from "../inventory/units";
import { chargeBasis, computeConfirmedTotal, diffLines } from "./bills.math";
import { billFiles, billLineItems, bills, extractions } from "./bills.schema";
import { type BillView, loadBillViews } from "./bills.view";

export const EXTRACT_JOB = "bill.extract"; // handled in worker.ts

export type BillsDeps = { database: Database; storage: Storage; queue: Queue };

const counterpartyIsSelf = () =>
  new AppError(
    "counterparty_is_self",
    422,
    "This is your own business. Choose the customer (or vendor).",
  );

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

// ---- confirm / edit ----------------------------------------------------------------------------------

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
  /** Containers the line came in, e.g. 2 "box"; both null when none were noted. */
  packCount?: string | null | undefined;
  packUnit?: string | null | undefined;
  /**
   * 'goods' (default) or 'credit': an item deducted for an earlier bill (purchase bills only). A
   * credit's amount comes off the total and takes no share of fees or discount.
   */
  lineKind?: "goods" | "credit" | undefined;
  /** Credit only: true (default) when the goods were in stock and go back (a purchase_return). */
  creditInStock?: boolean | undefined;
  /** Credit only: the earlier bill it refers to, when known. */
  creditRefBillId?: string | null | undefined;
  /**
   * Stock units in 1 line unit, chosen on review (docs/CUSTOMER_SPECS_PLAN.md B7); absent: the rule
   * decides. With `saveSpec` it also becomes the party product's pack spec, as `packQtyUnit` (default:
   * the item's stock unit) per 1 line unit; without, it is for this bill only.
   */
  stockFactor?: string | null | undefined;
  saveSpec?: boolean | undefined;
  packQtyUnit?: string | null | undefined;
};
export type ConfirmCharge = {
  id: string;
  label: string;
  amount: string;
  category?: string | null;
  /** How this charge is shared; null uses its fee type's default, then the bill's basis. */
  basis?: FeeSplitBasis | null | undefined;
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
  /** Bill discount (>= 0), shared by value over the goods lines; absent keeps the one read. */
  discountTotal?: string | undefined;
};

type BillRow = typeof bills.$inferSelect;

async function actorName(db: Executor, userId: string): Promise<string> {
  const [actor] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return actor?.name || actor?.email || "User";
}

async function lockBill(db: Executor, businessId: string, billId: string): Promise<BillRow> {
  const [bill] = await db
    .select()
    .from(bills)
    .where(and(eq(bills.id, billId), eq(bills.businessId, businessId)))
    .for("update");
  if (!bill) throw notFound("Bill not found");
  return bill;
}

const invalidLine = (message: string) => new AppError("validation_failed", 422, message);

type LineFactor = { factor: string; source: FactorSource } | null;

/**
 * Each linked line's stock factor (docs/CUSTOMER_SPECS_PLAN.md B7), stored on the line and kept by
 * replay. A factor sent on the line is used as it is ("manual"), and with `save_spec` it also becomes
 * the party product's pack spec ("customer"). Otherwise the rule decides: same unit, built-in, the
 * party's spec, the item's own units. 422 `unit_conversion_needed` lists every line with no factor by
 * its index in the request, naming the item and the party.
 */
async function lineFactors(
  db: Executor,
  businessId: string,
  billId: string,
  party: { id: string | null; name: string },
  lines: Array<{
    unit: string;
    masterProductId: string | null;
    productId: string;
    productCreated: boolean;
    stockFactor: string | null;
    saveSpec: boolean;
    packQtyUnit: string | null;
    /** A credit not in stock moves no stock, so it never needs a factor. */
    required: boolean;
  }>,
): Promise<LineFactor[]> {
  const ids = [...new Set(lines.flatMap((l) => (l.masterProductId ? [l.masterProductId] : [])))];
  const out: LineFactor[] = lines.map(() => null);
  if (ids.length === 0) return out;
  const items = await db
    .select({
      id: masterProducts.id,
      displayName: masterProducts.displayName,
      standardUnit: masterProducts.standardUnit,
    })
    .from(masterProducts)
    .where(and(eq(masterProducts.businessId, businessId), inArray(masterProducts.id, ids)));
  const unitsOf = await loadItemUnits(db, businessId, ids);
  const ownOf = (itemId: string) =>
    (unitsOf.get(itemId) ?? []).map((r) => ({ unit: r.unit, perUnit: r.perUnit }));

  // Sizes chosen on review and saved for the party come first, so other lines of it use them too.
  for (const l of lines) {
    const item = items.find((i) => i.id === l.masterProductId);
    if (!item || l.stockFactor == null || !l.saveSpec) continue;
    const packUnit = normalizeUnit(l.unit);
    if (builtinFactor(packUnit, item.standardUnit)) {
      throw invalidLine(
        `save_spec needs a pack unit: 1 ${packUnit} is always the same amount of ${item.standardUnit}`,
      );
    }
    const qtyUnit = normalizeUnit(l.packQtyUnit ?? item.standardUnit);
    const perQtyUnit = stockFactor(qtyUnit, item.standardUnit, ownOf(item.id));
    if (!perQtyUnit?.gt(0) || qtyUnit === packUnit) {
      throw invalidLine(
        `pack_qty_unit ${qtyUnit} can't express a ${packUnit} of ${item.displayName}`,
      );
    }
    await db
      .update(products)
      .set({
        packUnit,
        packQty: fmt(dec(l.stockFactor).div(perQtyUnit), 6),
        packQtyUnit: qtyUnit,
        updatedAt: new Date(),
      })
      .where(eq(products.id, l.productId));
  }
  const specs = await loadPackSpecs(
    db,
    businessId,
    lines.map((l) => l.productId),
  );

  const stuck: UnitConversionLine[] = [];
  for (const [index, l] of lines.entries()) {
    const item = items.find((i) => i.id === l.masterProductId);
    if (!item) continue;
    if (l.stockFactor != null) {
      out[index] = { factor: fmt(l.stockFactor, 6), source: l.saveSpec ? "customer" : "manual" };
      continue;
    }
    const found = lineStockFactor(
      l.unit,
      item.standardUnit,
      ownOf(item.id),
      specs.get(l.productId) ?? null,
    );
    if (found) {
      out[index] = { factor: fmt(found.factor, 6), source: found.source };
      continue;
    }
    if (!l.required) continue;
    stuck.push({
      index,
      bill_id: billId,
      item_id: item.id,
      item_name: item.displayName,
      from_unit: normalizeUnit(l.unit),
      to_unit: item.standardUnit,
      party_id: party.id,
      party_name: party.name,
      product_id: l.productCreated ? null : l.productId,
    });
  }
  if (stuck.length > 0) throw unitConversionNeeded(stuck);
  return out;
}

/**
 * Writes the reviewed lines with their costing, and the bill's totals, as confirmed. Stock is not
 * touched here: the caller replays the affected items afterwards (inventory/replay.ts).
 */
async function writeReviewedBill(
  db: Executor,
  ctx: { businessId: string; userId: string },
  bill: BillRow,
  input: ConfirmInput,
  opts: { firstConfirm: boolean },
): Promise<{ masterProductIds: string[]; lineCount: number; chargesCount: number }> {
  const billId = bill.id;
  const isCredit = (l: ConfirmLine) => l.lineKind === "credit";
  if (input.type !== "purchase" && input.lines.some(isCredit)) {
    throw new AppError(
      "credit_on_sale",
      422,
      "Credit lines (Less ... from an earlier bill) are only for purchase bills",
    );
  }
  const refs = [
    ...new Set(
      input.lines.flatMap((l) => (isCredit(l) && l.creditRefBillId ? [l.creditRefBillId] : [])),
    ),
  ];
  if (refs.length > 0) {
    const found = await db
      .select({ id: bills.id })
      .from(bills)
      .where(and(eq(bills.businessId, ctx.businessId), inArray(bills.id, refs)));
    if (found.length !== refs.length) {
      throw new AppError(
        "validation_failed",
        422,
        "credit_ref_bill_id is not a bill of this business",
      );
    }
  }
  const [biz] = await db
    .select({ name: businesses.name, gstin: businesses.gstin, aliases: businesses.nameAliases })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))
    .limit(1);
  // Our own business is never the other party (docs/CUSTOMER_SPECS_PLAN.md B6).
  const own: OwnBusiness = {
    name: biz?.name ?? "",
    gstin: biz?.gstin ?? null,
    aliases: biz?.aliases ?? [],
  };
  if (isOwnParty({ name: input.vendorName, gstin: null }, own)) throw counterpartyIsSelf();
  if (input.vendorId) {
    const [chosen] = await db
      .select({ name: vendors.displayName, gstin: vendors.gstin })
      .from(vendors)
      .where(and(eq(vendors.id, input.vendorId), eq(vendors.businessId, ctx.businessId)))
      .limit(1);
    if (chosen && isOwnParty(chosen, own)) throw counterpartyIsSelf();
  }
  // A GSTIN read from the bill that is ours never goes onto the party.
  const partyGstin =
    bill.counterpartyGstin && isOwnParty({ name: null, gstin: bill.counterpartyGstin }, own)
      ? null
      : bill.counterpartyGstin;
  const vendor = await resolveVendor(db, ctx.businessId, {
    vendorId: input.vendorId,
    name: input.vendorName,
    gstin: partyGstin,
  });
  const vendorId = vendor.id;
  const resolved: Array<{
    productId: string;
    productCreated: boolean;
    masterProductId: string | null;
  }> = [];
  for (const l of input.lines) {
    const product = await resolveProduct(db, ctx.businessId, vendorId, {
      productId: l.productId,
      description: l.description,
      unit: l.unit,
      hsnSac: l.hsnSac,
      masterProductId: l.masterProductId,
    });
    resolved.push({
      productId: product.id,
      productCreated: product.created,
      masterProductId: l.masterProductId ?? product.masterProductId ?? null,
    });
  }
  // Every line must convert into its item's stock unit; the whole confirm rolls back otherwise.
  const factors = await lineFactors(
    db,
    ctx.businessId,
    billId,
    { id: vendor.created ? null : vendorId, name: input.vendorName.trim() },
    input.lines.map((l, i) => {
      const r = resolved[i] as (typeof resolved)[number];
      return {
        unit: l.unit,
        masterProductId: r.masterProductId,
        productId: r.productId,
        productCreated: r.productCreated,
        stockFactor: l.stockFactor ?? null,
        saveSpec: l.saveSpec === true,
        packQtyUnit: l.packQtyUnit ?? null,
        required: !(isCredit(l) && l.creditInStock === false),
      };
    }),
  );
  if (input.type === "purchase") {
    await learnPackSizes(
      db,
      ctx.businessId,
      input.lines.map((l, i) => ({
        masterProductId: isCredit(l) ? null : (resolved[i]?.masterProductId ?? null),
        quantity: l.quantity,
        unit: l.unit,
        packCount: l.packCount ?? null,
        packUnit: l.packUnit ?? null,
      })),
    );
  }

  // Landed cost: this bill's fees, discount and (when not claimable) GST are split over this bill's
  // lines only. Each stocked purchase line then enters stock as its own lot at its own cost.
  const feeSplitBasis = input.feeSplitBasis ?? "weight";
  const discountTotal = input.discountTotal ?? bill.discountTotal;
  // Credits keep out of the split: today's goods carry today's fees, discount and tax.
  const goodsLines = input.lines.filter((l) => !isCredit(l));
  const lineTaxOf = (l: ConfirmLine) => sum([l.cgst, l.sgst, l.igst, l.cess]);
  const anyLineTax = goodsLines.some((l) => lineTaxOf(l).gt(0));
  const feesTotal =
    input.charges !== undefined ? fmt(sum(input.charges.map((c) => c.amount))) : bill.otherCharges;
  // Each charge is shared on its own basis: its own, else its fee type's default, else (stored as
  // null) the bill's fee_split_basis.
  const chargeList = input.charges ?? bill.charges ?? [];
  const feeTypes =
    chargeList.length === 0
      ? []
      : await db
          .select({
            name: feeDefinitions.name,
            category: feeDefinitions.category,
            defaultBasis: feeDefinitions.defaultBasis,
          })
          .from(feeDefinitions)
          .where(
            and(eq(feeDefinitions.businessId, ctx.businessId), eq(feeDefinitions.isActive, true)),
          );
  const charges = chargeList.map((c) => ({ ...c, basis: chargeBasis(c, feeTypes) }));
  // Older bills may carry a charges total without the list behind it: that total goes on the bill's basis.
  const byCharge = sum(charges.map((c) => c.amount)).eq(dec(feesTotal));
  const alloc = allocateCharges({
    lines: goodsLines.map((l) => ({
      value: fmt(dec(l.quantity).mul(dec(l.rate)).minus(dec(l.discount))),
      tax: fmt(lineTaxOf(l)),
      weightKg:
        getUnitType(l.unit) === "weight" ? fmt(convertUnit(l.quantity, l.unit, "kg"), 3) : null,
      packs: l.packCount ?? null,
    })),
    fees: feesTotal,
    charges: byCharge ? charges.map((c) => ({ amount: c.amount, basis: c.basis })) : undefined,
    discount: discountTotal,
    billTax: anyLineTax
      ? "0"
      : fmt(sum([bill.cgstTotal, bill.sgstTotal, bill.igstTotal, bill.cessTotal])),
    taxesIncluded: bill.taxesIncluded,
    taxIsCost: !(biz?.gstin && bill.counterpartyGstin),
    basis: feeSplitBasis,
  });

  const rows = [];
  let goodsIndex = 0;
  for (const [position, l] of input.lines.entries()) {
    const { productId, masterProductId } = resolved[position] as (typeof resolved)[number];
    const amount = fmt(dec(l.quantity).mul(dec(l.rate)).minus(dec(l.discount)));
    const credit = isCredit(l);
    const creditInStock = l.creditInStock ?? true;

    // Costing for this line (see allocateCharges). A sale's cost of goods and profit, and an in-stock
    // credit's result, are written by the replay, which knows the average cost on the bill's date.
    const a = credit ? null : (alloc.lines[goodsIndex++] as AllocatedLine);
    const purchase = input.type === "purchase";
    rows.push({
      id: newId(),
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
      amount,
      packCount: l.packCount ?? null,
      packUnit: l.packCount == null ? null : (l.packUnit ?? null),
      stockFactor: factors[position]?.factor ?? null,
      stockFactorSource: factors[position]?.source ?? null,
      flags: l.flags,
      billDate: input.billDate,
      billType: input.type,
      vendorId,
      isConfirmed: true,
      lineKind: credit ? "credit" : "goods",
      creditInStock: credit ? creditInStock : true,
      creditRefBillId: credit ? (l.creditRefBillId ?? null) : null,
      // Not in stock (or not linked to an item): the whole credit is money recovered.
      creditResult: credit && (!creditInStock || !masterProductId) ? amount : null,
      allocatedFees: a ? a.fees : null,
      goodsValue: a ? a.goods : null,
      landedCost: a && purchase ? a.cost : null,
      landedUnitCost: a && purchase ? unitCost(a.cost, dec(l.quantity)) : null,
      costOfGoods: null,
      grossProfit: null,
    });
  }
  await db.delete(billLineItems).where(eq(billLineItems.billId, billId));
  if (rows.length > 0) await db.insert(billLineItems).values(rows);

  // Bill-level taxes follow the reviewed lines when they carry tax; otherwise the extracted totals stay.
  const lineTax = (pick: (l: ConfirmLine) => string) => sum(goodsLines.map(pick));
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

  const otherCharges =
    input.charges !== undefined ? fmt(sum(input.charges.map((c) => c.amount))) : bill.otherCharges;

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
      // A type switch answers the "looks like a sale / purchase" question.
      flags: bill.flags.filter(
        (f) => f !== (input.type === "sale" ? "looks_like_sale" : "looks_like_purchase"),
      ),
      feeSplitBasis,
      discountTotal,
      confirmedTotal: computeConfirmedTotal({
        lineAmounts: rows.filter((r) => r.lineKind === "goods").map((r) => r.amount),
        creditAmounts: rows.filter((r) => r.lineKind === "credit").map((r) => r.amount),
        ...taxes,
        taxesIncluded: bill.taxesIncluded,
        otherCharges,
        discountTotal,
        roundOff: bill.roundOff,
      }),
      // An edit keeps who confirmed the bill and when.
      ...(opts.firstConfirm ? { confirmedBy: ctx.userId, confirmedAt: new Date() } : {}),
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(bills.id, billId));

  return {
    masterProductIds: rows.flatMap((r) => (r.masterProductId ? [r.masterProductId] : [])),
    lineCount: rows.length,
    chargesCount: charges.length,
  };
}

export async function confirmBill(
  d: BillsDeps,
  ctx: { businessId: string; userId: string },
  billId: string,
  input: ConfirmInput,
): Promise<BillView> {
  await d.database.tx(async ({ db }) => {
    await lockCatalog(db, ctx.businessId);
    const bill = await lockBill(db, ctx.businessId, billId);
    if (bill.status !== "needs_review") throw wrongStatus(bill.status);

    const written = await writeReviewedBill(db, ctx, bill, input, { firstConfirm: true });
    // Stock moves in bill-date order, whatever order bills are confirmed in.
    await replayItems(db, ctx.businessId, written.masterProductIds);

    await recordAuditEvent(db, {
      businessId: ctx.businessId,
      entityType: "bill",
      entityId: billId,
      action: "confirmed",
      actorId: ctx.userId,
      actorName: await actorName(db, ctx.userId),
      diff: {
        type: input.type,
        vendorName: input.vendorName,
        invoiceNumber: input.invoiceNumber,
        billDate: input.billDate,
        lineCount: written.lineCount,
        chargesCount: written.chargesCount,
      },
    });
  });
  return getBill(d, ctx.businessId, billId);
}

const diffLinesOf = (db: Executor, billId: string) =>
  db
    .select({
      description: billLineItems.descriptionRaw,
      masterProductId: billLineItems.masterProductId,
      quantity: billLineItems.quantity,
      unit: billLineItems.unit,
      rate: billLineItems.rate,
      amount: billLineItems.amount,
      lineKind: billLineItems.lineKind,
    })
    .from(billLineItems)
    .where(eq(billLineItems.billId, billId))
    .orderBy(billLineItems.position);

/**
 * Edits a confirmed bill: same body as confirm. Lines and costing are rewritten as confirm writes
 * them, then every item on the old or new lines is replayed, so later sales are re-costed.
 */
export async function editBill(
  d: BillsDeps,
  ctx: { businessId: string; userId: string },
  billId: string,
  input: ConfirmInput,
): Promise<BillView> {
  await d.database.tx(async ({ db }) => {
    await lockCatalog(db, ctx.businessId);
    const bill = await lockBill(db, ctx.businessId, billId);
    if (bill.status !== "confirmed") throw wrongStatus(bill.status);

    const beforeLines = await diffLinesOf(db, billId);
    const written = await writeReviewedBill(db, ctx, bill, input, { firstConfirm: false });
    await replayItems(db, ctx.businessId, [
      ...beforeLines.flatMap((l) => (l.masterProductId ? [l.masterProductId] : [])),
      ...written.masterProductIds,
    ]);

    const after = await lockBill(db, ctx.businessId, billId);
    const fields: Record<string, { before: unknown; after: unknown }> = {};
    const field = (name: string, before: unknown, afterValue: unknown) => {
      if (before !== afterValue) fields[name] = { before, after: afterValue };
    };
    field("type", bill.type, after.type);
    field("vendorName", bill.vendorNameRaw, after.vendorNameRaw);
    field("invoiceNumber", bill.invoiceNumber, after.invoiceNumber);
    field("billDate", bill.billDate, after.billDate);

    await recordAuditEvent(db, {
      businessId: ctx.businessId,
      entityType: "bill",
      entityId: billId,
      action: "edited",
      actorId: ctx.userId,
      actorName: await actorName(db, ctx.userId),
      diff: {
        fields,
        lines: diffLines(beforeLines, await diffLinesOf(db, billId)),
        totals: {
          before: {
            total: bill.confirmedTotal,
            charges: bill.otherCharges,
            discount: bill.discountTotal,
          },
          after: {
            total: after.confirmedTotal,
            charges: after.otherCharges,
            discount: after.discountTotal,
          },
        },
      },
    });
  });
  return getBill(d, ctx.businessId, billId);
}

// ---- discard / restore / retry -----------------------------------------------------------------------

/**
 * Discards a bill. A confirmed bill is removed from the books: its lines stop counting (they are kept,
 * unconfirmed, for history and restore) and its items are replayed without it.
 */
export async function discardBill(
  d: BillsDeps,
  ctx: { businessId: string; userId: string },
  billId: string,
): Promise<void> {
  await d.database.tx(async ({ db }) => {
    await lockCatalog(db, ctx.businessId);
    const bill = await lockBill(db, ctx.businessId, billId);
    if (bill.status === "discarded") return;
    await db
      .update(bills)
      .set({ status: "discarded", updatedAt: new Date() })
      .where(eq(bills.id, billId));
    if (bill.status !== "confirmed") return;

    const lines = await db
      .update(billLineItems)
      .set({ isConfirmed: false })
      .where(eq(billLineItems.billId, billId))
      .returning({ masterProductId: billLineItems.masterProductId });
    await replayItems(
      db,
      ctx.businessId,
      lines.flatMap((l) => (l.masterProductId ? [l.masterProductId] : [])),
    );
    await recordAuditEvent(db, {
      businessId: ctx.businessId,
      entityType: "bill",
      entityId: billId,
      action: "removed",
      actorId: ctx.userId,
      actorName: await actorName(db, ctx.userId),
      diff: {
        type: bill.type,
        vendorName: bill.vendorNameRaw,
        invoiceNumber: bill.invoiceNumber,
        billDate: bill.billDate,
        total: bill.confirmedTotal,
        lineCount: lines.length,
      },
    });
  });
}

/**
 * Brings a discarded bill back. A bill that was confirmed before goes back to review with its lines:
 * they count again only once it is confirmed again.
 */
export async function restoreBill(
  d: BillsDeps,
  businessId: string,
  billId: string,
): Promise<BillView> {
  await d.database.tx(async (tx) => {
    const [bill] = await tx.db
      .select({
        status: bills.status,
        failureReason: bills.failureReason,
        confirmedAt: bills.confirmedAt,
      })
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.businessId, businessId)))
      .for("update");
    if (!bill) throw notFound("Bill not found");
    if (bill.status !== "discarded") throw wrongStatus(bill.status);
    let next: "failed" | "queued" | "needs_review" = "needs_review";
    if (bill.confirmedAt) {
      // Reviewed before: keep its lines for review rather than extracting again.
    } else if (bill.failureReason) {
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
