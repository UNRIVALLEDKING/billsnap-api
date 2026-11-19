import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../../platform/db/client";
import { AppError, badRequest, notFound } from "../../platform/errors";
import { isValidGstin } from "../../shared/gst";
import { newId } from "../../shared/ids";
import { dec, fmt } from "../../shared/money";
import { billLineItems, bills } from "../bills/bills.schema";
import { masterProducts } from "../inventory/inventory.schema";
import { replayItems } from "../inventory/replay";
import { normalizeUnit, type PackSpec } from "../inventory/units";
import { mergeEvents, productAliases, products, vendorAliases, vendors } from "./catalog.schema";
import { normalizeProductName, normalizeVendorName } from "./normalize";

export type VendorView = { id: string; name: string; gstin: string | null; aliases: string[] };
export type ProductView = {
  id: string;
  vendor_id: string;
  name: string;
  unit: string | null;
  master_product_id: string | null;
  aliases: string[];
  /** This party's pack size (docs/CUSTOMER_SPECS_PLAN.md B7): 1 pack_unit = pack_qty pack_qty_unit. */
  pack_unit: string | null;
  pack_qty: string | null;
  pack_qty_unit: string | null;
};

/** Serialises catalog writes per business (resolve on confirm, merges). Released at commit. */
export async function lockCatalog(x: Executor, businessId: string): Promise<void> {
  await x.execute(sql`select pg_advisory_xact_lock(hashtextextended(${businessId}, 0))`);
}

// ---- matching ----------------------------------------------------------------------------------------

/** GSTIN first (live vendor), then exact alias. Returns a live vendor id or null. */
export async function matchVendor(
  x: Executor,
  businessId: string,
  q: { gstin?: string | null; name: string },
): Promise<string | null> {
  if (q.gstin && isValidGstin(q.gstin)) {
    const [v] = await x
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          eq(vendors.businessId, businessId),
          eq(vendors.gstin, q.gstin),
          isNull(vendors.mergedIntoId),
        ),
      )
      .limit(1);
    if (v) return v.id;
  }
  const norm = normalizeVendorName(q.name);
  if (norm === "") return null;
  const [a] = await x
    .select({ id: vendors.id })
    .from(vendorAliases)
    .innerJoin(vendors, eq(vendors.id, vendorAliases.vendorId))
    .where(
      and(
        eq(vendorAliases.businessId, businessId),
        eq(vendorAliases.aliasNorm, norm),
        isNull(vendors.mergedIntoId),
      ),
    )
    .limit(1);
  return a?.id ?? null;
}

/** Exact alias within the vendor. Returns a live product id or null. */
export async function matchProduct(
  x: Executor,
  businessId: string,
  vendorId: string,
  description: string,
): Promise<string | null> {
  const norm = normalizeProductName(description);
  if (norm === "") return null;
  const [a] = await x
    .select({ id: products.id })
    .from(productAliases)
    .innerJoin(products, eq(products.id, productAliases.productId))
    .where(
      and(
        eq(productAliases.businessId, businessId),
        eq(productAliases.vendorId, vendorId),
        eq(productAliases.aliasNorm, norm),
        isNull(products.mergedIntoId),
      ),
    )
    .limit(1);
  return a?.id ?? null;
}

// ---- resolve on confirm (caller holds lockCatalog) ---------------------------------------------------

async function addVendorAlias(x: Executor, businessId: string, vendorId: string, raw: string) {
  const norm = normalizeVendorName(raw);
  if (norm === "") return;
  await x
    .insert(vendorAliases)
    .values({ id: newId(), businessId, vendorId, aliasRaw: raw, aliasNorm: norm })
    .onConflictDoNothing({ target: [vendorAliases.businessId, vendorAliases.aliasNorm] });
}

async function addProductAlias(
  x: Executor,
  businessId: string,
  vendorId: string,
  productId: string,
  raw: string,
) {
  const norm = normalizeProductName(raw);
  if (norm === "") return;
  await x
    .insert(productAliases)
    .values({ id: newId(), businessId, vendorId, productId, aliasRaw: raw, aliasNorm: norm })
    .onConflictDoNothing({ target: [productAliases.vendorId, productAliases.aliasNorm] });
}

