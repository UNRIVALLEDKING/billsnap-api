// Starter-list items and bulk master-product creation through the real routes, against Postgres.
import { beforeAll, describe, expect, test } from "bun:test";
import { testDatabase, testStorage } from "../../../test/setup";
import { createApp } from "../../app";
import type { Database } from "../../platform/db/client";
import { createLogger } from "../../platform/logger";
import { Metrics } from "../../platform/metrics";
import type { Queue } from "../../platform/queue";
import { newId } from "../../shared/ids";
import { signToken } from "../auth/tokens";
import { businesses, memberships, users } from "../businesses/businesses.schema";

const SECRET = "t".repeat(40);
const dummyQueue: Queue = {
  async start() {},
  async stop() {},
  async send() {
    return "job-id";
  },
  async schedule() {},
  async work() {},
};

let app: ReturnType<typeof createApp>;
let headers: Record<string, string>;

beforeAll(async () => {
  const database: Database = await testDatabase();
  const storage = await testStorage();
  const userId = newId();
  const businessId = newId();
  await database.db
    .insert(users)
    .values({ id: userId, name: "Catalog", email: `catalog-${userId}@test.local` });
  await database.db
    .insert(businesses)
    .values({ id: businessId, name: "Catalog Business", createdBy: userId });
  await database.db.insert(memberships).values({ businessId, userId, role: "owner" });
  app = createApp({
    logger: createLogger({ level: "silent" }),
    state: { shuttingDown: false },
    db: database,
    metrics: new Metrics(),
    demo: { email: "demo@billdrop.app", password: "Demo@1234", jwtSecret: SECRET },
    data: { database, storage, queue: dummyQueue },
  });
  headers = {
    authorization: `Bearer ${await signToken(SECRET, userId, "access")}`,
    "x-business-id": businessId,
    "content-type": "application/json",
  };
});

const get = (path: string) => app.request(`/v1/inventory${path}`, { headers });
const bulk = (items: unknown[]) =>
  app.request("/v1/inventory/master-products/bulk", {
    method: "POST",
    headers,
    body: JSON.stringify({ items }),
  });

describe("starter list items", () => {
  test("unknown catalogue is 404", async () => {
    const res = await get("/trade-catalogs/nope/items");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  test("lists items, filters by category and flags items already in the list", async () => {
    const all = (await (await get("/trade-catalogs/vegetables/items")).json()) as {
      items: Array<{ name: string; category: string; unit: string; in_list: boolean }>;
    };
    expect(all.items.length).toBeGreaterThan(10);
    expect(all.items.every((i) => !i.in_list)).toBe(true);

    const first = all.items[0] as (typeof all.items)[number];
    const made = await bulk([{ display_name: first.name, category: first.category }]);
    expect(made.status).toBe(200);

    const filtered = (await (
      await get(`/trade-catalogs/vegetables/items?category=${encodeURIComponent(first.category)}`)
    ).json()) as { items: typeof all.items };
    expect(filtered.items.every((i) => i.category === first.category)).toBe(true);
    expect(filtered.items.find((i) => i.name === first.name)?.in_list).toBe(true);
    expect(filtered.items.filter((i) => i.in_list)).toHaveLength(1);
  });
});

describe("bulk master products", () => {
  test("creates new names, skips existing and duplicates, defaults unit to kg", async () => {
    const name = `Bulk item ${newId().slice(-6)}`;
    const res = await bulk([
      { display_name: name },
      { display_name: name.toUpperCase() },
      { display_name: `${name} two`, category: "Test", standard_unit: "pcs" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created: number;
      skipped: number;
      items: Array<{ display_name: string; standard_unit: string; category: string | null }>;
    };
    expect(body.created).toBe(2);
    expect(body.skipped).toBe(1);
    expect(body.items[0]?.standard_unit).toBe("kg");
    expect(body.items[1]?.category).toBe("Test");

    const again = (await (await bulk([{ display_name: name }])).json()) as {
      created: number;
      skipped: number;
    };
    expect(again).toMatchObject({ created: 0, skipped: 1 });
  });

  test("validates the body", async () => {
    expect((await bulk([])).status).toBe(422);
    expect((await bulk([{ display_name: "  " }])).status).toBe(422);
    const many = Array.from({ length: 501 }, (_, i) => ({ display_name: `X${i}` }));
    expect((await bulk(many)).status).toBe(422);
  });
});
