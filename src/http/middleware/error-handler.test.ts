import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env";
import { AppError } from "../../platform/errors";
import { errorHandler, notFoundHandler } from "./error-handler";

function build() {
  const app = new Hono<AppEnv>();
  app.get("/app-error", () => {
    throw new AppError("bill_locked", 409, "Bill is locked");
  });
  app.get("/boom", () => {
    throw new Error("secret db password in message");
  });
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  return app;
}

describe("error handler", () => {
  test("AppError becomes problem+json with its code and status", async () => {
    const res = await build().request("/app-error");
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({
      type: "urn:billdrop:problem:bill_locked",
      title: "Conflict",
      status: 409,
      code: "bill_locked",
      detail: "Bill is locked",
    });
  });

  test("unknown error becomes 500 internal without leaking details", async () => {
    const res = await build().request("/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ status: 500, code: "internal" });
    expect(text).not.toContain("secret");
    expect(text).not.toContain("stack");
  });

  test("unknown route is a 404 problem", async () => {
    const res = await build().request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });
});
