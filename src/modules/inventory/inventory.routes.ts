import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env";
import { requirePermission } from "../../http/policy";
import { parseJsonBody, validationFailed } from "../../http/validate";
import type { Database } from "../../platform/db/client";
import { AppError } from "../../platform/errors";
import { importTradeCatalogs, listTradeCatalogs } from "../../seed/trade-seeder";
import { dec } from "../../shared/money";
import {
  createFeeDefinition,
  createMasterProduct,
  deleteFeeDefinition,
  deleteMasterProduct,
  getMasterProduct,
  listFeeDefinitions,
  listInStockInventory,
  listInventoryTransactions,
  listMasterCategories,
  listMasterProducts,
  listStockLots,
  recordStockIncrement,
  updateFeeDefinition,
  updateMasterProduct,
  WASTAGE_REASONS,
  wastageReport,
} from "./inventory.service";

const createMasterProductSchema = z.object({
  display_name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).optional().nullable(),
  standard_unit: z.string().trim().max(20).optional().default("kg"),
  reorder_level: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,3})?$/)
    .optional()
    .nullable(),
  initial_stock: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,3})?$/)
    .optional()
    .nullable(),
});

const updateMasterProductSchema = z.object({
  display_name: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().max(100).optional().nullable(),
  standard_unit: z.string().trim().max(20).optional(),
  reorder_level: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,3})?$/)
    .optional()
    .nullable(),
});

const adjustStockSchema = z.object({
  delta_weight: z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d{1,3})?$/, "decimal amount, positive to add, negative to reduce"),
  unit: z.string().trim().max(20).optional().default("kg"),
  note: z.string().trim().max(500).optional(),
  kind: z.enum(["wastage", "correction"]).optional().default("correction"),
  reason: z.enum(WASTAGE_REASONS).optional(),
});

const localDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const wastageQuerySchema = z.object({ from: localDay.optional(), to: localDay.optional() });

export const createFeeDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z
    .enum(["transport", "hamali", "packaging", "cess", "other"])
    .optional()
    .default("other"),
  default_basis: z.enum(["weight", "value"]).optional().default("weight"),
});

export const updateFeeDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  category: z.enum(["transport", "hamali", "packaging", "cess", "other"]).optional(),
  default_basis: z.enum(["weight", "value"]).optional(),
  is_active: z.boolean().optional(),
});

export const initializeCatalogSchema = z
  .object({
    trade_type: z.string().trim().min(1).optional(),
    trade_types: z.array(z.string().trim().min(1)).optional(),
    categories: z.array(z.string().trim().min(1)).optional(),
  })
  .refine((v) => v.trade_type || (v.trade_types && v.trade_types.length > 0), {
    message: "trade_type or trade_types is required",
  });

async function initializeCatalog(
  database: Database,
  businessId: string,
  input: z.infer<typeof initializeCatalogSchema>,
) {
  const tradeTypes = input.trade_types?.length
    ? input.trade_types
    : input.trade_type
      ? [input.trade_type]
      : [];
  const result = await importTradeCatalogs(database.db, businessId, tradeTypes, input.categories);
  return {
    success: true,
    ...result,
    products_created: result.productsCreated,
    fees_created: result.feesCreated,
    total_products: result.totalProducts,
  };
}

export function feeRoutes(database: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // List fee definitions
  app.get("/", requirePermission("fee.view"), async (c) => {
    const business = c.get("business");
    const includeInactive = c.req.query("include_inactive") === "true";
    const fees = await listFeeDefinitions(database.db, business.id, { includeInactive });
    return c.json({ fees, items: fees });
  });

  // Create fee definition
  app.post("/", requirePermission("fee.manage"), async (c) => {
    const business = c.get("business");
    const input = await parseJsonBody(createFeeDefinitionSchema, c.req.raw);
    const fee = await createFeeDefinition(database.db, business.id, {
      name: input.name,
      category: input.category,
      defaultBasis: input.default_basis,
    });
    return c.json({ fee }, 201);
  });

  // Update fee definition
  app.patch("/:id", requirePermission("fee.manage"), async (c) => {
    const business = c.get("business");
    const id = c.req.param("id");
    const input = await parseJsonBody(updateFeeDefinitionSchema, c.req.raw);
    const fee = await updateFeeDefinition(database.db, business.id, id, {
      name: input.name,
      category: input.category,
      defaultBasis: input.default_basis,
      isActive: input.is_active,
    });
    return c.json({ fee });
  });

  // Delete fee definition
  app.delete("/:id", requirePermission("fee.manage"), async (c) => {
    const business = c.get("business");
    const id = c.req.param("id");
    await deleteFeeDefinition(database.db, business.id, id);
    return c.body(null, 204);
  });

  return app;
}

export function catalogInitializationRoutes(database: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/initialize-catalog", requirePermission("fee.manage"), async (c) => {
    const business = c.get("business");
    const input = await parseJsonBody(initializeCatalogSchema, c.req.raw);
    return c.json(await initializeCatalog(database, business.id, input));
  });

  return app;
}

