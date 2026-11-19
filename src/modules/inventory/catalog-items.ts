import { eq } from "drizzle-orm";
import type { Database, Executor } from "../../platform/db/client";
import { notFound } from "../../platform/errors";
import { TRADE_CATALOGS } from "../../seed/trade-seeder";
import { normalizeProductName } from "../catalog/normalize";
import { masterProducts } from "./inventory.schema";
import { createMasterProduct, type MasterProductView } from "./inventory.service";

export const BULK_MAX_ITEMS = 500;

export type CatalogItemView = { name: string; category: string; unit: string; in_list: boolean };

/** Items of one starter list, optionally one category, flagged when the business already has them. */
export async function listCatalogItems(
  db: Executor,
  businessId: string,
  catalogId: string,
  category?: string | undefined,
): Promise<CatalogItemView[]> {
  const catalog = TRADE_CATALOGS[catalogId.toLowerCase()];
  if (!catalog) throw notFound("trade_catalog");
  const wanted = category?.trim().toLowerCase();
  const existing = await db
    .select({ nameNorm: masterProducts.nameNorm })
    .from(masterProducts)
    .where(eq(masterProducts.businessId, businessId));
  const have = new Set(existing.map((p) => p.nameNorm));
  return catalog
    .filter((i) => !wanted || i.category.toLowerCase() === wanted)
    .map((i) => ({
      name: i.name,
      category: i.category,
      unit: i.unit,
      in_list: have.has(normalizeProductName(i.name)),
    }));
}

export type BulkItemInput = {
  display_name: string;
  category?: string | null | undefined;
  standard_unit?: string | undefined;
};

/** Creates many master products in one transaction, skipping names the business already has. */
export async function bulkCreateMasterProducts(
  database: Database,
  businessId: string,
  items: BulkItemInput[],
): Promise<{ created: number; skipped: number; items: MasterProductView[] }> {
  return database.db.transaction(async (tx) => {
    const existing = await tx
      .select({ nameNorm: masterProducts.nameNorm })
      .from(masterProducts)
      .where(eq(masterProducts.businessId, businessId));
    const seen = new Set(existing.map((p) => p.nameNorm));
    const made: MasterProductView[] = [];
    let skipped = 0;
    for (const item of items) {
      const norm = normalizeProductName(item.display_name);
      if (!norm || seen.has(norm)) {
        skipped++;
        continue;
      }
      seen.add(norm);
      made.push(
        await createMasterProduct(tx, {
          businessId,
          displayName: item.display_name,
          category: item.category,
          standardUnit: item.standard_unit ?? "kg",
        }),
      );
    }
    return { created: made.length, skipped, items: made };
  });
}
