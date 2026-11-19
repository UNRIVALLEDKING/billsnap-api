import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { z } from "zod";
import type { AppEnv } from "../../app-env";
import { requireAuth } from "../../http/middleware/auth";
import type { Database, Executor } from "../../platform/db/client";
import { AppError, unauthenticated } from "../../platform/errors";
import { newId } from "../../shared/ids";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { DEMO_BUSINESS_ID, DEMO_USER_ID, type DemoConfig } from "./demo-login";
import { defaultOtpService, type OtpService } from "./otp.service";
import {
  hashPassword,
  PASSWORD_MAX,
  PASSWORD_MIN,
  verifyAgainstDummy,
  verifyPassword,
} from "./password";
import { ACCESS_TTL_SECONDS, signToken, verifyToken } from "./tokens";

const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 60_000;
/** Password login: per IP (like demo login) and per email, so one account cannot be brute forced from many IPs. */
const MAX_PASSWORD_LOGINS_PER_IP = 10;
const PASSWORD_LOGIN_IP_WINDOW_MS = 60_000;
const MAX_PASSWORD_LOGINS_PER_EMAIL = 10;
const PASSWORD_LOGIN_EMAIL_WINDOW_MS = 15 * 60_000;
const RATE_MAP_PRUNE_AT = 10_000;

const INVALID_CREDENTIALS = "Invalid email or password";
const ACCOUNT_EXISTS = "This email already has an account. Sign in with your password.";

const passwordField = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);

const sendOtpBody = z.object({
  identifier: z.string().trim().min(3).max(100),
});

const verifyOtpBody = z.object({
  identifier: z.string().trim().min(3).max(100),
  code: z.string().trim().length(6),
  name: z.string().trim().min(1).max(100).optional(),
  business_name: z.string().trim().min(1).max(200).optional(),
  password: passwordField.optional(),
});