/**
 * The user's choice is final: an existing live vendor (the spelling is saved as an alias), else an exact
 * GSTIN/alias match, else a new vendor. New vendors exist only because a bill was confirmed.
 */
export async function resolveVendor(
  x: Executor,
  businessId: string,
  input: { vendorId: string | null; name: string; gstin: string | null },
): Promise<{ id: string; created: boolean }> {
  const name = input.name.trim();
  let id: string | null = null;
  if (input.vendorId) {
    const [v] = await x
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          eq(vendors.id, input.vendorId),
          eq(vendors.businessId, businessId),
          isNull(vendors.mergedIntoId),
        ),
      )
      .limit(1);
    id = v?.id ?? null;
  }
  const gstin = input.gstin && isValidGstin(input.gstin) ? input.gstin : null;
  id ??= await matchVendor(x, businessId, { gstin, name });
  const created = id === null;
  if (id === null) {
    id = newId();
    await x.insert(vendors).values({
      id,
      businessId,
      displayName: name,
      nameNorm: normalizeVendorName(name) || name.toLowerCase(),
      gstin,
    });
  } else if (gstin) {
    // Learn the GSTIN for a vendor that has none, unless another live vendor already owns it.
    const [held] = await x
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          eq(vendors.businessId, businessId),
          eq(vendors.gstin, gstin),
          isNull(vendors.mergedIntoId),
        ),
      )
      .limit(1);
    if (!held) {
      await x
        .update(vendors)
        .set({ gstin, updatedAt: new Date() })
        .where(and(eq(vendors.id, id), isNull(vendors.gstin)));
    }
  }
  await addVendorAlias(x, businessId, id, name);
  return { id, created };
}

/** Same rules for a product, scoped to its vendor. A product id from another vendor is ignored. */
export async function resolveProduct(
  x: Executor,
  businessId: string,
  vendorId: string,
  input: {
    productId: string | null;
    description: string;
    unit: string;
    hsnSac: string | null;
    masterProductId?: string | null | undefined;
  },
): Promise<{ id: string; masterProductId: string | null; created: boolean }> {
  const description = input.description.trim();
  let id: string | null = null;
  let masterProductId: string | null = input.masterProductId ?? null;

  if (input.productId) {
    const [p] = await x
      .select({ id: products.id, masterProductId: products.masterProductId })
      .from(products)
      .where(
        and(
          eq(products.id, input.productId),
          eq(products.businessId, businessId),
          eq(products.vendorId, vendorId),
          isNull(products.mergedIntoId),
        ),
      )
      .limit(1);
    if (p) {
      id = p.id;
      masterProductId ??= p.masterProductId;
    }
  }

  if (id === null) {
    id = await matchProduct(x, businessId, vendorId, description);
    if (id) {
      const [existing] = await x
        .select({ masterProductId: products.masterProductId })
        .from(products)
        .where(eq(products.id, id))
        .limit(1);
      masterProductId ??= existing?.masterProductId ?? null;
    }
  }

  const created = id === null;
  if (id === null) {
    id = newId();
    await x.insert(products).values({
      id,
      businessId,
      vendorId,
      displayName: description,
      nameNorm: normalizeProductName(description) || description.toLowerCase(),
      hsnSac: input.hsnSac,
      unit: input.unit,
      masterProductId,
    });
  } else if (input.masterProductId && masterProductId !== input.masterProductId) {
    await x
      .update(products)
      .set({ masterProductId: input.masterProductId, updatedAt: new Date() })
      .where(eq(products.id, id));
    masterProductId = input.masterProductId;
  }

  await addProductAlias(x, businessId, vendorId, id, description);
  return { id, masterProductId, created };
}

export async function mapProductToMaster(
  x: Executor,
  businessId: string,
  productId: string,
  masterProductId: string | null,
): Promise<void> {
  if (masterProductId) {
    const [mp] = await x
      .select({ id: masterProducts.id })
      .from(masterProducts)
      .where(and(eq(masterProducts.id, masterProductId), eq(masterProducts.businessId, businessId)))
      .limit(1);
    if (!mp) throw notFound("master_product");
  }
  const [updated] = await x
    .update(products)
    .set({ masterProductId, updatedAt: new Date() })
    .where(and(eq(products.id, productId), eq(products.businessId, businessId)))
    .returning();
  if (!updated) throw notFound("product");
}

