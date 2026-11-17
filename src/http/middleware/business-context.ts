import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../../app-env";
import { memberships } from "../../modules/businesses/businesses.schema";
import type { Db } from "../../platform/db/client";
import { AppError } from "../../platform/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads X-Business-Id, checks the signed-in user is a member (DB lookup), sets `c.var.business`. Run after requireAuth. */
export const businessContext = (db: Db) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const id = c.req.header("x-business-id")?.trim().toLowerCase();
    if (!id) throw new AppError("business_required", 400, "X-Business-Id header is required");
    const notMember = () => new AppError("not_a_member", 403, "Not a member of this business");
    if (!UUID.test(id)) throw notMember();
    const [row] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.businessId, id), eq(memberships.userId, c.var.user.id)))
      .limit(1);
    if (!row) throw notMember();
    c.set("business", { id, role: row.role });
    await next();
  });
