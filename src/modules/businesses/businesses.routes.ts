import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env";
import { parseJsonBody } from "../../http/validate";
import type { Database } from "../../platform/db/client";
import { AppError } from "../../platform/errors";
import { createBusinessBody, memberships, updateBusinessBody } from "./businesses.schema";
import {
  createBusiness,
  getBusiness,
  listUserBusinesses,
  updateBusiness,
} from "./businesses.service";

export const businessRoutes = (database: Database) => {
  const routes = new Hono<AppEnv>();

  routes.get("/", async (c) => {
    const list = await listUserBusinesses(database.db, c.var.user.id);
    return c.json({ businesses: list });
  });

  routes.post("/", async (c) => {
    const body = await parseJsonBody(createBusinessBody, c.req.raw);
    // One business per account (a single tax entity).
    const [existing] = await database.db
      .select({ businessId: memberships.businessId })
      .from(memberships)
      .where(eq(memberships.userId, c.var.user.id))
      .limit(1);
    if (existing) {
      throw new AppError("business_exists", 409, "Your account already has a business.");
    }
    const created = await database.tx(({ db }) => createBusiness(db, c.var.user.id, body));
    return c.json({ business: created }, 201);
  });

  routes.get("/:id", async (c) => {
    const id = c.req.param("id");
    const [membership] = await database.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.businessId, id), eq(memberships.userId, c.var.user.id)))
      .limit(1);

    if (!membership) {
      throw new AppError("not_a_member", 403, "Not a member of this business");
    }

    const b = await getBusiness(database.db, id);
    return c.json({ business: { ...b, role: membership.role } });
  });

  routes.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const [membership] = await database.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.businessId, id), eq(memberships.userId, c.var.user.id)))
      .limit(1);

    if (!membership) {
      throw new AppError("not_a_member", 403, "Not a member of this business");
    }
    if (membership.role !== "owner") {
      throw new AppError("forbidden", 403, "Only the business owner can edit business details");
    }

    const body = await parseJsonBody(updateBusinessBody, c.req.raw);
    const updated = await updateBusiness(database.db, id, body);
    return c.json({ business: { ...updated, role: membership.role } });
  });

  return routes;
};