// ---- reads -------------------------------------------------------------------------------------------

export async function listVendors(x: Executor, businessId: string): Promise<VendorView[]> {
  const rows = await x
    .select()
    .from(vendors)
    .where(and(eq(vendors.businessId, businessId), isNull(vendors.mergedIntoId)))
    .orderBy(asc(vendors.nameNorm), asc(vendors.id));
  const aliases = await x
    .select({
      vendorId: vendorAliases.vendorId,
      raw: vendorAliases.aliasRaw,
      norm: vendorAliases.aliasNorm,
    })
    .from(vendorAliases)
    .where(eq(vendorAliases.businessId, businessId))
    .orderBy(asc(vendorAliases.createdAt), asc(vendorAliases.id));
  return rows.map((v) => ({
    id: v.id,
    name: v.displayName,
    gstin: v.gstin,
    aliases: [
      ...new Set(
        aliases
          .filter((a) => a.vendorId === v.id && a.norm !== v.nameNorm && a.raw !== v.displayName)
          .map((a) => a.raw),
      ),
    ],
  }));
}

export async function listProducts(x: Executor, businessId: string): Promise<ProductView[]> {
  const rows = await x
    .select()
    .from(products)
    .where(and(eq(products.businessId, businessId), isNull(products.mergedIntoId)))
    .orderBy(asc(products.nameNorm), asc(products.id));
  const aliases = await x
    .select({
      productId: productAliases.productId,
      raw: productAliases.aliasRaw,
      norm: productAliases.aliasNorm,
    })
    .from(productAliases)
    .where(eq(productAliases.businessId, businessId))
    .orderBy(asc(productAliases.createdAt), asc(productAliases.id));
  return rows.map((p) => ({
    id: p.id,
    vendor_id: p.vendorId,
    name: p.displayName,
    unit: p.unit,
    master_product_id: p.masterProductId ?? null,
    aliases: [
      ...new Set(
        aliases
          .filter((a) => a.productId === p.id && a.norm !== p.nameNorm && a.raw !== p.displayName)
          .map((a) => a.raw),
      ),
    ],
    ...specView(p),
  }));
}

// ---- pack specs per party (docs/CUSTOMER_SPECS_PLAN.md B7) -------------------------------------------

type SpecColumns = {
  packUnit: string | null;
  packQty: string | null;
  packQtyUnit: string | null;
};

/** The spec fields of a product view; all null unless all three are set. */
export function specView(p: SpecColumns): {
  pack_unit: string | null;
  pack_qty: string | null;
  pack_qty_unit: string | null;
} {
  const spec = packSpecOf(p);
  return spec
    ? {
        pack_unit: spec.packUnit,
        pack_qty: dec(spec.packQty).toFixed(),
        pack_qty_unit: spec.packQtyUnit,
      }
    : { pack_unit: null, pack_qty: null, pack_qty_unit: null };
}

export function packSpecOf(p: SpecColumns): PackSpec | null {
  return p.packUnit && p.packQty && p.packQtyUnit
    ? { packUnit: p.packUnit, packQty: p.packQty, packQtyUnit: p.packQtyUnit }
    : null;
}

/** Pack specs of `ids` (products that have one), by product id. */
export async function loadPackSpecs(
  x: Executor,
  businessId: string,
  ids: Iterable<string>,
): Promise<Map<string, PackSpec>> {
  const list = [...new Set(ids)];
  const out = new Map<string, PackSpec>();
  if (list.length === 0) return out;
  const rows = await x
    .select({
      id: products.id,
      packUnit: products.packUnit,
      packQty: products.packQty,
      packQtyUnit: products.packQtyUnit,
    })
    .from(products)
    .where(and(eq(products.businessId, businessId), inArray(products.id, list)));
  for (const r of rows) {
    const spec = packSpecOf(r);
    if (spec) out.set(r.id, spec);
  }
  return out;
}

/**
 * Sets (or with null, clears) a party product's pack spec. Bills already confirmed keep the factor they
 * were confirmed with; the product's stock item is replayed so lines confirmed before factors were
 * stored follow the new spec.
 */
