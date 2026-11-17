import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { z } from "zod";
import type { AppEnv } from "../../app-env";
import { requireAuth } from "../../http/middleware/auth";
import type { Database } from "../../platform/db/client";
import { AppError, unauthenticated } from "../../platform/errors";
import { newId } from "../../shared/ids";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { DEMO_BUSINESS_ID, DEMO_USER_ID, type DemoConfig } from "./demo-login";
import { defaultOtpService, type OtpService } from "./otp.service";
import { ACCESS_TTL_SECONDS, signToken, verifyToken } from "./tokens";

const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 60_000;

const sendOtpBody = z.object({
  identifier: z.string().trim().min(3).max(100),
});

const verifyOtpBody = z.object({
  identifier: z.string().trim().min(3).max(100),
  code: z.string().trim().length(6),
  name: z.string().trim().min(1).max(100).optional(),
  business_name: z.string().trim().min(1).max(200).optional(),
});

const loginBody = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

const refreshBody = z.object({
  refresh_token: z.string().min(1),
});

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function parse<T>(schema: z.ZodType<T>, req: Request): Promise<T> {
  const body = await req.json().catch(() => undefined);
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError("validation_failed", 422, "Invalid request body");
  return result.data;
}

export interface AuthRoutesDeps {
  database: Database;
  jwtSecret: string;
  demo?: DemoConfig | undefined;
  otpService?: OtpService | undefined;
}

