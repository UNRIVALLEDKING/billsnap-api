import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../../app-env";
import { verifyToken } from "../../modules/auth/tokens";
import { unauthenticated } from "../../platform/errors";

/** Requires `Authorization: Bearer <access token>`; sets `c.var.user = { id }`. */
export const requireAuth = (jwtSecret: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const match = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    if (!match?.[1]) throw unauthenticated();
    c.set("user", { id: await verifyToken(jwtSecret, match[1], "access") });
    await next();
  });