export async function setProductSpec(
  x: Executor,
  businessId: string,
  productId: string,
  spec: PackSpec | null,
): Promise<ProductView> {
  await lockCatalog(x, businessId);
  const values = spec
    ? {
        packUnit: normalizeUnit(spec.packUnit),
        packQty: fmt(spec.packQty, 6),
        packQtyUnit: normalizeUnit(spec.packQtyUnit),
      }
    : { packUnit: null, packQty: null, packQtyUnit: null };
  if (values.packUnit !== null && values.packUnit === values.packQtyUnit) {
    throw invalid("pack_unit and pack_qty_unit must differ");
  }
  const [updated] = await x
    .update(products)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(products.id, productId),
        eq(products.businessId, businessId),
        isNull(products.mergedIntoId),
      ),
    )
    .returning({ masterProductId: products.masterProductId });
  if (!updated) throw notFound("Product not found");
  if (updated.masterProductId) await replayItems(x, businessId, [updated.masterProductId]);
  const view = (await listProducts(x, businessId)).find((p) => p.id === productId);
  if (!view) throw notFound("Product not found");
  return view;
}

// ---- merges ------------------------------------------------------------------------------------------

export type MergeInput = { keepId: string; mergeIds: string[]; displayName: string };

const invalid = (message: string) => new AppError("validation_failed", 422, message);

function mergeIdsOf(input: MergeInput): string[] {
  const ids = [...new Set(input.mergeIds)].filter((id) => id !== input.keepId);
  if (ids.length === 0) throw invalid("merge_ids must contain at least one id other than keep_id");
  return ids;
}

