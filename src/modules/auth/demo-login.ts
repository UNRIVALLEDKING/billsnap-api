// TEMPORARY, DEMO ONLY: email/password login so the app can sign in before real auth exists.
// Mounted from app.ts only when DEMO_LOGIN_ENABLED=true (config forbids that in production).
// Phase A3 replaces this with Google/Apple sign-in and rotating DB-backed sessions (SYSTEM_DESIGN section 4).
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { z } from "zod";
import type { AppEnv } from "../../app-env";
import { requireAuth } from "../../http/middleware/auth";
import { AppError, unauthenticated } from "../../platform/errors";
import { ACCESS_TTL_SECONDS, signToken, verifyToken } from "./tokens";

export type DemoConfig = { email: string; password: string; jwtSecret: string };

export const DEMO_USER_ID = "01900000-0000-7000-8000-000000000001";
export const DEMO_BUSINESS_ID = "01900000-0000-7000-8000-000000000002";
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 60_000;

const loginBody = z.object({ email: z.string().min(1), password: z.string().min(1) });
const refreshBody = z.object({ refresh_token: z.string().min(1) });

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // no socket (e.g. app.request in tests)
  }
}

async function parse<T>(schema: z.ZodType<T>, req: Request): Promise<T> {
  const body = await req.json().catch(() => undefined);
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError("validation_failed", 422, "Invalid request body");
  return result.data;
}

export function demoLoginRoutes(cfg: DemoConfig): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const attempts = new Map<string, { count: number; resetAt: number }>();

  const user = { id: DEMO_USER_ID, name: "Demo User", email: cfg.email };
  const memberships = [
    {
      role: "owner",
      business: {
        id: DEMO_BUSINESS_ID,
        name: "Demo Business",
        gstin: null,
        state_code: null,
      },
    },
  ];

  function checkRate(ip: string) {
    const now = Date.now();
    let entry = attempts.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      attempts.set(ip, entry);
    }
    entry.count++;
    if (entry.count > MAX_ATTEMPTS) {
      const retry = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      throw new AppError("rate_limited", 429, "Too many attempts", {
        "Retry-After": String(retry),
      });
    }
  }

  routes.post("/v1/auth/demo-login", async (c) => {
    checkRate(clientIp(c));
    const body = await parse(loginBody, c.req.raw);
    // Evaluate both so timing does not reveal which field was wrong.
    const emailOk = safeEqual(body.email.toLowerCase(), cfg.email.toLowerCase());
    const passwordOk = safeEqual(body.password, cfg.password);
    if (!emailOk || !passwordOk) {
      throw new AppError("invalid_credentials", 401, "Invalid email or password");
    }
    return c.json({
      access_token: await signToken(cfg.jwtSecret, DEMO_USER_ID, "access"),
      refresh_token: await signToken(cfg.jwtSecret, DEMO_USER_ID, "refresh"),
      expires_in: ACCESS_TTL_SECONDS,
      user,
      memberships,
    });
  });

  routes.post("/v1/auth/refresh", async (c) => {
    const body = await parse(refreshBody, c.req.raw);
    const sub = await verifyToken(cfg.jwtSecret, body.refresh_token, "refresh");
    if (sub !== DEMO_USER_ID) throw unauthenticated("Invalid token");
    return c.json({
      access_token: await signToken(cfg.jwtSecret, sub, "access"),
      refresh_token: await signToken(cfg.jwtSecret, sub, "refresh"),
      expires_in: ACCESS_TTL_SECONDS,
    });
  });

  routes.get("/v1/me", requireAuth(cfg.jwtSecret), (c) => {
    if (c.var.user.id !== DEMO_USER_ID) throw unauthenticated("Invalid token");
    return c.json({ user, memberships });
  });

  return routes;
}
