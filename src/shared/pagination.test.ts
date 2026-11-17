import { describe, expect, test } from "bun:test";
import { AppError } from "../platform/errors";
import { decodeCursor, encodeCursor, parseLimit } from "./pagination";

const cursor = {
  createdAt: "2026-04-01T10:20:30.123Z",
  id: "0b6f4a3e-7c1d-4a8e-9f23-5d1c2b3a4e5f",
};

describe("cursor", () => {
  test("round trips and is url-safe", () => {
    const s = encodeCursor(cursor);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(s)).toEqual(cursor);
  });

  test("garbage is a 400", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    const bad = ["!!!", "", b64("{}"), b64('["x","y"]'), b64('["2026-04-01T00:00:00Z"]')];
    for (const raw of bad) {
      try {
        decodeCursor(raw);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).status).toBe(400);
      }
    }
  });
});

describe("parseLimit", () => {
  test("defaults and bounds", () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("200")).toBe(200);
    for (const bad of ["0", "201", "1.5", "abc"]) expect(() => parseLimit(bad)).toThrow(AppError);
  });
});