/** Merges vendors into `keepId`. Confirmed amounts never change; only ids are repointed. */
export async function mergeVendors(
  x: Executor,
  businessId: string,
  userId: string,
  input: MergeInput,
): Promise<VendorView> {
  const ids = mergeIdsOf(input);
  const keepId = input.keepId;
  const displayName = input.displayName.trim();
  await lockCatalog(x, businessId);

  const found = await x
    .select()
    .from(vendors)
    .where(
      and(
        eq(vendors.businessId, businessId),
        inArray(vendors.id, [keepId, ...ids]),
        isNull(vendors.mergedIntoId),
      ),
    );
  if (found.length !== ids.length + 1) throw notFound("Vendor not found");
  const keep = found.find((v) => v.id === keepId);
  if (!keep) throw notFound("Vendor not found");
  const adoptedGstin = keep.gstin ?? found.find((v) => v.id !== keepId && v.gstin)?.gstin ?? null;
  const now = new Date();

  await x
    .update(vendors)
    .set({ mergedIntoId: keepId, updatedAt: now })
    .where(inArray(vendors.id, ids));
  await x
    .update(vendorAliases)
    .set({ vendorId: keepId })
    .where(inArray(vendorAliases.vendorId, ids));
  await x
    .update(bills)
    .set({ vendorId: keepId })
    .where(and(eq(bills.businessId, businessId), inArray(bills.vendorId, ids)));
  await x
    .update(bills)
    .set({ suggestedVendorId: keepId })
    .where(and(eq(bills.businessId, businessId), inArray(bills.suggestedVendorId, ids)));
  await x
    .update(billLineItems)
    .set({ vendorId: keepId })
    .where(and(eq(billLineItems.businessId, businessId), inArray(billLineItems.vendorId, ids)));

  // Products: same normalized name collapses into one survivor (preferring the kept vendor's), the rest move.
  const allVendorIds = [keepId, ...ids];
  const live = await x
    .select()
    .from(products)
    .where(
      and(
        eq(products.businessId, businessId),
        inArray(products.vendorId, allVendorIds),
        isNull(products.mergedIntoId),
      ),
    )
    .orderBy(asc(products.createdAt), asc(products.id));
  const survivorByName = new Map<string, string>();
  for (const p of live.filter((p) => p.vendorId === keepId)) {
    if (!survivorByName.has(p.nameNorm)) survivorByName.set(p.nameNorm, p.id);
  }
  for (const p of live) if (!survivorByName.has(p.nameNorm)) survivorByName.set(p.nameNorm, p.id);
  const remap: Record<string, string> = {};
  for (const p of live) {
    const survivor = survivorByName.get(p.nameNorm) as string;
    if (survivor !== p.id) remap[p.id] = survivor;
  }

  // Aliases: the kept vendor's win a collision; later duplicates are dropped.
  const allAliases = await x
    .select()
    .from(productAliases)
    .where(
      and(
        eq(productAliases.businessId, businessId),
        inArray(productAliases.vendorId, allVendorIds),
      ),
    )
    .orderBy(asc(productAliases.createdAt), asc(productAliases.id));
  const ordered = [
    ...allAliases.filter((a) => a.vendorId === keepId),
    ...allAliases.filter((a) => a.vendorId !== keepId),
  ];
  const seen = new Set<string>();
  const drop: string[] = [];
  for (const a of ordered) {
    if (seen.has(a.aliasNorm)) {
      drop.push(a.id);
      continue;
    }
    seen.add(a.aliasNorm);
  }
  if (drop.length > 0) await x.delete(productAliases).where(inArray(productAliases.id, drop));
  const dropped = new Set(drop);
  for (const a of ordered) {
    if (dropped.has(a.id)) continue;
    const target = remap[a.productId] ?? a.productId;
    if (a.vendorId !== keepId || target !== a.productId) {
      await x
        .update(productAliases)
        .set({ vendorId: keepId, productId: target })
        .where(eq(productAliases.id, a.id));
    }
  }

  for (const [loser, survivor] of Object.entries(remap)) {
    await x
      .update(products)
      .set({ mergedIntoId: survivor, vendorId: keepId, updatedAt: now })
      .where(eq(products.id, loser));
    await x
      .update(billLineItems)
      .set({ productId: survivor })
      .where(and(eq(billLineItems.businessId, businessId), eq(billLineItems.productId, loser)));
    await x
      .update(billLineItems)
      .set({ suggestedProductId: survivor })
      .where(
        and(eq(billLineItems.businessId, businessId), eq(billLineItems.suggestedProductId, loser)),
      );
  }
  await x
    .update(products)
    .set({ vendorId: keepId, updatedAt: now })
    .where(and(inArray(products.vendorId, ids), isNull(products.mergedIntoId)));

  await x
    .update(vendors)
    .set({
      displayName,
      nameNorm: normalizeVendorName(displayName) || displayName.toLowerCase(),
      gstin: adoptedGstin,
      updatedAt: now,
    })
    .where(eq(vendors.id, keepId));
  await addVendorAlias(x, businessId, keepId, displayName);

  await x.insert(mergeEvents).values({
    id: newId(),
    businessId,
    entity: "vendor",
    survivorId: keepId,
    mergedIds: ids,
    performedBy: userId,
    details: {
      previous_names: found.map((v) => ({ id: v.id, name: v.displayName })),
      product_remaps: remap,
      dropped_product_aliases: drop.length,
    },
  });
  const view = (await listVendors(x, businessId)).find((v) => v.id === keepId);
  if (!view) throw notFound("Vendor not found");
  return view;
}

/** Merges products of one vendor into `keepId`. */
export async function mergeProducts(
  x: Executor,
  businessId: string,
  userId: string,
  input: MergeInput,
): Promise<ProductView> {
  const ids = mergeIdsOf(input);
  const keepId = input.keepId;
  const displayName = input.displayName.trim();
  await lockCatalog(x, businessId);

  const found = await x
    .select()
    .from(products)
    .where(
      and(
        eq(products.businessId, businessId),
        inArray(products.id, [keepId, ...ids]),
        isNull(products.mergedIntoId),
      ),
    );
  if (found.length !== ids.length + 1) throw notFound("Product not found");
  const keep = found.find((p) => p.id === keepId);
  if (!keep) throw notFound("Product not found");
  if (found.some((p) => p.vendorId !== keep.vendorId)) {
    throw invalid("Products can only be merged within one vendor");
  }

  await x
    .update(products)
    .set({ mergedIntoId: keepId, updatedAt: new Date() })
    .where(inArray(products.id, ids));
  // The alias key is (vendor, alias_norm), so repointing within one vendor cannot collide.
  await x
    .update(productAliases)
    .set({ productId: keepId })
    .where(inArray(productAliases.productId, ids));
  await x
    .update(billLineItems)
    .set({ productId: keepId })
    .where(and(eq(billLineItems.businessId, businessId), inArray(billLineItems.productId, ids)));
  await x
    .update(billLineItems)
    .set({ suggestedProductId: keepId })
    .where(
      and(eq(billLineItems.businessId, businessId), inArray(billLineItems.suggestedProductId, ids)),
    );
  await x
    .update(products)
    .set({
      displayName,
      nameNorm: normalizeProductName(displayName) || displayName.toLowerCase(),
      updatedAt: new Date(),
    })
    .where(eq(products.id, keepId));
  await addProductAlias(x, businessId, keep.vendorId, keepId, displayName);

  await x.insert(mergeEvents).values({
    id: newId(),
    businessId,
    entity: "product",
    survivorId: keepId,
    mergedIds: ids,
    performedBy: userId,
    details: { previous_names: found.map((p) => ({ id: p.id, name: p.displayName })) },
  });
  const view = (await listProducts(x, businessId)).find((p) => p.id === keepId);
  if (!view) throw notFound("Product not found");
  return view;
}

