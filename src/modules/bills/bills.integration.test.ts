// End to end against the real Postgres, MinIO and pg-boss of the compose stack, with a stub AI (never Gemini).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { TEST_DATABASE_URL, testDatabase, testStorage } from "../../../test/setup";
import { createApp } from "../../app";
import { AiError, type AiExtractResult, type AiProvider } from "../../platform/ai";
import type { Database } from "../../platform/db/client";
import { createLogger } from "../../platform/logger";
import { Metrics } from "../../platform/metrics";
import type { Queue } from "../../platform/queue";
import { createPgBossQueue } from "../../platform/queue/pgboss";
import type { Storage } from "../../platform/storage/r2";
import { newId } from "../../shared/ids";
import { DEMO_BUSINESS_ID } from "../auth/demo-login";
import { seedDemoAccount } from "../auth/demo-seed";
import { signToken } from "../auth/tokens";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { createExtractHandler } from "../extraction/extract.job";
import { billFiles, bills, extractions } from "./bills.schema";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in assertions
type Json = any;

const SECRET = "t".repeat(40);
const demo = { email: "demo@billdrop.app", password: "Demo@1234", jwtSecret: SECRET };
const logger = createLogger({ level: "silent" });

const jpeg = (seed: number) =>
  Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...Array.from({ length: 64 }, (_, i) => (i * seed) % 251),
  ]);

type Script = Array<() => unknown>;
/** Stub provider: each call pops the next scripted step (a function returning output or throwing). */
function stubAi(script: Script): AiProvider & { calls: number } {
  const ai = {
    name: "stub",
    calls: 0,
    async extractBill(): Promise<AiExtractResult> {
      ai.calls++;
      const step = script.shift();
      if (!step) throw new Error("stub AI script exhausted");
      return { output: step(), usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1 };
    },
  };
  return ai;
}

const invoice = (o: Json) => ({
  is_bill: true,
  counterparty: { name: o.vendor, gstin: o.gstin ?? null },
  invoice_number: o.invoice ?? "",
  date_iso: o.date ?? null,
  line_items: o.lines,
  grand_total: o.grand ?? null,
});

let database: Database;
let storage: Storage;
let queue: Queue;
let app: ReturnType<typeof createApp>;
let otherBusinessId: string;
let otherUserId: string;

beforeAll(async () => {
  database = await testDatabase();
  storage = await testStorage();
  queue = createPgBossQueue({ url: TEST_DATABASE_URL, log: logger });
  await queue.start();
  await database.db.delete(businesses).where(eq(businesses.id, DEMO_BUSINESS_ID)); // cascades all demo data
  await seedDemoAccount(database.db, demo.email);
  otherUserId = newId();
  otherBusinessId = newId();
  await database.db
    .insert(users)
    .values({ id: otherUserId, name: "Other", email: "other@example.test" });
  await database.db
    .insert(businesses)
    .values({ id: otherBusinessId, name: "Other Business", createdBy: otherUserId });
  await database.db
    .insert(memberships)
    .values({ businessId: otherBusinessId, userId: otherUserId, role: "owner" });
  app = createApp({
    logger,
    state: { shuttingDown: false },
    db: database,
    metrics: new Metrics(),
    demo,
    data: { database, storage, queue },
  });
});

afterAll(async () => {
  await queue?.stop();
});

