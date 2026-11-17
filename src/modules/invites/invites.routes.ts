import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env";
import { requireAuth } from "../../http/middleware/auth";
import { businessContext } from "../../http/middleware/business-context";
import { parseJsonBody } from "../../http/validate";
import type { Database } from "../../platform/db/client";
import { AppError } from "../../platform/errors";
import { memberships } from "../businesses/businesses.schema";
import { createInviteBody } from "./invites.schema";
import {
  acceptInvite,
  createInvite,
  getInvitePreview,
  listMembersAndInvites,
  listPendingInvites,
  removeMember,
  revokeInvite,
} from "./invites.service";

export function invitesRoutes(deps: { database: Database; jwtSecret: string }): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // POST /v1/invites - requires auth and business context (only owner)
  routes.post("/", requireAuth(deps.jwtSecret), businessContext(deps.database.db), async (c) => {
    if (c.var.business.role !== "owner") {
      throw new AppError("forbidden", 403, "Only the business owner can create invites");
    }
    const body = await parseJsonBody(createInviteBody, c.req.raw);
    const invite = await createInvite(
      deps.database.db,
      c.var.business.id,
      c.var.user.id,
      body.role,
    );
    return c.json({ invite, ...invite }, 201);
  });

  // GET /v1/invites - pending invites of the current business
  routes.get("/", requireAuth(deps.jwtSecret), businessContext(deps.database.db), async (c) => {
    const items = await listPendingInvites(deps.database.db, c.var.business.id);
    return c.json({ invites: items, items });
  });

  // DELETE /v1/invites/:id - revoke a pending invite (owner only)
  routes.delete(
    "/:id",
    requireAuth(deps.jwtSecret),
    businessContext(deps.database.db),
    async (c) => {
      if (c.var.business.role !== "owner") {
        throw new AppError("forbidden", 403, "Only the business owner can revoke invites");
      }
      await revokeInvite(deps.database.db, c.var.business.id, c.req.param("id"));
      return c.body(null, 204);
    },
  );

  // GET /v1/invites/:token - public endpoint (no auth required)
  routes.get("/:token", async (c) => {
    const token = c.req.param("token");
    const preview = await getInvitePreview(deps.database.db, token);
    return c.json({ invite: preview, ...preview });
  });

  // POST /v1/invites/:token/accept - requires auth
  routes.post("/:token/accept", requireAuth(deps.jwtSecret), async (c) => {
    const token = c.req.param("token");
    const result = await acceptInvite(deps.database.db, token, c.var.user.id);
    return c.json({ success: true, ...result });
  });

  return routes;
}

export function memberRoutes(database: Database): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // GET /v1/businesses/:id/members - requires auth and business context
  routes.get("/:id/members", async (c) => {
    const businessId = c.req.param("id");
    const [membership] = await database.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, c.var.user.id)))
      .limit(1);

    if (!membership) {
      throw new AppError("not_a_member", 403, "Not a member of this business");
    }

    c.set("business", { id: businessId, role: membership.role });

    const result = await listMembersAndInvites(database.db, businessId);
    return c.json(result);
  });

  // DELETE /v1/businesses/:id/members/:userId - requires auth and business context (owner only)
  routes.delete("/:id/members/:userId", async (c) => {
    const businessId = c.req.param("id");
    const targetUserId = c.req.param("userId");

    const [membership] = await database.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, c.var.user.id)))
      .limit(1);

    if (!membership) {
      throw new AppError("not_a_member", 403, "Not a member of this business");
    }

    if (membership.role !== "owner") {
      throw new AppError("forbidden", 403, "Only the business owner can remove members");
    }

    c.set("business", { id: businessId, role: membership.role });

    const result = await removeMember(database.db, businessId, targetUserId, c.var.user.id);
    return c.json(result);
  });

  return routes;
}