/**
 * Removes an alias for a vendor.
 * Ensures the surviving vendor display name itself cannot be removed.
 */
export async function removeVendorAlias(
  x: Executor,
  businessId: string,
  vendorId: string,
  alias: string,
): Promise<void> {
  const trimmed = alias.trim();
  if (!trimmed) {
    throw badRequest("Alias cannot be empty");
  }

  const [vendor] = await x
    .select({ displayName: vendors.displayName, nameNorm: vendors.nameNorm })
    .from(vendors)
    .where(
      and(
        eq(vendors.id, vendorId),
        eq(vendors.businessId, businessId),
        isNull(vendors.mergedIntoId),
      ),
    )
    .limit(1);

  if (!vendor) {
    throw notFound("Vendor not found");
  }

  const norm = normalizeVendorName(trimmed);
  if (
    trimmed.toLowerCase() === vendor.displayName.trim().toLowerCase() ||
    (norm !== "" && norm === vendor.nameNorm)
  ) {
    throw badRequest("Cannot remove surviving vendor display name");
  }

  const deleted = await x
    .delete(vendorAliases)
    .where(
      and(
        eq(vendorAliases.businessId, businessId),
        eq(vendorAliases.vendorId, vendorId),
        or(
          eq(vendorAliases.aliasRaw, trimmed),
          eq(vendorAliases.aliasNorm, trimmed),
          norm !== "" ? eq(vendorAliases.aliasNorm, norm) : sql`false`,
        ),
      ),
    )
    .returning();

  if (deleted.length === 0) {
    throw notFound("Alias not found");
  }
}

/**
 * Removes an alias for a product.
 * Ensures the surviving product display name itself cannot be removed.
 */
export async function removeProductAlias(
  x: Executor,
  businessId: string,
  productId: string,
  alias: string,
): Promise<void> {
  const trimmed = alias.trim();
  if (!trimmed) {
    throw badRequest("Alias cannot be empty");
  }

  const [product] = await x
    .select({ displayName: products.displayName, nameNorm: products.nameNorm })
    .from(products)
    .where(
      and(
        eq(products.id, productId),
        eq(products.businessId, businessId),
        isNull(products.mergedIntoId),
      ),
    )
    .limit(1);

  if (!product) {
    throw notFound("Product not found");
  }

  const norm = normalizeProductName(trimmed);
  if (
    trimmed.toLowerCase() === product.displayName.trim().toLowerCase() ||
    (norm !== "" && norm === product.nameNorm)
  ) {
    throw badRequest("Cannot remove surviving product display name");
  }

  const deleted = await x
    .delete(productAliases)
    .where(
      and(
        eq(productAliases.businessId, businessId),
        eq(productAliases.productId, productId),
        or(
          eq(productAliases.aliasRaw, trimmed),
          eq(productAliases.aliasNorm, trimmed),
          norm !== "" ? eq(productAliases.aliasNorm, norm) : sql`false`,
        ),
      ),
    )
    .returning();

  if (deleted.length === 0) {
    throw notFound("Alias not found");
  }
}
