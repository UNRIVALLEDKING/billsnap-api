import { describe, expect, test } from "bun:test";
import { testStorage } from "../../../test/setup";
import { keys } from "./r2";

const BIZ = crypto.randomUUID();
const BILL = crypto.randomUUID();

describe("key builders", () => {
  test("match the documented layout", () => {
    expect(keys.billFile("b1", "bill1", "f1", "jpg")).toBe("b/b1/bills/bill1/f1.jpg");
    expect(keys.billThumb("b1", "bill1")).toBe("b/b1/bills/bill1/thumb.jpg");
    expect(keys.export("b1", "e1", "xlsx")).toBe("b/b1/exports/e1.xlsx");
    expect(keys.businessPrefix("b1")).toBe("b/b1/");
  });
});

describe("storage (integration, MinIO)", () => {
  test("put, head, get, presign, deletePrefix", async () => {
    const storage = await testStorage();
    const key = keys.billFile(BIZ, BILL, crypto.randomUUID(), "jpg");
    const thumb = keys.billThumb(BIZ, BILL);
    const exp = keys.export(BIZ, crypto.randomUUID(), "xlsx");
    const body = new Uint8Array([1, 2, 3, 4, 5]);

    expect(await storage.headObject(key)).toBeNull();

    await storage.putObject(key, body, "image/jpeg");
    await storage.putObject(thumb, "thumb", "image/jpeg");
    await storage.putObject(exp, new Blob(["streamed"]).stream(), "application/octet-stream");

    const head = await storage.headObject(key);
    expect(head?.size).toBe(5);
    expect(head?.contentType).toBe("image/jpeg");

    const got = new Uint8Array(await new Response(await storage.getObject(key)).arrayBuffer());
    expect(got).toEqual(body);
    expect(await new Response(await storage.getObject(exp)).text()).toBe("streamed");
    await expect(storage.getObject(`${key}.missing`)).rejects.toThrow();

    const url = storage.presignGet(key, 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);

    await expect(storage.deletePrefix(`b/${BIZ}`)).rejects.toThrow();
    expect(await storage.deletePrefix(keys.businessPrefix(BIZ))).toBe(3);
    expect(await storage.headObject(key)).toBeNull();
    expect(await storage.headObject(thumb)).toBeNull();
    expect(await storage.headObject(exp)).toBeNull();
    expect(await storage.deletePrefix(keys.businessPrefix(BIZ))).toBe(0);
  });

  test("an expired presigned url is rejected", async () => {
    const storage = await testStorage();
    const key = keys.billThumb(crypto.randomUUID(), BILL);
    await storage.putObject(key, "x");
    const url = storage.presignGet(key, 1);
    await Bun.sleep(2100);
    expect((await fetch(url)).status).toBe(403);
    await storage.deletePrefix(key.replace("thumb.jpg", ""));
  });
});
