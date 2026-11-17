import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { AiError, type AiProvider } from "../../platform/ai";
import type { Database, Executor } from "../../platform/db/client";
import type { Logger } from "../../platform/logger";
import type { Job } from "../../platform/queue";
import type { Storage } from "../../platform/storage/r2";
import { fyOf, fyRange } from "../../shared/fy";
import { newId } from "../../shared/ids";
import { billFiles, billLineItems, bills, extractions } from "../bills/bills.schema";
import { businesses } from "../businesses/businesses.schema";
import { products } from "../catalog/catalog.schema";
import { matchProduct, matchVendor } from "../catalog/catalog.service";
import { masterProducts } from "../inventory/inventory.schema";
import { matchMasterProduct } from "../inventory/match";
import { type NormalizedBill, normalizeExtraction } from "./normalize";
import { buildPrompt, PROMPT_VERSION } from "./prompts/v1";
import { type ExtractionOutput, extractionOutput, incompleteRead, RESPONSE_SCHEMA } from "./schema";

/** Gemini takes files inline up to about 20 MB of request; base64 adds a third, so cap the raw bytes. */
export const MAX_INLINE_BYTES = 14 * 1024 * 1024;
const EXTRA_ATTEMPTS = 4;
const CALL_TIMEOUT_MS = 45_000;

export type ExtractDeps = {
  database: Database;
  storage: Storage;
  /** Undefined when no API key is configured: bills then fail with ai_error. */
  ai: AiProvider | undefined;
  model: string;
  /** Used for retries after an overloaded or failed call, so one busy model doesn't fail the bill. */
  fallbackModel?: string;
  log: Logger;
  /** Base delay before a retry of a rate-limited / failed call (tests set 0). */
  retryDelayMs?: number;
};

export type ExtractJobData = { billId: string; businessId: string };

type FailureReason = "not_a_bill" | "ai_error" | "too_large";

class InvalidOutput extends Error {}