describe("bills end to end (stub AI)", () => {
  test("login, upload, extract, review, confirm, duplicates, discard, merge, tenancy", async () => {
    // --- login
    const loginRes = await app.request("/v1/auth/demo-login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: JSON.stringify({ email: demo.email, password: demo.password }),
    });
    expect(loginRes.status).toBe(200);
    const login: Json = await loginRes.json();
    const businessId: string = login.memberships[0].business.id;
    expect(businessId).toBe(DEMO_BUSINESS_ID);
    expect(login.memberships[0].business).toMatchObject({ name: "Demo Business", gstin: null });
    const auth = { authorization: `Bearer ${login.access_token}`, "x-business-id": businessId };

    const call = (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { ...auth, ...(init.headers as object) } });
    const json = async (path: string, init: RequestInit = {}) => {
      const res = await call(path, init);
      return { res, body: (res.status === 204 ? null : await res.json()) as Json };
    };
    const post = (path: string, body: unknown) =>
      json(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const upload = (bytes: Uint8Array, clientRef = crypto.randomUUID(), extra: Blob[] = []) => {
      const form = new FormData();
      form.set(
        "meta",
        JSON.stringify({
          client_ref: clientRef,
          type: "purchase",
          source: "gallery",
          dropped_at: "2026-10-29T08:30:00.000Z",
        }),
      );
      form.append("files", new File([bytes], "bill.jpg", { type: "image/jpeg" }));
      for (const e of extra) form.append("files", e);
      return json("/v1/bills", { method: "POST", body: form });
    };
    const extract = async (id: string, ai: AiProvider) =>
      createExtractHandler({
        database,
        storage,
        ai,
        model: "stub-model",
        fallbackModel: "stub-fallback",
        log: logger,
        retryDelayMs: 0,
      })({ id: "job", data: { billId: id, businessId } });
    const confirmBody = (b: Json, over: Json = {}) => ({
      type: "purchase",
      vendor_id: b.vendor_id,
      vendor_name: b.vendor_name,
      invoice_number: b.invoice_number,
      bill_date: b.bill_date,
      lines: b.lines.map((l: Json) => ({
        description: l.description,
        product_id: l.product_id,
        quantity: l.quantity,
        unit: l.unit,
        rate: l.rate,
        discount: l.discount,
        printed_amount: l.printed_amount,
        hsn_sac: l.hsn_sac,
        gst_rate: l.gst_rate,
        cgst: l.cgst,
        sgst: l.sgst,
        igst: l.igst,
        cess: l.cess,
        flags: l.flags,
      })),
      ...over,
    });
    const confirmedTotal = async (id: string) =>
      (await database.db.select({ t: bills.confirmedTotal }).from(bills).where(eq(bills.id, id)))[0]
        ?.t;

    // --- guards
    expect((await app.request("/v1/bills")).status).toBe(401);
    expect(
      (await app.request("/v1/bills", { headers: { authorization: auth.authorization } })).status,
    ).toBe(400);

    // --- upload: validation, sniffing, idempotency
    const bad = await upload(new TextEncoder().encode("<html>not a bill</html>"));
    expect(bad.res.status).toBe(415);
    const bytes1 = jpeg(3);
    const clientRef = crypto.randomUUID();
    const up1 = await upload(bytes1, clientRef);
    expect(up1.res.status).toBe(201);
    expect(up1.body).toMatchObject({
      business_id: businessId,
      type: "purchase",
      status: "queued",
      vendor_name: "",
      vendor_id: null,
      invoice_number: "",
      grand_total: null,
      lines: [],
      files: [{ mime_type: "image/jpeg" }],
    });
    const bill1Id: string = up1.body.id;
    const replay = await upload(bytes1, clientRef);
    expect(replay.res.status).toBe(200);
    expect(replay.body.id).toBe(bill1Id);
    const tooMany = await upload(
      bytes1,
      undefined,
      Array.from({ length: 10 }, () => new Blob([bytes1])),
    );
    expect(tooMany.res.status).toBe(413);
    const noMeta = await json("/v1/bills", { method: "POST", body: new FormData() });
    expect(noMeta.res.status).toBe(422);
    expect(noMeta.body.code).toBe("validation_failed");

    // the extraction job was enqueued in the upload transaction
    const queued =
      await database.sql`select count(*)::int as n from pgboss.job where name = 'bill.extract' and data->>'billId' = ${bill1Id}`;
    expect(queued[0]?.n).toBe(1);

    // --- extraction: a 429 is retried, then the output is normalized and stored
    const lines1 = [
      { description: "Sugar", quantity: "5", unit: "Kgs", rate: "40", amount: "200" },
      { description: "Rice", quantity: "10", unit: "kg", rate: "60", amount: "600" },
    ];
    const ai1 = stubAi([
      () => {
        throw new AiError("rate limited", true, 429);
      },
      () =>
        invoice({
          vendor: "Ravi Traders Pvt Ltd",
          gstin: "27aapfu0939f1zv",
          invoice: "INV-1",
          date: "2026-10-20",
          lines: lines1,
          grand: "800",
        }),
    ]);
    await extract(bill1Id, ai1);
    expect(ai1.calls).toBe(2);
    const attempts = await database.db
      .select({ s: extractions.status, a: extractions.attempt, m: extractions.model })
      .from(extractions)
      .where(eq(extractions.billId, bill1Id))
      .orderBy(extractions.attempt);
    expect(attempts).toEqual([
      { s: "error", a: 1, m: "stub-model" },
      { s: "succeeded", a: 2, m: "stub-fallback" },
    ]);
    await extract(bill1Id, ai1); // re-run is a no-op (not queued/processing any more)
    expect(ai1.calls).toBe(2);

    const reviewed = (await json(`/v1/bills/${bill1Id}`)).body;
    expect(reviewed).toMatchObject({
      status: "needs_review",
      vendor_name: "Ravi Traders Pvt Ltd",
      vendor_id: null,
      gstin: "27AAPFU0939F1ZV",
      invoice_number: "INV-1",
      bill_date: "2026-10-20",
      grand_total: "800.00",
      taxes_included: false,
      flags: [],
      duplicate_of_id: null,
      failure_reason: null,
      confirmed_at: null,
    });
    expect(reviewed.lines).toHaveLength(2);
    expect(reviewed.lines[0]).toMatchObject({
      description: "Sugar",
      quantity: "5.000",
      unit: "kg",
      rate: "40.0000",
      discount: "0.00",
      printed_amount: "200.00",
      product_id: null,
    });

    // --- list + file download
    const list = (await json("/v1/bills")).body;
    expect(list.items.map((b: Json) => b.id)).toEqual([bill1Id]);
    expect(list.next_cursor).toBeNull();
    const file = await call(`/v1/bills/${bill1Id}/files/${reviewed.files[0].id}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes1);
    expect((await call(`/v1/bills/${bill1Id}/files/${newId()}`)).status).toBe(404);

    // --- confirm creates the vendor and products; a second confirm is refused
    expect((await post(`/v1/bills/${bill1Id}/confirm`, { type: "purchase" })).res.status).toBe(422);
    const c1 = await post(
      `/v1/bills/${bill1Id}/confirm`,
      confirmBody(reviewed, { vendor_name: "Ravi Traders" }),
    );
    expect(c1.res.status).toBe(200);
    expect(c1.body).toMatchObject({ status: "confirmed", vendor_name: "Ravi Traders" });
    expect(c1.body.vendor_id).toBeTruthy();
    expect(c1.body.confirmed_at).toBeTruthy();
    const vendor1Id: string = c1.body.vendor_id;
    expect(await confirmedTotal(bill1Id)).toBe("800.00");
    expect((await post(`/v1/bills/${bill1Id}/confirm`, confirmBody(c1.body))).res.status).toBe(409);
    expect((await post(`/v1/bills/${bill1Id}/discard`, {})).res.status).toBe(409);

    const vendors1 = (await json("/v1/vendors")).body;
    expect(vendors1).toEqual([
      { id: vendor1Id, name: "Ravi Traders", gstin: "27AAPFU0939F1ZV", aliases: [] },
    ]);
    const products1 = (await json("/v1/products")).body;
    expect(products1.map((p: Json) => p.name).sort()).toEqual(["Rice", "Sugar"]);
    const sugarId: string = products1.find((p: Json) => p.name === "Sugar").id;
    expect(products1.find((p: Json) => p.name === "Sugar")).toMatchObject({
      vendor_id: vendor1Id,
      unit: "kg",
      aliases: [],
    });

    // --- second bill: same file, same invoice, other spelling -> alias match + both duplicate flags
    const up2 = await upload(bytes1);
    expect(up2.res.status).toBe(201);
    const bill2Id: string = up2.body.id;
    await extract(
      bill2Id,
      stubAi([
        () =>
          invoice({
            vendor: "RAVI TRADERS PVT. LTD.",
            invoice: "inv 1",
            date: "2026-10-20",
            lines: [{ description: "SUGAR", quantity: "2", unit: "kg", rate: "40", amount: "80" }],
            grand: "80",
          }),
      ]),
    );
    const reviewed2 = (await json(`/v1/bills/${bill2Id}`)).body;
    expect(reviewed2).toMatchObject({
      status: "needs_review",
      vendor_id: vendor1Id,
      duplicate_of_id: bill1Id,
    });
    expect(reviewed2.flags).toEqual(
      expect.arrayContaining(["duplicate_file", "duplicate_invoice"]),
    );
    expect(reviewed2.lines[0].product_id).toBe(sugarId);

    // --- discard hides it from the list, restore brings it back to review
    expect((await post(`/v1/bills/${bill2Id}/discard`, {})).res.status).toBe(204);
    expect((await json("/v1/bills")).body.items.map((b: Json) => b.id)).toEqual([bill1Id]);
    expect((await json(`/v1/bills/${bill2Id}`)).body.status).toBe("discarded");
    const restored = await post(`/v1/bills/${bill2Id}/restore`, {});
    expect(restored.res.status).toBe(200);
    expect(restored.body.status).toBe("needs_review");
    expect((await post(`/v1/bills/${bill2Id}/restore`, {})).res.status).toBe(409);

    // --- confirm bill 2 against the existing vendor under a new spelling: saved as an alias
    const c2 = await post(
      `/v1/bills/${bill2Id}/confirm`,
      confirmBody(reviewed2, { vendor_name: "Ravi Trading Company" }),
    );
    expect(c2.res.status).toBe(200);
    expect(c2.body.vendor_id).toBe(vendor1Id);
    expect(c2.body.vendor_name).toBe("Ravi Traders"); // the live vendor's display name
    expect((await json("/v1/vendors")).body[0].aliases).toEqual(["Ravi Trading Company"]);
    expect(await confirmedTotal(bill2Id)).toBe("80.00");

    // --- never-extracted bill: discard + restore re-queues; a foreign product id is ignored on confirm
    const up3 = await upload(jpeg(7));
    const bill3Id: string = up3.body.id;
    expect((await post(`/v1/bills/${bill3Id}/discard`, {})).res.status).toBe(204);
    const requeued = await post(`/v1/bills/${bill3Id}/restore`, {});
    expect(requeued.body.status).toBe("queued");
    const jobs =
      await database.sql`select count(*)::int as n from pgboss.job where name = 'bill.extract' and data->>'billId' = ${bill3Id}`;
    expect(jobs[0]?.n).toBe(2);
    await extract(
      bill3Id,
      stubAi([
        () =>
          invoice({
            vendor: "Mohan Stores",
            invoice: "M-7",
            date: "2026-10-25",
            lines: [
              { description: "Sugar", quantity: "1", unit: "kg", rate: "50", amount: "50" },
              { description: "Salt", quantity: "2", unit: "pkt", rate: "10", amount: "20" },
            ],
            grand: "70",
          }),
      ]),
    );
    const reviewed3 = (await json(`/v1/bills/${bill3Id}`)).body;
    expect(reviewed3.vendor_id).toBeNull();
    const withForeign = confirmBody(reviewed3);
    withForeign.lines[0].product_id = sugarId; // belongs to Ravi, not to the new vendor
    const c3 = await post(`/v1/bills/${bill3Id}/confirm`, withForeign);
    expect(c3.res.status).toBe(200);
    const vendor2Id: string = c3.body.vendor_id;
    expect(vendor2Id).not.toBe(vendor1Id);
    expect(c3.body.lines[0].product_id).not.toBe(sugarId);
    const sugar2Id: string = c3.body.lines[0].product_id;

    // --- failure paths: not a bill, then discard/restore keeps it failed, then retry re-queues
    const up4 = await upload(jpeg(11));
    const bill4Id: string = up4.body.id;
    await extract(bill4Id, stubAi([() => ({ is_bill: false })]));
    expect((await json(`/v1/bills/${bill4Id}`)).body).toMatchObject({
      status: "failed",
      failure_reason: "not_a_bill",
    });
    await post(`/v1/bills/${bill4Id}/discard`, {});
    expect((await post(`/v1/bills/${bill4Id}/restore`, {})).body.status).toBe("failed");
    expect((await post(`/v1/bills/${bill2Id}/retry`, {})).res.status).toBe(409);
    const retried = await post(`/v1/bills/${bill4Id}/retry`, {});
    expect(retried.body).toMatchObject({ status: "queued", failure_reason: null });
    // invalid output gets one repair retry; a second failure ends as ai_error
    await extract(bill4Id, stubAi([() => "not json", () => ({ nope: true })]));
    expect((await json(`/v1/bills/${bill4Id}`)).body).toMatchObject({
      status: "failed",
      failure_reason: "ai_error",
    });
    // a bill whose AI is missing fails instead of sticking
    await post(`/v1/bills/${bill4Id}/retry`, {});
    await createExtractHandler({
      database,
      storage,
      ai: undefined,
      model: "m",
      log: logger,
    })({ id: "j", data: { billId: bill4Id, businessId } });
    expect((await json(`/v1/bills/${bill4Id}`)).body.failure_reason).toBe("ai_error");

    // --- pagination: id cursor, newest first
    const page1 = (await json("/v1/bills?limit=2")).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).toBe(page1.items[1].id);
    const page2 = (await json(`/v1/bills?limit=2&cursor=${page1.next_cursor}`)).body;
    expect(page2.items.length).toBeGreaterThan(0);
    expect(page2.items[0].id < page1.items[1].id).toBe(true);

    // --- merge vendors: Mohan -> Ravi keeps the sum of confirmed totals and collapses same-name products
    const before = await Promise.all([bill1Id, bill2Id, bill3Id].map(confirmedTotal));
    expect(before).toEqual(["800.00", "80.00", "70.00"]);
    const merged = await post("/v1/vendors/merge", {
      keep_id: vendor1Id,
      merge_ids: [vendor2Id],
      display_name: "Ravi Traders Group",
    });
    expect(merged.res.status).toBe(200);
    expect(merged.body).toMatchObject({ id: vendor1Id, name: "Ravi Traders Group" });
    expect(merged.body.aliases).toEqual(
      expect.arrayContaining(["Ravi Traders", "Ravi Trading Company", "Mohan Stores"]),
    );
    const after = await Promise.all([bill1Id, bill2Id, bill3Id].map(confirmedTotal));
    expect(after).toEqual(before);
    const vendorsAfter = (await json("/v1/vendors")).body;
    expect(vendorsAfter.map((v: Json) => v.id)).toEqual([vendor1Id]);
    const productsAfter = (await json("/v1/products")).body;
    expect(productsAfter.map((p: Json) => p.name).sort()).toEqual(["Rice", "Salt", "Sugar"]);
    expect(productsAfter.every((p: Json) => p.vendor_id === vendor1Id)).toBe(true);
    const bill3After = (await json(`/v1/bills/${bill3Id}`)).body;
    expect(bill3After.vendor_id).toBe(vendor1Id);
    expect(bill3After.lines[0].product_id).toBe(sugarId); // Mohan's Sugar collapsed into Ravi's
    expect(sugar2Id).not.toBe(sugarId);
    expect(sugarId).toBeTruthy();
    expect(
      (
        await json("/v1/vendors/merge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keep_id: vendor1Id, merge_ids: [vendor2Id], display_name: "x" }),
        })
      ).res.status,
    ).toBe(404); // already merged away
    const events =
      await database.sql`select entity, merged_ids from merge_events where business_id = ${businessId}`;
    expect(events).toHaveLength(1);

    // --- tenancy: a member of another business cannot read this one
    const otherToken = await signToken(SECRET, otherUserId, "access");
    const asOther = (businessHeader: string) =>
      app.request("/v1/bills", {
        headers: { authorization: `Bearer ${otherToken}`, "x-business-id": businessHeader },
      });
    const denied = await asOther(businessId);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as Json).code).toBe("not_a_member");
    const own = await asOther(otherBusinessId);
    expect(own.status).toBe(200);
    expect(((await own.json()) as Json).items).toEqual([]);
    expect((await asOther("not-a-uuid")).status).toBe(403);
    const peek = await app.request(`/v1/bills/${bill1Id}`, {
      headers: { authorization: `Bearer ${otherToken}`, "x-business-id": otherBusinessId },
    });
    expect(peek.status).toBe(404);

    // every file is stored under the owning business
    const stored = await database.db
      .select({ k: billFiles.storageKey })
      .from(billFiles)
      .where(eq(billFiles.billId, bill1Id));
    expect(stored[0]?.k.startsWith(`b/${businessId}/bills/${bill1Id}/`)).toBe(true);

    await database.db.delete(businesses).where(eq(businesses.id, otherBusinessId));
  }, 60_000);
});
