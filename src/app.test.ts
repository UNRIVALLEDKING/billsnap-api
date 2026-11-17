import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createDatabase } from "./platform/db/client";
import { createLogger } from "./platform/logger";
import { Metrics } from "./platform/metrics";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function build(db: { ping(): Promise<void> } = { ping: async () => {} }) {
  const state = { shuttingDown: false };
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    state,
    db,
    metrics: new Metrics(),
  });
  return { app, state };
}

describe("request id", () => {
  test("generates a uuid and echoes it", async () => {
    const res = await build().app.request("/health");
    expect(res.headers.get("x-request-id")).toMatch(UUID);
  });

  test("honours a valid incoming uuid", async () => {
    const id = "0b6f4a3e-7c1d-4a8e-9f23-5d1c2b3a4e5f";
    const res = await build().app.request("/health", { headers: { "X-Request-Id": id } });
    expect(res.headers.get("x-request-id")).toBe(id);
  });

  test("replaces an invalid incoming id", async () => {
    const res = await build().app.request("/health", { headers: { "X-Request-Id": "not-a-uuid" } });
    expect(res.headers.get("x-request-id")).toMatch(UUID);
  });
});

describe("probes", () => {
  test("GET /health is 200 ok with secure headers", async () => {
    const res = await build().app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("GET /ready is 200 then 503 once shutting down", async () => {
    const { app, state } = build();
    expect((await app.request("/ready")).status).toBe(200);
    state.shuttingDown = true;
    expect((await app.request("/ready")).status).toBe(503);
  });

  test("GET /ready is 503 when the database ping fails", async () => {
    const { app } = build({
      ping: async () => {
        throw new Error("down");
      },
    });
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "db_unavailable" });
  });

  test("GET /ready is 503 against an unreachable Postgres", async () => {
    const database = createDatabase({ url: "postgres://u:p@127.0.0.1:1/none", poolSize: 1 });
    try {
      expect((await build(database).app.request("/ready")).status).toBe(503);
    } finally {
      await database.close();
    }
  });
});