export function inventoryRoutes(database: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Mount nested fee routes under /fees
  app.route("/fees", feeRoutes(database));

  // Initialize trade catalog under /initialize-catalog
  app.post("/initialize-catalog", requirePermission("fee.manage"), async (c) => {
    const business = c.get("business");
    const input = await parseJsonBody(initializeCatalogSchema, c.req.raw);
    return c.json(await initializeCatalog(database, business.id, input));
  });

  // Starter lists the business can pick from
  app.get("/trade-catalogs", (c) => c.json({ items: listTradeCatalogs() }));

  // Wastage report for a range of local (IST) days, both ends inclusive
  app.get("/wastage", async (c) => {
    const business = c.get("business");
    const parsed = wastageQuerySchema.safeParse({
      from: c.req.query("from"),
      to: c.req.query("to"),
    });
    if (!parsed.success) throw validationFailed("from and to must be YYYY-MM-DD");
    return c.json(await wastageReport(database.db, business.id, parsed.data));
  });

  // In-stock inventory list with summary KPIs
  app.get("/", async (c) => {
    const business = c.get("business");
    const query = c.req.query("q");
    const category = c.req.query("category");
    const limit = Number(c.req.query("limit")) || undefined;

    const result = await listInStockInventory(database.db, business.id, {
      query,
      category,
      limit,
    });
    return c.json(result);
  });

  // Master categories list with item counts and in-stock counts
  app.get("/categories", async (c) => {
    const business = c.get("business");
    const categories = await listMasterCategories(database.db, business.id);
    return c.json({ categories });
  });

  // List master products (all catalog items, optional in_stock_only filter)
  app.get("/master-products", async (c) => {
    const business = c.get("business");
    const query = c.req.query("q");
    const category = c.req.query("category");
    const limit = Number(c.req.query("limit")) || undefined;
    const inStockOnly = c.req.query("in_stock_only") === "true";

    const items = await listMasterProducts(database.db, business.id, {
      query,
      category,
      limit,
      in_stock_only: inStockOnly,
    });
    return c.json({ items });
  });

  // Create master product
  app.post("/master-products", async (c) => {
    const business = c.get("business");
    const input = await parseJsonBody(createMasterProductSchema, c.req.raw);

    const product = await createMasterProduct(database.db, {
      businessId: business.id,
      displayName: input.display_name,
      category: input.category,
      standardUnit: input.standard_unit,
      reorderLevel: input.reorder_level,
      initialStock: input.initial_stock,
    });

    return c.json({ master_product: product }, 201);
  });

  // Get master product detail
  app.get("/master-products/:id", async (c) => {
    const business = c.get("business");
    const id = c.req.param("id");
    const product = await getMasterProduct(database.db, business.id, id);
    return c.json({ master_product: product });
  });

  // Update master product
  app.patch("/master-products/:id", async (c) => {
    const business = c.get("business");
    const id = c.req.param("id");
    const input = await parseJsonBody(updateMasterProductSchema, c.req.raw);

    const product = await updateMasterProduct(database.db, business.id, id, {
      displayName: input.display_name,
      category: input.category,
      standardUnit: input.standard_unit,
      reorderLevel: input.reorder_level,
    });

    return c.json({ master_product: product });
  });

  // Delete master product (its ledger goes with it; linked products and bill lines are unlinked)
  app.delete("/master-products/:id", requirePermission("catalog.merge"), async (c) => {
    const business = c.get("business");
    const id = c.req.param("id");
    await database.tx(({ db }) => deleteMasterProduct(db, business.id, id));
    return c.body(null, 204);
  });

  // Manual stock adjustment
  app.post("/master-products/:id/adjust", async (c) => {
    const business = c.get("business");
    const id = c.req.param("id");
    const input = await parseJsonBody(adjustStockSchema, c.req.raw);

    const wastage = input.kind === "wastage";
    if (wastage && dec(input.delta_weight).gte(0)) {
      throw new AppError("wastage_must_reduce", 422, "Wastage must reduce stock");
    }

    const result = await database.tx(async ({ db }) => {
      return recordStockIncrement(db, {
        businessId: business.id,
        masterProductId: id,
        deltaQuantity: input.delta_weight,
        quantityUnit: input.unit,
        type: wastage ? "wastage" : "manual_adjustment",
        note: input.note ?? (wastage ? "Wastage" : "Manual stock adjustment"),
        reason: wastage ? (input.reason ?? "spoiled") : null,
      });
    });

    const product = await getMasterProduct(database.db, business.id, id);
    return c.json({
      master_product: product,
      adjustment: result,
    });
  });

  // List transactions for a product
  app.get("/master-products/:id/transactions", async (c) => {
    const business = c.get("business");
    const id = c.req.param("id");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;

    const items = await listInventoryTransactions(database.db, business.id, id, limit);
    return c.json({ items });
  });

  // Purchase lots: each invoice's own quantity at its own landed cost
  app.get("/master-products/:id/lots", async (c) => {
    const business = c.get("business");
    const id = c.req.param("id");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    const open = c.req.query("open") === "true";
    const items = await listStockLots(database.db, business.id, id, { open, limit });
    return c.json({ items });
  });

  return app;
}
