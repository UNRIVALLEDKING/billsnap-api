import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env";
import { parseJsonBody } from "../../http/validate";
import type { Database } from "../../platform/db/client";
import { notFound } from "../../platform/errors";
import { dec } from "../../shared/money";
import {
  listProducts,
  listVendors,
  type MergeInput,
  mapProductToMaster,
  mergeProducts,
  mergeVendors,
  removeProductAlias,
  removeVendorAlias,
  setProductSpec,
} from "./catalog.service";

const mergeBody = z.object({
  keep_id: z.uuid(),
  merge_ids: z.array(z.uuid()).min(1).max(50),
  display_name: z.string().trim().min(1).max(200),
});

const mappingBody = z.object({
  master_product_id: z.uuid().nullable(),
});

// An id that cannot be a UUID cannot exist: same answer as a missing one.
const productIdParam = (raw: string | undefined) => {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw notFound("Product not found");
  return parsed.data;
};

const unitText = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .transform((s) => s.toLowerCase());

// "1 box = 200 g": pack_unit box, pack_qty "200", pack_qty_unit g (docs/CUSTOMER_SPECS_PLAN.md B7).
const specBody = z.object({
  pack_unit: unitText,
  pack_qty: z
    .string()
    .trim()
    .regex(/^\d{1,8}(\.\d{1,6})?$/, "expected a positive decimal string")
    .refine((s) => dec(s).gt(0), "pack_qty must be greater than 0"),
  pack_qty_unit: unitText,
});

function mergeRoutes(
  database: Database,
  list: (db: Database["db"], businessId: string) => Promise<unknown[]>,
  merge: (
    db: Database["db"],
    businessId: string,
    userId: string,
    input: MergeInput,
  ) => Promise<unknown>,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get("/", async (c) => c.json(await list(database.db, c.var.business.id)));
  routes.post("/merge", async (c) => {
    const b = await parseJsonBody(mergeBody, c.req.raw);
    const result = await database.tx(({ db }) =>
      merge(db, c.var.business.id, c.var.user.id, {
        keepId: b.keep_id,
        mergeIds: b.merge_ids,
        displayName: b.display_name,
      }),
    );
    return c.json(result);
  });
  return routes;
}

export const vendorRoutes = (database: Database) => {
  const routes = mergeRoutes(database, listVendors, mergeVendors);
  routes.delete("/:id/aliases/:alias", async (c) => {
    const id = c.req.param("id");
    const alias = decodeURIComponent(c.req.param("alias"));
    await removeVendorAlias(database.db, c.var.business.id, id, alias);
    return c.json({ status: "ok" });
  });
  return routes;
};

export const productRoutes = (database: Database) => {
  const routes = mergeRoutes(database, listProducts, mergeProducts);
  routes.put("/:id/mapping", async (c) => {
    const id = c.req.param("id");
    const b = await parseJsonBody(mappingBody, c.req.raw);
    await mapProductToMaster(database.db, c.var.business.id, id, b.master_product_id);
    return c.json({ status: "ok" });
  });
  routes.put("/:id/spec", async (c) => {
    const id = productIdParam(c.req.param("id"));
    const b = await parseJsonBody(specBody, c.req.raw);
    const product = await database.tx(({ db }) =>
      setProductSpec(db, c.var.business.id, id, {
        packUnit: b.pack_unit,
        packQty: b.pack_qty,
        packQtyUnit: b.pack_qty_unit,
      }),
    );
    return c.json(product);
  });
  routes.delete("/:id/spec", async (c) => {
    const id = productIdParam(c.req.param("id"));
    const product = await database.tx(({ db }) => setProductSpec(db, c.var.business.id, id, null));
    return c.json(product);
  });
  routes.delete("/:id/aliases/:alias", async (c) => {
    const id = c.req.param("id");
    const alias = decodeURIComponent(c.req.param("alias"));
    await removeProductAlias(database.db, c.var.business.id, id, alias);
    return c.json({ status: "ok" });
  });
  return routes;
};
