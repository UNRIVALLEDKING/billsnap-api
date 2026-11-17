import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "./config";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
};

describe("loadConfig", () => {
  test("parses valid env and applies defaults", () => {
    const cfg = loadConfig({ ...base, NODE_ENV: "test" });
    expect(cfg).toEqual({
      ...base,
      NODE_ENV: "test",
      PORT: 3000,
      LOG_LEVEL: "info",
      DB_POOL_SIZE: 10,
      METRICS_PORT: 9100,
      GEMINI_API_KEY: undefined,
      AI_MODEL: "gemini-3.5-flash-lite",
      AI_FALLBACK_MODEL: "gemini-3.8-flash",
      AI_MAX_CONCURRENCY: 4,
      DEMO_LOGIN_ENABLED: false,
    });
  });

  test("storage needs an account id or an S3 endpoint", () => {
    const { R2_ACCOUNT_ID: _, ...noAccount } = base;
    expect(() => loadConfig({ ...noAccount, NODE_ENV: "test" })).toThrow(/R2_ACCOUNT_ID/);
    expect(
      loadConfig({ ...noAccount, NODE_ENV: "test", S3_ENDPOINT: "http://localhost:9000" })
        .S3_ENDPOINT,
    ).toBe("http://localhost:9000");
  });

  test("coerces PORT and accepts ROLE", () => {
    const cfg = loadConfig({ ...base, NODE_ENV: "production", PORT: "8080", ROLE: "worker" });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.ROLE).toBe("worker");
  });

  test("missing key throws with the key name", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/NODE_ENV: missing/);
    expect(() => loadConfig({ NODE_ENV: "test" })).toThrow(/DATABASE_URL: missing/);
  });

  test("lists every invalid key", () => {
    try {
      loadConfig({ ...base, NODE_ENV: "nope", PORT: "abc", LOG_LEVEL: "loud" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain("NODE_ENV");
      expect(msg).toContain("PORT");
      expect(msg).toContain("LOG_LEVEL");
    }
  });
});

describe("loadConfig demo login", () => {
  const demo = {
    ...base,
    DEMO_LOGIN_ENABLED: "true",
    DEMO_EMAIL: "demo@billdrop.app",
    DEMO_PASSWORD: "Demo@1234",
    JWT_SECRET: "x".repeat(32),
  };

  test("accepts a complete demo config outside production", () => {
    expect(loadConfig({ ...demo, NODE_ENV: "development" }).DEMO_LOGIN_ENABLED).toBe(true);
  });

  test("enabled together with production is a config error", () => {
    expect(() => loadConfig({ ...demo, NODE_ENV: "production" })).toThrow(/DEMO_LOGIN_ENABLED/);
  });

  test("enabled without the secret is a config error", () => {
    const { JWT_SECRET: _, ...noSecret } = demo;
    expect(() => loadConfig({ ...noSecret, NODE_ENV: "development" })).toThrow(/JWT_SECRET/);
  });

  test("a short JWT_SECRET is rejected", () => {
    expect(() => loadConfig({ ...demo, NODE_ENV: "development", JWT_SECRET: "short" })).toThrow(
      /JWT_SECRET/,
    );
  });
});
