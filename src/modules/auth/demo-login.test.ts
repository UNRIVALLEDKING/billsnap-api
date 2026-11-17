import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { createApp } from "../../app";
import { createLogger } from "../../platform/logger";
import { Metrics } from "../../platform/metrics";
import { signToken } from "./tokens";

// biome-ignore lint/suspicious/noExplicitAny: test helper for loosely typed JSON
const j = (r: Response) => r.json() as Promise<any>;
const SECRET = "s".repeat(40);
const demo = { email: "demo@billdrop.app", password: "Demo@1234", jwtSecret: SECRET };

function build(enabled = true) {
  return createApp({
    logger: createLogger({ level: "silent" }),
    state: { shuttingDown: false },
    db: { ping: async () => {} },
    metrics: new Metrics(),
    demo: enabled ? demo : undefined,
  });
}

const post = (app: ReturnType<typeof build>, path: string, body: unknown, ip = "1.1.1.1") =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
const login = (app: ReturnType<typeof build>, password = demo.password, ip?: string) =>
  post(app, "/v1/auth/demo-login", { email: demo.email, password }, ip);
const me = (app: ReturnType<typeof build>, token?: string) =>
  app.request("/v1/me", { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("demo login", () => {
  test("success returns tokens, user and membership", async () => {
    const res = await login(build());
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.expires_in).toBe(43200);
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
    expect(body.user).toMatchObject({ name: "Demo User", email: demo.email });
    expect(body.memberships).toEqual([
      {
        role: "owner",
        business: expect.objectContaining({
          name: "Demo Business",
          gstin: null,
          state_code: null,
        }),
      },
    ]);
  });

  test("wrong password is 401 invalid_credentials", async () => {
    const res = await login(build(), "wrong-password");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect((await j(res)).code).toBe("invalid_credentials");
  });

  test("bad body is 422 validation_failed", async () => {
    const res = await post(build(), "/v1/auth/demo-login", { email: "a@b.co" });
    expect(res.status).toBe(422);
    expect((await j(res)).code).toBe("validation_failed");
  });

  test("11th attempt from one IP is 429 with Retry-After", async () => {
    const app = build();
    for (let i = 0; i < 10; i++) expect((await login(app, "bad", "9.9.9.9")).status).toBe(401);
    const res = await login(app, "bad", "9.9.9.9");
    expect(res.status).toBe(429);
    expect((await j(res)).code).toBe("rate_limited");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login(app, demo.password, "8.8.8.8")).status).toBe(200);
  });
});

describe("refresh and me", () => {
  test("refresh token yields new tokens", async () => {
    const app = build();
    const { refresh_token } = await j(await login(app));
    const res = await post(app, "/v1/auth/refresh", { refresh_token });
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.expires_in).toBe(43200);
    expect((await me(app, body.access_token)).status).toBe(200);
  });

  test("an access token is rejected as a refresh token", async () => {
    const app = build();
    const { access_token } = await j(await login(app));
    const res = await post(app, "/v1/auth/refresh", { refresh_token: access_token });
    expect(res.status).toBe(401);
    expect((await j(res)).code).toBe("unauthenticated");
  });

  test("GET /v1/me with a valid token", async () => {
    const app = build();
    const { access_token } = await j(await login(app));
    const res = await me(app, access_token);
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.user.email).toBe(demo.email);
    expect(body.memberships).toHaveLength(1);
  });

  test("expired access token is 401 token_expired", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await new SignJWT({ typ: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("01900000-0000-7000-8000-000000000001")
      .setIssuer("billdrop-api")
      .setAudience("billdrop-app")
      .setIssuedAt(past - 60)
      .setExpirationTime(past)
      .sign(new TextEncoder().encode(SECRET));
    const res = await me(build(), token);
    expect(res.status).toBe(401);
    expect((await j(res)).code).toBe("token_expired");
  });

  test("missing, garbage and refresh tokens are 401 unauthenticated", async () => {
    const app = build();
    for (const token of [undefined, "garbage", await signToken(SECRET, "x", "refresh")]) {
      const res = await me(app, token);
      expect(res.status).toBe(401);
      expect((await j(res)).code).toBe("unauthenticated");
    }
  });
});

describe("when disabled", () => {
  test("routes are not mounted", async () => {
    const app = build(false);
    for (const res of [await login(app), await me(app), await post(app, "/v1/auth/refresh", {})]) {
      expect(res.status).toBe(404);
      expect((await j(res)).code).toBe("not_found");
    }
  });
});
