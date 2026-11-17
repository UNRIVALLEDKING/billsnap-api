import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, testDatabase } from "../../../test/setup";
import { createLogger } from "../logger";
import type { Queue } from "./index";
import { createPgBossQueue } from "./pgboss";

const NAME = `test.job.${Date.now()}`;
const seen: string[] = [];
let queue: Queue;

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for job");
    await Bun.sleep(100);
  }
}

describe("pg-boss queue (integration)", () => {
  beforeAll(async () => {
    await testDatabase();
    queue = createPgBossQueue({ url: TEST_DATABASE_URL, log: createLogger({ level: "silent" }) });
    await queue.start();
    await queue.work<{ tag: string }>(NAME, async (job) => void seen.push(job.data.tag), {
      pollSeconds: 0.5,
    });
  });

  afterAll(async () => {
    await queue.stop();
  });

  test("a job sent in a rolled-back transaction never runs; one in a committed transaction does", async () => {
    const { tx } = await testDatabase();

    await tx(async (t) => {
      await queue.send(NAME, { tag: "rolled-back" }, { tx: t });
      throw new Error("abort");
    }).catch(() => {});

    await tx((t) => queue.send(NAME, { tag: "committed" }, { tx: t }));
    await until(() => seen.includes("committed"));
    await Bun.sleep(1500); // give a (wrongly) surviving rolled-back job time to show up
    expect(seen).toEqual(["committed"]);
  });

  test("a job sent outside a transaction runs", async () => {
    await queue.send(NAME, { tag: "plain" }, { singletonKey: "k1", retryLimit: 1, retryDelay: 1 });
    await until(() => seen.includes("plain"));
  });

  test("startAfter delays execution", async () => {
    await queue.send(NAME, { tag: "later" }, { startAfter: new Date(Date.now() + 2000) });
    await Bun.sleep(1200);
    expect(seen).not.toContain("later");
    await until(() => seen.includes("later"));
  });
});
