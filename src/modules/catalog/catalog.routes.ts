import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env";
import { parseJsonBody } from "../../http/validate";
import type { Database } from "../../platform/db/client";
import {
  listProducts,
  listVendors,
  type MergeInput,
  mapProductToMaster,
  mergeProducts,
  mergeVendors,
  removeProductAlias,
  removeVendorAlias,
} from "./catalog.service";

const mergeBody = z.object({
  keep_id: z.uuid(),
  merge_ids: z.array(z.uuid()).min(1).max(50),
  display_name: z.string().trim().min(1).max(200),
});

const mappingBody = z.object({
  master_product_id: z.uuid().nullable(),
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
  routes.delete("/:id/aliases/:alias", async (c) => {
    const id = c.req.param("id");
    const alias = decodeURIComponent(c.req.param("alias"));
    await removeProductAlias(database.db, c.var.business.id, id, alias);
    return c.json({ status: "ok" });
  });
  return routes;
};
