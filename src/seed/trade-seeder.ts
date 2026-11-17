import { eq } from "drizzle-orm";
import { businesses } from "../modules/businesses/businesses.schema";
import { normalizeProductName } from "../modules/catalog/normalize";
import { feeDefinitions, masterProducts } from "../modules/inventory/inventory.schema";
import { createMasterProduct } from "../modules/inventory/inventory.service";
import type { Database } from "../platform/db/client";
import { newId } from "../shared/ids";
import { PRODUCE } from "./produce";
import { ELECTRONICS } from "./trades/electronics";
import { STANDARD_FEES } from "./trades/fees";
import { GROCERY } from "./trades/grocery";
import { SKINCARE } from "./trades/skincare";
import type { CatalogItem } from "./trades/types";

/** PRODUCE categories that are fruit; every other PRODUCE category is a vegetable. */
const FRUIT_CATEGORIES = new Set([
  "Apples & Pears",
  "Mangoes",
  "Bananas",
  "Citrus",
  "Grapes & Berries",
  "Melons",
  "Stone Fruits",
  "Tropical Fruits",
  "Coconuts",
  "Seasonal Indian Fruits",
  "Exotic Fruits",
  "Cut Fruits",
]);

export const TRADE_CATALOGS: Record<string, CatalogItem[]> = {
  vegetables: PRODUCE.filter((p) => !FRUIT_CATEGORIES.has(p.category)),
  fruits: PRODUCE.filter((p) => FRUIT_CATEGORIES.has(p.category)),
  electronics: ELECTRONICS,
  skincare: SKINCARE,
  grocery: GROCERY,
};

const TRADE_NAMES: Record<string, string> = {
  vegetables: "Vegetables",
  fruits: "Fruits",
  grocery: "Grocery",
  electronics: "Electronics",
  skincare: "Skincare",
};

const TRADE_ORDER = ["vegetables", "fruits", "grocery", "electronics", "skincare"];

export type TradeCatalogSummary = {
  id: string;
  name: string;
  item_count: number;
  categories: Array<{ name: string; item_count: number }>;
};

/** The starter lists a business can pick from, with item counts per category. */
export function listTradeCatalogs(): TradeCatalogSummary[] {
  return TRADE_ORDER.map((id) => {
    const items = TRADE_CATALOGS[id] ?? [];
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
    return {
      id,
      name: TRADE_NAMES[id] ?? id,
      item_count: items.length,
      categories: [...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, item_count]) => ({ name, item_count })),
    };
  });
}

/**
 * Adds the standard fees and the chosen starter lists to a business, skipping what it already has.
 * `categories` limits the import to those category names. The business's trade type becomes the
 * first valid trade picked and its configured categories the union of what was imported.
 * Unknown trade types are ignored; if none is known, vegetables is used.
 */
export async function importTradeCatalogs(
  db: Database["db"],
  businessId: string,
  tradeTypes: string[],
  categoryFilter?: string[] | undefined,
): Promise<{
  productsCreated: number;
  feesCreated: number;
  categories: string[];
  totalProducts: number;
}> {
  let trades = Array.from(
    new Set(tradeTypes.map((t) => t.toLowerCase().trim()).filter((t) => t in TRADE_CATALOGS)),
  );
  if (trades.length === 0) trades = ["vegetables"];
  const wanted = categoryFilter?.length
    ? new Set(categoryFilter.map((c) => c.toLowerCase().trim()))
    : null;
  const items = trades
    .flatMap((t) => TRADE_CATALOGS[t] ?? [])
    .filter((i) => !wanted || wanted.has(i.category.toLowerCase()));
  const categories = Array.from(new Set(items.map((i) => i.category))).sort();

  // 1. Seed Fee Definitions
  const existingFees = await db
    .select({ name: feeDefinitions.name })
    .from(feeDefinitions)
    .where(eq(feeDefinitions.businessId, businessId));

  const existingFeeNames = new Set(existingFees.map((f) => f.name.toLowerCase().trim()));
  let feesCreated = 0;

  for (const fee of STANDARD_FEES) {
    if (!existingFeeNames.has(fee.name.toLowerCase().trim())) {
      await db.insert(feeDefinitions).values({
        id: newId(),
        businessId,
        name: fee.name,
        category: fee.category,
        defaultBasis: fee.defaultBasis,
        isActive: true,
      });
      existingFeeNames.add(fee.name.toLowerCase().trim());
      feesCreated++;
    }
  }

  // 2. Seed Master Products
  const existingProducts = await db
    .select({ nameNorm: masterProducts.nameNorm })
    .from(masterProducts)
    .where(eq(masterProducts.businessId, businessId));

  const existingNorms = new Set(existingProducts.map((p) => p.nameNorm));
  let productsCreated = 0;

  for (const item of items) {
    const norm = normalizeProductName(item.name);
    if (!existingNorms.has(norm)) {
      await createMasterProduct(db, {
        businessId,
        displayName: item.name,
        category: item.category,
        standardUnit: item.unit,
        reorderLevel: item.reorderLevel ?? (item.unit === "kg" ? "10" : "20"),
      });
      existingNorms.add(norm);
      productsCreated++;
    }
  }

  // 3. Remember what the business trades
  await db
    .update(businesses)
    .set({ tradeType: trades[0] as string, configuredCategories: categories })
    .where(eq(businesses.id, businessId));

  return { productsCreated, feesCreated, categories, totalProducts: existingNorms.size };
}