function describeZod(err: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export function createExtractHandler(deps: ExtractDeps) {
  const { database, storage, ai, model, fallbackModel, log } = deps;
  const retryDelayMs = deps.retryDelayMs ?? 2000;

  async function fail(
    billId: string,
    reason: FailureReason,
    extractionId: string | null = null,
  ): Promise<void> {
    await database.db
      .update(bills)
      .set({
        status: "failed",
        failureReason: reason,
        ...(extractionId && { latestExtractionId: extractionId }),
        updatedAt: new Date(),
      })
      .where(and(eq(bills.id, billId), eq(bills.status, "processing")));
  }

  async function record(
    data: ExtractJobData,
    row: Omit<
      typeof extractions.$inferInsert,
      "id" | "businessId" | "billId" | "provider" | "promptVersion"
    >,
  ): Promise<string> {
    const id = newId();
    await database.db.insert(extractions).values({
      id,
      businessId: data.businessId,
      billId: data.billId,
      provider: ai?.name ?? "none",
      promptVersion: PROMPT_VERSION,
      ...row,
    });
    return id;
  }

  /** Calls the AI with retries; every attempt leaves an extractions row. Throws when it gives up. */
  async function callAi(
    data: ExtractJobData,
    input: {
      files: { mime: string; bytes: Uint8Array }[];
      billType: "purchase" | "sale";
      ownName: string;
      ownGstin?: string;
    },
  ): Promise<{ output: ExtractionOutput; extractionId: string }> {
    if (!ai) throw new Error("no AI provider configured");
    const prompt = buildPrompt({
      billType: input.billType,
      ownName: input.ownName,
      ...(input.ownGstin && { ownGstin: input.ownGstin }),
    });
    let attempt = 0;
    let transient = 0;
    let current = model;
    let repairHint: string | undefined;
    for (;;) {
      attempt++;
      let res: Awaited<ReturnType<AiProvider["extractBill"]>>;
      try {
        res = await ai.extractBill({
          files: input.files,
          hints: {
            billType: input.billType,
            ownName: input.ownName,
            ...(input.ownGstin && { ownGstin: input.ownGstin }),
          },
          model: current,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          prompt,
          responseSchema: RESPONSE_SCHEMA,
          ...(repairHint && { repairHint }),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await record(data, {
          model: current,
          attempt,
          status: "error",
          error: message.slice(0, 1000),
        });
        if (err instanceof AiError && err.retryable && transient < EXTRA_ATTEMPTS) {
          transient++;
          current = current === model ? (fallbackModel ?? model) : model;
          await Bun.sleep(retryDelayMs * transient);
          continue;
        }
        throw err;
      }
      const parsed = extractionOutput.safeParse(res.output);
      const usage = {
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        latencyMs: res.latencyMs,
      };
      const incomplete = parsed.success ? incompleteRead(parsed.data) : null;
      if (parsed.success && !incomplete) {
        const extractionId = await record(data, {
          model: current,
          attempt,
          status: "succeeded",
          output: res.output as object,
          ...usage,
        });
        return { output: parsed.data, extractionId };
      }
      const problem =
        incomplete ??
        (typeof res.output === "string" || parsed.success
          ? "the response was not valid JSON"
          : describeZod(parsed.error));
      await record(data, {
        model: current,
        attempt,
        status: "invalid_output",
        output: typeof res.output === "string" ? null : (res.output as object),
        error: problem.slice(0, 1000),
        ...usage,
      });
      if (repairHint) throw new InvalidOutput(problem);
      repairHint = `Your previous response was rejected: ${problem}. Return the corrected JSON only, following the schema exactly.`;
    }
  }

  async function matchAndWrite(
    x: Executor,
    data: ExtractJobData,
    n: NormalizedBill,
    shas: string[],
    extractionId: string,
  ): Promise<void> {
    const { billId, businessId } = data;
    const flags = new Set(n.flags);

    const suggestedVendorId = await matchVendor(x, businessId, {
      gstin: n.gstin,
      name: n.vendorName,
    });
    // The business's stock items, loaded once for the whole bill.
    const stockItems = await x
      .select({
        id: masterProducts.id,
        displayName: masterProducts.displayName,
        nameNorm: masterProducts.nameNorm,
      })
      .from(masterProducts)
      .where(eq(masterProducts.businessId, businessId));
    const lineRows = [];
    for (const [position, l] of n.lines.entries()) {
      const suggestedProductId = suggestedVendorId
        ? await matchProduct(x, businessId, suggestedVendorId, l.description)
        : null;
      // A vendor product that already has a stock item decides; otherwise guess by name, flagged.
      let vendorMasterId: string | null = null;
      if (suggestedProductId) {
        const [prod] = await x
          .select({ masterProductId: products.masterProductId })
          .from(products)
          .where(eq(products.id, suggestedProductId))
          .limit(1);
        vendorMasterId = prod?.masterProductId ?? null;
      }
      const autoLinked =
        vendorMasterId || stockItems.length === 0
          ? null
          : matchMasterProduct(l.description, stockItems);
      lineRows.push({
        id: newId(),
        businessId,
        billId,
        position,
        descriptionRaw: l.description,
        suggestedProductId,
        masterProductId: autoLinked?.id ?? null,
        hsnSac: l.hsnSac,
        quantity: l.quantity,
        unit: l.unit,
        rate: l.rate,
        discount: l.discount,
        printedAmount: l.printedAmount,
        taxableValue: l.taxableValue,
        gstRate: l.gstRate,
        cgst: l.cgst,
        sgst: l.sgst,
        igst: l.igst,
        cess: l.cess,
        amount: l.amount,
        flags: autoLinked ? [...l.flags, "stock_auto_linked"] : l.flags,
      });
    }

    // Duplicates: the same file bytes, or the same counterparty + invoice number in the same financial year.
    let duplicateOfId: string | null = null;
    if (shas.length > 0) {
      const shaList = sql.join(
        shas.map((s) => sql`${s}`),
        sql`, `,
      );
      const [dup] = await x
        .select({ id: bills.id })
        .from(bills)
        .where(
          and(
            eq(bills.businessId, businessId),
            ne(bills.id, billId),
            ne(bills.status, "discarded"),
            sql`${bills.fileSha256s} && ARRAY[${shaList}]::text[]`,
          ),
        )
        .orderBy(asc(bills.id))
        .limit(1);
      if (dup) {
        duplicateOfId = dup.id;
        flags.add("duplicate_file");
      }
    }
    if (n.invoiceNumberNorm && n.billDate) {
      const party = [
        suggestedVendorId ? eq(bills.vendorId, suggestedVendorId) : undefined,
        suggestedVendorId ? eq(bills.suggestedVendorId, suggestedVendorId) : undefined,
        n.gstin ? eq(bills.counterpartyGstin, n.gstin) : undefined,
      ].filter((p) => p !== undefined);
      if (party.length > 0) {
        const { from, to } = fyRange(fyOf(n.billDate));
        const [dup] = await x
          .select({ id: bills.id })
          .from(bills)
          .where(
            and(
              eq(bills.businessId, businessId),
              ne(bills.id, billId),
              ne(bills.status, "discarded"),
              eq(bills.invoiceNumberNorm, n.invoiceNumberNorm),
              sql`${bills.billDate} between ${from} and ${to}`,
              or(...party),
            ),
          )
          .orderBy(asc(bills.id))
          .limit(1);
        if (dup) {
          duplicateOfId ??= dup.id;
          flags.add("duplicate_invoice");
        }
      }
    }

    // Guarded on status: a discard (or another run) that got here first wins and this write is a no-op.
    const [updated] = await x
      .update(bills)
      .set({
        status: "needs_review",
        vendorNameRaw: n.vendorName,
        counterpartyGstin: n.gstin,
        suggestedVendorId,
        invoiceNumber: n.invoiceNumber,
        invoiceNumberNorm: n.invoiceNumberNorm,
        billDate: n.billDate,
        placeOfSupply: n.placeOfSupply,
        isReverseCharge: n.isReverseCharge,
        subtotal: n.subtotal,
        discountTotal: n.discountTotal,
        cgstTotal: n.cgstTotal,
        sgstTotal: n.sgstTotal,
        igstTotal: n.igstTotal,
        cessTotal: n.cessTotal,
        otherCharges: n.otherCharges,
        charges: n.charges,
        roundOff: n.roundOff,
        taxesIncluded: n.taxesIncluded,
        grandTotal: n.grandTotal,
        flags: [...flags],
        duplicateOfId,
        failureReason: null,
        latestExtractionId: extractionId,
        updatedAt: new Date(),
      })
      .where(and(eq(bills.id, billId), eq(bills.status, "processing")))
      .returning({ id: bills.id });
    if (!updated) return;
    await x.delete(billLineItems).where(eq(billLineItems.billId, billId));
    if (lineRows.length > 0) await x.insert(billLineItems).values(lineRows);
  }

  async function run(data: ExtractJobData, billType: "purchase" | "sale"): Promise<void> {
    if (!ai) {
      log.warn({ billId: data.billId }, "extraction skipped: GEMINI_API_KEY is not configured");
      await fail(data.billId, "ai_error");
      return;
    }
    const files = await database.db
      .select()
      .from(billFiles)
      .where(and(eq(billFiles.billId, data.billId), eq(billFiles.businessId, data.businessId)))
      .orderBy(asc(billFiles.position));
    if (files.length === 0) {
      await fail(data.billId, "ai_error");
      return;
    }
    if (files.reduce((n, f) => n + f.bytes, 0) > MAX_INLINE_BYTES) {
      await fail(data.billId, "too_large");
      return;
    }
    const [biz] = await database.db
      .select({ name: businesses.name, gstin: businesses.gstin })
      .from(businesses)
      .where(eq(businesses.id, data.businessId))
      .limit(1);
    const loaded = [];
    for (const f of files) {
      const body = await storage.getObject(f.storageKey);
      loaded.push({
        mime: f.mimeType,
        bytes: new Uint8Array(await new Response(body).arrayBuffer()),
      });
    }

    let result: Awaited<ReturnType<typeof callAi>>;
    try {
      result = await callAi(data, {
        files: loaded,
        billType,
        ownName: biz?.name ?? "",
        ...(biz?.gstin && { ownGstin: biz.gstin }),
      });
    } catch (err) {
      log.warn({ billId: data.billId, err }, "extraction gave up");
      await fail(data.billId, "ai_error");
      return;
    }
    if (!result.output.is_bill) {
      await fail(data.billId, "not_a_bill", result.extractionId);
      return;
    }
    const normalized = normalizeExtraction(result.output);
    await database.tx(({ db }) =>
      matchAndWrite(
        db,
        data,
        normalized,
        files.map((f) => f.sha256),
        result.extractionId,
      ),
    );
  }

  return async function handle(job: Job<ExtractJobData>): Promise<void> {
    const data = job.data;
    // queued|processing -> processing is the only way in; anything else (discarded, done, failed) is a no-op,
    // so a re-delivered job or a discarded bill does nothing.
    const [claimed] = await database.db
      .update(bills)
      .set({ status: "processing", updatedAt: new Date() })
      .where(
        and(
          eq(bills.id, data.billId),
          eq(bills.businessId, data.businessId),
          inArray(bills.status, ["queued", "processing"]),
        ),
      )
      .returning({ type: bills.type });
    if (!claimed) return;
    try {
      await run(data, claimed.type);
    } catch (err) {
      log.error({ billId: data.billId, err }, "extraction crashed");
      // If even this write fails the error propagates and the queue retries the job (status stays claimable).
      await fail(data.billId, "ai_error");
    }
  };
}
