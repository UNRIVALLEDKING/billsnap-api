// Email + password accounts against the real Postgres: registration via OTP verify, login, takeover guards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, like } from "drizzle-orm";
import { testDatabase } from "../../../test/setup";
import { createApp } from "../../app";
import type { Database } from "../../platform/db/client";
import { createLogger } from "../../platform/logger";
import { Metrics } from "../../platform/metrics";
import type { Queue } from "../../platform/queue";
import type { Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { seedDemoAccount } from "./demo-seed";
import { defaultOtpService } from "./otp.service";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in assertions
type Json = any;

const SECRET = "p".repeat(40);
const demo = { email: "demo@billdrop.app", password: "Demo@1234", jwtSecret: SECRET };
const RUN = newId().slice(-12);
const DOMAIN = `pwtest-${RUN}.example.test`;
const PASSWORD = "correct horse 42";
/** argon2id hashing is deliberately slow, and slower still when the whole suite runs. */
const SLOW = 60_000;

let database: Database;
let ipSeq = 0;
const nextIp = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
const emailFor = (tag: string) => `${tag}@${DOMAIN}`;

function build() {
  return createApp({
    logger: createLogger({ level: "silent" }),
    state: { shuttingDown: false },
    db: database,
    metrics: new Metrics(),
    demo,
    // Auth never touches storage or the queue.
    data: { database, storage: {} as Storage, queue: {} as Queue },
  });
}
type App = ReturnType<typeof build>;

const post = (app: App, path: string, body: unknown, ip = nextIp()) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

async function sendOtp(app: App, email: string): Promise<string> {
  const res = await post(app, "/v1/auth/otp/send", { identifier: email });
  expect(res.status).toBe(200);
  const body: Json = await res.json();
  expect(body.debug_otp).toMatch(/^\d{6}$/);
  return body.debug_otp;
}

async function register(app: App, email: string, extra: Record<string, unknown>) {
  const code = await sendOtp(app, email);
  return post(app, "/v1/auth/otp/verify", {
    identifier: email,
    code,
    name: "Ravi",
    business_name: "Ravi Traders",
    ...extra,
  });
}

const login = (app: App, email: string, password: string, ip?: string) =>
  post(app, "/v1/auth/login", { email, password }, ip);

async function storedHash(email: string): Promise<string | null | undefined> {
  const [row] = await database.db
    .select({ hash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email));
  return row?.hash;
}

beforeAll(async () => {
  database = await testDatabase();
  defaultOtpService.clear();
  await seedDemoAccount(database.db, demo.email);
});

afterAll(async () => {
  const created = await database.db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${DOMAIN}`));
  const ids = created.map((u) => u.id);
  if (ids.length > 0) {
    await database.db.delete(businesses).where(inArray(businesses.createdBy, ids));
    await database.db.delete(users).where(inArray(users.id, ids));
  }
});

describe("register with password, then log in", () => {
  test(
    "register stores an argon2id hash and login returns the same shape",
    async () => {
      const app = build();
      const email = emailFor("ravi");
      const reg = await register(app, email, { password: PASSWORD });
      expect(reg.status).toBe(200);
      const regBody: Json = await reg.json();
      expect(regBody.user).toEqual({ id: expect.any(String), name: "Ravi", email });
      expect(JSON.stringify(regBody)).not.toContain("password");
      expect(regBody.memberships).toEqual([
        {
          role: "owner",
          business: {
            id: expect.any(String),
            name: "Ravi Traders",
            gstin: null,
            state_code: null,
            trade_type: "general",
            configured_categories: [],
            name_aliases: [],
          },
        },
      ]);
      const hash = await storedHash(email);
      expect(hash).toStartWith("$argon2id$");
      expect(hash).not.toContain(PASSWORD);

      const res = await login(app, `  ${email.toUpperCase()} `, PASSWORD);
      expect(res.status).toBe(200);
      const body: Json = await res.json();
      expect(Object.keys(body).sort()).toEqual(
        ["access_token", "expires_in", "memberships", "refresh_token", "user"].sort(),
      );
      expect(body.expires_in).toBe(43200);
      expect(body.user).toEqual(regBody.user);
      expect(body.memberships).toEqual(regBody.memberships);
      expect(JSON.stringify(body)).not.toContain("argon2");

      const me = await app.request("/v1/me", {
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      expect(me.status).toBe(200);
      const meBody: Json = await me.json();
      expect(meBody.user).toEqual(regBody.user);
      expect(meBody.memberships).toEqual(regBody.memberships);
    },
    SLOW,
  );

  test(
    "wrong password and unknown email are the same 401 invalid_credentials",
    async () => {
      const app = build();
      const email = emailFor("wrongpw");
      expect((await register(app, email, { password: PASSWORD })).status).toBe(200);

      const wrong = await login(app, email, "not the password");
      const unknown = await login(app, emailFor("nobody"), PASSWORD);
      for (const res of [wrong, unknown]) {
        expect(res.status).toBe(401);
        const body: Json = await res.json();
        expect(body.code).toBe("invalid_credentials");
        expect(body.detail).toBe("Invalid email or password");
      }
    },
    SLOW,
  );

  test(
    "password shorter than 8 or longer than 128 is 422 and creates nothing",
    async () => {
      const app = build();
      for (const [tag, password] of [
        ["short", "1234567"],
        ["long", "x".repeat(129)],
      ] as const) {
        const res = await register(app, emailFor(tag), { password });
        expect(res.status).toBe(422);
        expect(((await res.json()) as Json).code).toBe("validation_failed");
        expect(await storedHash(emailFor(tag))).toBeUndefined();
      }
    },
    SLOW,
  );

  test(
    "a new email without a password is refused (422)",
    async () => {
      const app = build();
      const res = await register(app, emailFor("nopw"), {});
      expect(res.status).toBe(422);
      expect(await storedHash(emailFor("nopw"))).toBeUndefined();
    },
    SLOW,
  );

  test(
    "login body validation: missing password is 422",
    async () => {
      const res = await post(build(), "/v1/auth/login", { email: emailFor("x") });
      expect(res.status).toBe(422);
    },
    SLOW,
  );
});

describe("OTP cannot take over a passworded account", () => {
  test(
    "re-registering with a new password is 409 and keeps the old password",
    async () => {
      const app = build();
      const email = emailFor("owner");
      expect((await register(app, email, { password: PASSWORD })).status).toBe(200);
      const before = await storedHash(email);

      const again = await register(app, email, { password: "attacker-password" });
      expect(again.status).toBe(409);
      const body: Json = await again.json();
      expect(body.code).toBe("account_exists");
      expect(body.detail).toBe("This email already has an account. Sign in with your password.");
      expect(body.access_token).toBeUndefined();

      const noPassword = await register(app, email, {});
      expect(noPassword.status).toBe(409);
      expect(((await noPassword.json()) as Json).code).toBe("account_exists");

      expect(await storedHash(email)).toBe(before);
      expect((await login(app, email, "attacker-password")).status).toBe(401);
      expect((await login(app, email, PASSWORD)).status).toBe(200);
    },
    SLOW,
  );

  test(
    "the demo account cannot be claimed through OTP",
    async () => {
      const app = build();
      const res = await register(app, demo.email, { password: "demo-takeover-1" });
      expect(res.status).toBe(409);
      expect(await storedHash(demo.email)).toBeNull();
      expect((await login(app, demo.email, "demo-takeover-1")).status).toBe(401);
    },
    SLOW,
  );
});

describe("legacy passwordless accounts", () => {
  test(
    "can set a password once via OTP, keeping their user and business",
    async () => {
      const app = build();
      const email = emailFor("legacy");
      const userId = newId();
      const bizId = newId();
      await database.db.insert(users).values({ id: userId, name: "Old", email });
      await database.db
        .insert(businesses)
        .values({ id: bizId, name: "Old Shop", createdBy: userId, tradeType: "general" });
      await database.db.insert(memberships).values({ businessId: bizId, userId, role: "owner" });

      expect((await login(app, email, PASSWORD)).status).toBe(401);

      const set = await register(app, email, { password: PASSWORD });
      expect(set.status).toBe(200);
      const body: Json = await set.json();
      expect(body.user.id).toBe(userId);
      expect(body.memberships).toHaveLength(1);
      expect(body.memberships[0].business.id).toBe(bizId);

      expect((await login(app, email, PASSWORD)).status).toBe(200);

      const second = await register(app, email, { password: "second-password" });
      expect(second.status).toBe(409);
      expect((await login(app, email, "second-password")).status).toBe(401);
      expect((await login(app, email, PASSWORD)).status).toBe(200);
    },
    SLOW,
  );
});

describe("rate limiting", () => {
  test(
    "11th login from one IP is 429 with Retry-After",
    async () => {
      const app = build();
      const ip = "10.99.0.1";
      for (let i = 0; i < 10; i++) {
        expect((await login(app, emailFor(`ipflood${i}`), "wrong-pass", ip)).status).toBe(401);
      }
      const res = await login(app, emailFor("ipflood-last"), "wrong-pass", ip);
      expect(res.status).toBe(429);
      expect(((await res.json()) as Json).code).toBe("rate_limited");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    },
    SLOW,
  );

  test(
    "11th login for one email from many IPs is 429",
    async () => {
      const app = build();
      const email = emailFor("target");
      expect((await register(app, email, { password: PASSWORD })).status).toBe(200);
      for (let i = 0; i < 10; i++) expect((await login(app, email, "guess-pass")).status).toBe(401);
      const res = await login(app, email, PASSWORD);
      expect(res.status).toBe(429);
      expect(((await res.json()) as Json).code).toBe("rate_limited");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      // Other accounts are unaffected.
      expect((await login(app, emailFor("someone-else"), PASSWORD)).status).toBe(401);
    },
    SLOW,
  );
});

describe("demo login is unchanged", () => {
  test(
    "demo-login still works and /v1/auth/login does not accept demo credentials",
    async () => {
      const app = build();
      const res = await post(app, "/v1/auth/demo-login", {
        email: demo.email,
        password: demo.password,
      });
      expect(res.status).toBe(200);
      const body: Json = await res.json();
      expect(body.user).toMatchObject({ name: "Demo User", email: demo.email });
      expect((await login(app, demo.email, demo.password)).status).toBe(401);
    },
    SLOW,
  );
});