const passwordLoginBody = z.object({
  email: z.string().trim().min(1).max(254),
  // Only an upper bound here: a short wrong password is just a wrong password (401), not a 422.
  password: z.string().min(1).max(PASSWORD_MAX),
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

type RateEntry = { count: number; resetAt: number };

/** Fixed-window counter; throws 429 rate_limited with Retry-After once `max` hits are exceeded. */
function rateLimiter(max: number, windowMs: number) {
  const entries = new Map<string, RateEntry>();
  return {
    hit(key: string) {
      const now = Date.now();
      if (entries.size > RATE_MAP_PRUNE_AT) {
        for (const [k, e] of entries) if (e.resetAt <= now) entries.delete(k);
      }
      let entry = entries.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        entries.set(key, entry);
      }
      entry.count++;
      if (entry.count > max) {
        const retry = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        throw new AppError("rate_limited", 429, "Too many attempts. Wait a moment and try again.", {
          "Retry-After": String(retry),
        });
      }
    },
    reset(key: string) {
      entries.delete(key);
    },
  };
}

export type MembershipView = {
  role: "owner" | "accountant" | "staff";
  business: {
    id: string;
    name: string;
    gstin: string | null;
    state_code: string | null;
    trade_type?: string;
    configured_categories?: string[];
    name_aliases?: string[];
  };
};

/** The memberships block shared by OTP verify, password login and GET /v1/me. */
export async function loadMemberships(db: Executor, userId: string): Promise<MembershipView[]> {
  const rows = await db
    .select({
      role: memberships.role,
      businessId: businesses.id,
      businessName: businesses.name,
      gstin: businesses.gstin,
      stateCode: businesses.stateCode,
      tradeType: businesses.tradeType,
      configuredCategories: businesses.configuredCategories,
      nameAliases: businesses.nameAliases,
    })
    .from(memberships)
    .innerJoin(businesses, eq(memberships.businessId, businesses.id))
    .where(eq(memberships.userId, userId));
  return rows.map((r) => ({
    role: r.role,
    business: {
      id: r.businessId,
      name: r.businessName,
      gstin: r.gstin,
      state_code: r.stateCode,
      trade_type: r.tradeType,
      configured_categories: r.configuredCategories,
      name_aliases: r.nameAliases,
    },
  }));
}

/** Public user columns only: password_hash is never selected into a response. */
const publicUser = { id: users.id, name: users.name, email: users.email };

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
  const demoLoginLimit = rateLimiter(MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS);
  const passwordIpLimit = rateLimiter(MAX_PASSWORD_LOGINS_PER_IP, PASSWORD_LOGIN_IP_WINDOW_MS);
  const passwordEmailLimit = rateLimiter(
    MAX_PASSWORD_LOGINS_PER_EMAIL,
    PASSWORD_LOGIN_EMAIL_WINDOW_MS,
  );

  async function session(
    user: { id: string; name: string | null; email: string | null },
    activeMemberships: MembershipView[],
  ) {
    return {
      access_token: await signToken(deps.jwtSecret, user.id, "access"),
      refresh_token: await signToken(deps.jwtSecret, user.id, "refresh"),
      expires_in: ACCESS_TTL_SECONDS,
      user: { id: user.id, name: user.name, email: user.email },
      memberships: activeMemberships,
    };
  }

  // POST /v1/auth/otp/send
  routes.post("/v1/auth/otp/send", async (c) => {
    const body = await parse(sendOtpBody, c.req.raw);
    const ip = clientIp(c);
    const result = otpService.sendOtp(body.identifier, ip);
    return c.json(result);
  });

  // POST /v1/auth/otp/verify: registration. Creates the user (with a password) and an owner business.
  // An email whose account already has a password is refused (409), so the OTP, which the app shows on
  // screen, can never take over or reset a passworded account. A legacy passwordless account may set its
  // password here exactly once.
  routes.post("/v1/auth/otp/verify", async (c) => {
    const body = await parse(verifyOtpBody, c.req.raw);
    otpService.verifyOtp(body.identifier, body.code);

    const email = body.identifier.trim().toLowerCase();
    // Hash outside the transaction: argon2id is deliberately slow.
    const passwordHash = body.password === undefined ? null : await hashPassword(body.password);

    const result = await db.transaction(async (tx) => {
      // Serialise registrations for one email (there is no unique index on users.email).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`user:${email}`}, 0))`);

      const [existingUser] = await tx
        .select({ ...publicUser, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, email))
        .orderBy(asc(users.createdAt))
        .limit(1);

      // The demo account signs in only through demo-login; it never gets a password here.
      if (existingUser?.passwordHash || existingUser?.id === DEMO_USER_ID) {
        throw new AppError("account_exists", 409, ACCOUNT_EXISTS);
      }
      if (passwordHash === null) {
        throw new AppError("validation_failed", 422, "A password is required to register");
      }

      let user: { id: string; name: string | null; email: string | null } | undefined;
      if (existingUser) {
        // Legacy passwordless account: set the password once (the guard makes a second set impossible).
        const [updated] = await tx
          .update(users)
          .set({ passwordHash })
          .where(and(eq(users.id, existingUser.id), isNull(users.passwordHash)))
          .returning(publicUser);
        if (!updated) throw new AppError("account_exists", 409, ACCOUNT_EXISTS);
        user = updated;
      } else {
        const fallbackName = body.name?.trim() || email.split("@")[0] || "Trader";
        [user] = await tx
          .insert(users)
          .values({ id: newId(), email, name: fallbackName, passwordHash })
          .returning(publicUser);
      }

      if (!user) {
        throw new AppError("internal", 500, "Failed to resolve or create user");
      }

      let activeMemberships = await loadMemberships(tx, user.id);
      if (activeMemberships.length === 0) {
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
              name_aliases: [],
            },
          },
        ];
      }

      return session(user, activeMemberships);
    });

    return c.json(result);
  });

  // POST /v1/auth/login: email + password. Unknown email, passwordless account and wrong password all
  // give the same 401 after about the same work.
  routes.post("/v1/auth/login", async (c) => {
    passwordIpLimit.hit(clientIp(c));
    const body = await parse(passwordLoginBody, c.req.raw);
    const email = body.email.toLowerCase();
    passwordEmailLimit.hit(email);

    const [user] = await db
      .select({ ...publicUser, passwordHash: users.passwordHash })
      .from(users)
      .where(and(eq(users.email, email), isNotNull(users.passwordHash)))
      .orderBy(asc(users.createdAt))
      .limit(1);

    let ok = false;
    if (user?.passwordHash) ok = await verifyPassword(body.password, user.passwordHash);
    else await verifyAgainstDummy(body.password);
    if (!user || !ok) throw new AppError("invalid_credentials", 401, INVALID_CREDENTIALS);

    passwordEmailLimit.reset(email);
    return c.json(await session(user, await loadMemberships(db, user.id)));
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

    const [user] = await db.select(publicUser).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw unauthenticated("User not found");

    return c.json({ user, memberships: await loadMemberships(db, user.id) });
  });

  // POST /v1/auth/demo-login (Kept for 1-tap demo testing and backwards compatibility)
  if (deps.demo) {
    const demo = deps.demo;
    routes.post("/v1/auth/demo-login", async (c) => {
      demoLoginLimit.hit(clientIp(c));
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
