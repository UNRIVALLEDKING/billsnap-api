import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env";
import { parseJsonBody, validate, validationFailed } from "../../http/validate";
import { AppError } from "../../platform/errors";
import { dec, fmt } from "../../shared/money";
import { getBillHistory } from "../audit/audit.service";
import {
  type BillsDeps,
  type ConfirmInput,
  confirmBill,
  createBill,
  discardBill,
  editBill,
  getBill,
  getBillFile,
  listBills,
  restoreBill,
  retryBill,
} from "./bills.service";
import { sniffFile } from "./file-sniff";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
const MULTIPART_OVERHEAD = 1024 * 1024;

const tooLarge = (detail: string) => new AppError("payload_too_large", 413, detail);

const meta = z.object({
  client_ref: z.uuid(),
  type: z.enum(["purchase", "sale"]),
  source: z.enum(["share", "camera", "gallery", "file"]),
  dropped_at: z.iso.datetime({ offset: true }),
});

/** A non-negative decimal string that fits the column (`maxInt` integer digits), normalised to `dp` places. */
const num = (maxInt: number, dp: number) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{1,${maxInt}}(\\.\\d{1,8})?$`), "expected a non-negative decimal string")
    .transform((s) => fmt(s, dp));

const emptyToNull = (v: string | null) => (v === null || v === "" ? null : v);

const confirmLine = z.object({
  description: z.string().trim().min(1).max(500),
  product_id: z.uuid().nullable(),
  master_product_id: z.uuid().nullable().optional(),
  quantity: num(11, 3),
  unit: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .transform((s) => s.toLowerCase()),
  rate: num(10, 4),
  discount: num(12, 2),
  printed_amount: num(12, 2).nullable(),
  hsn_sac: z.string().trim().max(20).nullable().transform(emptyToNull),
  gst_rate: num(3, 2).nullable(),
  cgst: num(12, 2),
  sgst: num(12, 2),
  igst: num(12, 2),
  cess: num(12, 2),
  flags: z.array(z.string().max(40)).max(20),
  // Containers the line came in ("2 box"); pack_unit defaults to "box" when only a count is sent.
  pack_count: num(7, 3).nullable().optional(),
  pack_unit: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .transform((s) => s.toLowerCase())
    .nullable()
    .optional(),
  // "credit": an item deducted for an earlier bill ("Less Broccoli 27 x 70"); purchase bills only.
  line_kind: z.enum(["goods", "credit"]).optional(),
  // Credit only: true (default) when it was in stock and goes back to the vendor.
  credit_in_stock: z.boolean().optional(),
  credit_ref_bill_id: z.uuid().nullable().optional(),
  // Stock units in 1 line unit, chosen on review (docs/CUSTOMER_SPECS_PLAN.md B7); absent: the rule decides.
  stock_factor: num(8, 6)
    .refine((s) => dec(s).gt(0), "stock_factor must be greater than 0")
    .nullable()
    .optional(),
  // true: also save it as the party product's pack spec (future bills); false/absent: this bill only.
  save_spec: z.boolean().optional(),
  // With save_spec: the unit the spec's pack_qty is kept in (e.g. "g"); default the item's stock unit.
  pack_qty_unit: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .transform((s) => s.toLowerCase())
    .nullable()
    .optional(),
});

const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const confirmCharge = z.object({
  id: z.string().optional(),
  label: z.string().trim().min(1).max(200),
  amount: num(12, 2),
  category: z.string().trim().max(100).optional().nullable(),
  // How this charge is shared; absent or null: its fee type's default, else fee_split_basis.
  basis: z.enum(["weight", "value", "packs"]).nullable().optional(),
});

const confirmBody = z.object({
  type: z.enum(["purchase", "sale"]),
  vendor_id: z.uuid().nullable(),
  vendor_name: z.string().trim().min(1).max(200),
  invoice_number: z.string().trim().max(100),
  bill_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealDate, "not a calendar date")
    .nullable(),
  lines: z.array(confirmLine).max(500),
  charges: z.array(confirmCharge).max(100).optional(),
  fee_split_basis: z.enum(["weight", "value", "packs"]).optional(),
  // Bill discount, shared by value over the goods lines; absent keeps the discount read from the bill.
  discount_total: num(12, 2).optional(),
});

const confirmInput = (b: z.infer<typeof confirmBody>): ConfirmInput => ({
  type: b.type,
  vendorId: b.vendor_id,
  vendorName: b.vendor_name,
  invoiceNumber: b.invoice_number,
  billDate: b.bill_date,
  lines: b.lines.map((l) => ({
    description: l.description,
    productId: l.product_id,
    masterProductId: l.master_product_id ?? null,
    quantity: l.quantity,
    unit: l.unit,
    rate: l.rate,
    discount: l.discount,
    printedAmount: l.printed_amount,
    hsnSac: l.hsn_sac,
    gstRate: l.gst_rate,
    cgst: l.cgst,
    sgst: l.sgst,
    igst: l.igst,
    cess: l.cess,
    flags: l.flags,
    packCount: l.pack_count ?? null,
    packUnit: l.pack_count == null ? null : (l.pack_unit ?? "box"),
    lineKind: l.line_kind ?? "goods",
    creditInStock: l.credit_in_stock ?? true,
    creditRefBillId: l.credit_ref_bill_id ?? null,
    stockFactor: l.stock_factor ?? null,
    saveSpec: l.save_spec ?? false,
    packQtyUnit: l.pack_qty_unit ?? null,
  })),
  charges: b.charges?.map((c) => ({
    id: c.id ?? crypto.randomUUID(),
    label: c.label,
    amount: c.amount,
    category: c.category ?? null,
    basis: c.basis ?? null,
  })),
  feeSplitBasis: b.fee_split_basis,
  discountTotal: b.discount_total,
});

const uuidParam = z.uuid();
const idParam = (raw: string | undefined) => {
  const parsed = uuidParam.safeParse(raw);
  // An id that cannot be a UUID cannot exist: same answer as a missing one.
  if (!parsed.success) throw new AppError("not_found", 404, "Bill not found");
  return parsed.data;
};

export function billsRoutes(deps: BillsDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post("/", async (c) => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES + MULTIPART_OVERHEAD) {
      throw tooLarge("Upload is larger than 50 MB");
    }
    const form = await c.req.formData().catch(() => {
      throw validationFailed("Expected a multipart/form-data body");
    });
    const rawMeta = form.get("meta");
    let metaJson: unknown;
    try {
      metaJson = JSON.parse(typeof rawMeta === "string" ? rawMeta : "");
    } catch {
      throw validationFailed("Field `meta` must be a JSON object");
    }
    const m = validate(meta, metaJson);

    const parts = form.getAll("files").filter((f): f is File => typeof f !== "string");
    if (parts.length === 0) throw validationFailed("At least one file is required");
    if (parts.length > MAX_FILES) throw tooLarge(`At most ${MAX_FILES} files per bill`);
    let total = 0;
    for (const f of parts) {
      if (f.size > MAX_FILE_BYTES) throw tooLarge("A file is larger than 20 MB");
      total += f.size;
    }
    if (total > MAX_REQUEST_BYTES) throw tooLarge("Upload is larger than 50 MB");

    const files = [];
    for (const f of parts) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const kind = sniffFile(bytes);
      if (!kind) {
        throw new AppError(
          "unsupported_media_type",
          415,
          "Only JPEG, PNG, WebP, HEIC and PDF files are accepted",
        );
      }
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      files.push({ bytes, mime: kind.mime, ext: kind.ext, sha256 });
    }

    const { bill, created } = await createBill(deps, {
      businessId: c.var.business.id,
      userId: c.var.user.id,
      clientRef: m.client_ref,
      type: m.type,
      source: m.source,
      droppedAt: new Date(m.dropped_at),
      files,
    });
    return c.json(bill, created ? 201 : 200);
  });

  routes.get("/", async (c) => {
    const q = validate(
      z.object({
        cursor: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      c.req.query(),
    );
    return c.json(
      await listBills(deps, c.var.business.id, { cursor: q.cursor ?? null, limit: q.limit }),
    );
  });

  routes.get("/:id", async (c) =>
    c.json(await getBill(deps, c.var.business.id, idParam(c.req.param("id")))),
  );

  routes.get("/:id/history", async (c) => {
    const history = await getBillHistory(
      deps.database.db,
      c.var.business.id,
      idParam(c.req.param("id")),
    );
    return c.json({ history, items: history });
  });

  routes.get("/:id/files/:fileId", async (c) => {
    const file = await getBillFile(
      deps,
      c.var.business.id,
      idParam(c.req.param("id")),
      idParam(c.req.param("fileId")),
    );
    return new Response(file.stream, {
      headers: {
        "content-type": file.mime,
        "content-length": String(file.bytes),
        "cache-control": "private, max-age=3600",
      },
    });
  });

  routes.post("/:id/confirm", async (c) => {
    const id = idParam(c.req.param("id"));
    const b = await parseJsonBody(confirmBody, c.req.raw);
    const ctx = { businessId: c.var.business.id, userId: c.var.user.id };
    return c.json(await confirmBill(deps, ctx, id, confirmInput(b)));
  });

  // Edit a confirmed bill: same body as confirm; stock and profit of the affected items are rebuilt.
  routes.put("/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    const b = await parseJsonBody(confirmBody, c.req.raw);
    const ctx = { businessId: c.var.business.id, userId: c.var.user.id };
    return c.json(await editBill(deps, ctx, id, confirmInput(b)));
  });

  // Also deletes a confirmed bill: its stock movements are undone.
  routes.post("/:id/discard", async (c) => {
    const ctx = { businessId: c.var.business.id, userId: c.var.user.id };
    await discardBill(deps, ctx, idParam(c.req.param("id")));
    return c.body(null, 204);
  });

  routes.post("/:id/restore", async (c) =>
    c.json(await restoreBill(deps, c.var.business.id, idParam(c.req.param("id")))),
  );

  routes.post("/:id/retry", async (c) =>
    c.json(await retryBill(deps, c.var.business.id, idParam(c.req.param("id")))),
  );

  return routes;
}