export function authRoutes(deps: AuthRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const db = deps.database.db;
  const otpService = deps.otpService ?? defaultOtpService;
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

  function checkLoginRate(ip: string) {
    const now = Date.now();
    let entry = loginAttempts.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      loginAttempts.set(ip, entry);
    }
    entry.count++;
    if (entry.count > MAX_LOGIN_ATTEMPTS) {
      const retry = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      throw new AppError("rate_limited", 429, "Too many attempts", {
        "Retry-After": String(retry),
      });
    }
  }

  // POST /v1/auth/otp/send
  routes.post("/v1/auth/otp/send", async (c) => {
    const body = await parse(sendOtpBody, c.req.raw);
    const ip = clientIp(c);
    const result = otpService.sendOtp(body.identifier, ip);
    return c.json(result);
  });

  // POST /v1/auth/otp/verify
  routes.post("/v1/auth/otp/verify", async (c) => {
    const body = await parse(verifyOtpBody, c.req.raw);
    otpService.verifyOtp(body.identifier, body.code);

    const email = body.identifier.trim().toLowerCase();

    const result = await db.transaction(async (tx) => {
      // 1. Locate or create user
      const [existingUser] = await tx.select().from(users).where(eq(users.email, email)).limit(1);

      let user = existingUser;
      if (!user) {
        const fallbackName = body.name?.trim() || email.split("@")[0] || "Trader";
        const [createdUser] = await tx
          .insert(users)
          .values({
            id: newId(),
            email,
            name: fallbackName,
          })
          .returning();
        user = createdUser;
      }

      if (!user) {
        throw new AppError("internal", 500, "Failed to resolve or create user");
      }

      // 2. Query memberships
      const memberRows = await tx
        .select({
          role: memberships.role,
          businessId: businesses.id,
          businessName: businesses.name,
          gstin: businesses.gstin,
          stateCode: businesses.stateCode,
          tradeType: businesses.tradeType,
          configuredCategories: businesses.configuredCategories,
        })
        .from(memberships)
        .innerJoin(businesses, eq(memberships.businessId, businesses.id))
        .where(eq(memberships.userId, user.id));

      let activeMemberships: {
        role: "owner" | "accountant" | "staff";
        business: {
          id: string;
          name: string;
          gstin: string | null;
          state_code: string | null;
          trade_type?: string;
          configured_categories?: string[];
        };
      }[];

      if (memberRows.length === 0) {
        // Auto-provision a new business for first-time registrant
        const newBizId = newId();
        const bizName = body.business_name?.trim() || `${user.name || "My"} Store`;
        await tx.insert(businesses).values({
          id: newBizId,
          name: bizName,
          createdBy: user.id,
          tradeType: "general",
          configuredCategories: [],
        });
        await tx.insert(memberships).values({
          businessId: newBizId,
          userId: user.id,
          role: "owner",
        });

        activeMemberships = [
          {
            role: "owner",
            business: {
              id: newBizId,
              name: bizName,
              gstin: null,
              state_code: null,
              trade_type: "general",
              configured_categories: [],
            },
          },
        ];
      } else {
        activeMemberships = memberRows.map((r) => ({
          role: r.role,
          business: {
            id: r.businessId,
            name: r.businessName,
            gstin: r.gstin,
            state_code: r.stateCode,
            trade_type: r.tradeType,
            configured_categories: r.configuredCategories,
          },
        }));
      }

      const accessToken = await signToken(deps.jwtSecret, user.id, "access");
      const refreshToken = await signToken(deps.jwtSecret, user.id, "refresh");

      return {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: ACCESS_TTL_SECONDS,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        memberships: activeMemberships,
      };
    });

    return c.json(result);
  });

  // POST /v1/auth/refresh (Supports both real DB users and DEMO_USER_ID fallback)
  routes.post("/v1/auth/refresh", async (c) => {
    const body = await parse(refreshBody, c.req.raw);
    const sub = await verifyToken(deps.jwtSecret, body.refresh_token, "refresh");

    if (sub === DEMO_USER_ID) {
      return c.json({
        access_token: await signToken(deps.jwtSecret, sub, "access"),
        refresh_token: await signToken(deps.jwtSecret, sub, "refresh"),
        expires_in: ACCESS_TTL_SECONDS,
      });
    }

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, sub)).limit(1);
    if (!user) throw unauthenticated("Invalid token");

    return c.json({
      access_token: await signToken(deps.jwtSecret, user.id, "access"),
      refresh_token: await signToken(deps.jwtSecret, user.id, "refresh"),
      expires_in: ACCESS_TTL_SECONDS,
    });
  });

  // GET /v1/me (Supports both real DB users and DEMO_USER_ID fallback)
  routes.get("/v1/me", requireAuth(deps.jwtSecret), async (c) => {
    const userId = c.var.user.id;

    if (userId === DEMO_USER_ID) {
      return c.json({
        user: {
          id: DEMO_USER_ID,
          name: "Demo User",
          email: deps.demo?.email ?? "demo@billdrop.app",
        },
        memberships: [
          {
            role: "owner" as const,
            business: {
              id: DEMO_BUSINESS_ID,
              name: "Demo Business",
              gstin: null,
              state_code: null,
            },
          },
        ],
      });
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw unauthenticated("User not found");

    const memberRows = await db
      .select({
        role: memberships.role,
        businessId: businesses.id,
        businessName: businesses.name,
        gstin: businesses.gstin,
        stateCode: businesses.stateCode,
        tradeType: businesses.tradeType,
        configuredCategories: businesses.configuredCategories,
      })
      .from(memberships)
      .innerJoin(businesses, eq(memberships.businessId, businesses.id))
      .where(eq(memberships.userId, user.id));

    return c.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      memberships: memberRows.map((r) => ({
        role: r.role,
        business: {
          id: r.businessId,
          name: r.businessName,
          gstin: r.gstin,
          state_code: r.stateCode,
          trade_type: r.tradeType,
          configured_categories: r.configuredCategories,
        },
      })),
    });
  });

  // POST /v1/auth/demo-login (Kept for 1-tap demo testing and backwards compatibility)
  if (deps.demo) {
    const demo = deps.demo;
    routes.post("/v1/auth/demo-login", async (c) => {
      checkLoginRate(clientIp(c));
      const body = await parse(loginBody, c.req.raw);
      const emailOk = safeEqual(body.email.toLowerCase(), demo.email.toLowerCase());
      const passwordOk = safeEqual(body.password, demo.password);
      if (!emailOk || !passwordOk) {
        throw new AppError("invalid_credentials", 401, "Invalid email or password");
      }
      return c.json({
        access_token: await signToken(demo.jwtSecret, DEMO_USER_ID, "access"),
        refresh_token: await signToken(demo.jwtSecret, DEMO_USER_ID, "refresh"),
        expires_in: ACCESS_TTL_SECONDS,
        user: { id: DEMO_USER_ID, name: "Demo User", email: demo.email },
        memberships: [
          {
            role: "owner" as const,
            business: {
              id: DEMO_BUSINESS_ID,
              name: "Demo Business",
              gstin: null,
              state_code: null,
            },
          },
        ],
      });
    });
  }

  return routes;
}
