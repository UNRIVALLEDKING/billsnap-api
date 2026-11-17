import { describe, expect, test } from "bun:test";
import { newId } from "./ids";

describe("newId", () => {
  test("is a version 7 uuid", () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("is unique and sorts by creation time across milliseconds", async () => {
    const a = newId();
    await Bun.sleep(3);
    const b = newId();
    expect(a).not.toBe(b);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, newId)).size).toBe(1000);
  });
});
