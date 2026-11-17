import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env";
import type { Executor } from "../../platform/db/client";
import { newId } from "../../shared/ids";
import { auditLog } from "./audit.schema";
import { getBillHistory, recordAuditEvent } from "./audit.service";

const dialect = new PgDialect();

type MockAuditStore = {
  auditLog: Array<{
    id: string;
    businessId: string;
    entityType: string;
    entityId: string;
    action: string;
    actorId: string;
    actorName: string;
    diff: Record<string, unknown> | null;
    createdAt: Date;
  }>;
};

function createMockDb(initial?: Partial<MockAuditStore>): { db: Executor; store: MockAuditStore } {
  const store: MockAuditStore = {
    auditLog: initial?.auditLog ?? [],
  };

  const db = {
    insert(table: unknown) {
      return {
        values(val: Record<string, unknown>) {
          const item = {
            id: String(val.id),
            businessId: String(val.businessId),
            entityType: String(val.entityType),
            entityId: String(val.entityId),
            action: String(val.action),
            actorId: String(val.actorId),
            actorName: String(val.actorName),
            diff: (val.diff as Record<string, unknown> | null) ?? null,
            createdAt: (val.createdAt as Date) ?? new Date(),
          };
          if (table === auditLog) {
            store.auditLog.push(item);
          }
          return {
            returning: () => [item],
            then: (resolve: (v: unknown) => void) => resolve([item]),
          };
        },
      };
    },
    select(_fields?: unknown) {
      let currentTable: unknown = null;
      let whereClause: SQL | null = null;
      let orderByClause: unknown = null;

      const builder = {
        from(table: unknown) {
          currentTable = table;
          return builder;
        },
        where(cond: SQL) {
          whereClause = cond;
          return builder;
        },
        orderBy(order: unknown) {
          orderByClause = order;
          return builder;
        },
        then(resolve: (v: unknown) => void) {
          if (currentTable === auditLog) {
            let results = [...store.auditLog];

            if (whereClause) {
              const { sql, params } = dialect.sqlToQuery(whereClause);
              // Expected: ("audit_log"."business_id" = $1 and "audit_log"."entity_type" = $2 and "audit_log"."entity_id" = $3)
              if (sql.includes("business_id") && sql.includes("entity_id")) {
                const [bizId, entityType, entityId] = params;
                results = results.filter(
                  (r) =>
                    r.businessId === bizId &&
                    r.entityType === entityType &&
                    r.entityId === entityId,
                );
              }
            }

            if (orderByClause) {
              results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
            }

            resolve(results);
          } else {
            resolve([]);
          }
        },
      };

      return builder;
    },
  } as unknown as Executor;

  return { db, store };
}

describe("Audit - Unit Tests", () => {
  describe("recordAuditEvent", () => {
    test("inserts an audit event with correct fields", async () => {
      const { db, store } = createMockDb();
      const businessId = newId();
      const billId = newId();
      const userId = newId();

      const created = await recordAuditEvent(db, {
        businessId,
        entityType: "bill",
        entityId: billId,
        action: "created",
        actorId: userId,
        actorName: "Test Actor",
        diff: {
          clientRef: "ref-123",
          type: "purchase",
          source: "camera",
        },
      });

      expect(created).toBeDefined();
      if (!created) throw new Error("created is undefined");
      expect(created.id).toBeDefined();
      expect(created.businessId).toBe(businessId);
      expect(created.entityType).toBe("bill");
      expect(created.entityId).toBe(billId);
      expect(created.action).toBe("created");
      expect(created.actorId).toBe(userId);
      expect(created.actorName).toBe("Test Actor");
      expect(created.diff).toEqual({
        clientRef: "ref-123",
        type: "purchase",
        source: "camera",
      });
      expect(created.createdAt).toBeInstanceOf(Date);

      expect(store.auditLog).toHaveLength(1);
      expect(store.auditLog[0]?.id).toBe(created.id);
    });

    test("handles diff as null when not provided", async () => {
      const { db, store } = createMockDb();
      const businessId = newId();
      const billId = newId();
      const userId = newId();

      const created = await recordAuditEvent(db, {
        businessId,
        entityType: "bill",
        entityId: billId,
        action: "discarded",
        actorId: userId,
        actorName: "Test Actor",
      });

      expect(created).toBeDefined();
      if (!created) throw new Error("created is undefined");
      expect(created.diff).toBeNull();
      expect(store.auditLog[0]?.diff).toBeNull();
    });
  });

  describe("getBillHistory", () => {
    test("retrieves bill events in chronological order (createdAt ASC)", async () => {
      const businessId = newId();
      const billId = newId();
      const otherBillId = newId();
      const userId = newId();

      const t1 = new Date(Date.now() - 3000);
      const t2 = new Date(Date.now() - 2000);
      const t3 = new Date(Date.now() - 1000);

      const { db } = createMockDb({
        auditLog: [
          // Event 2 (confirmed)
          {
            id: newId(),
            businessId,
            entityType: "bill",
            entityId: billId,
            action: "confirmed",
            actorId: userId,
            actorName: "Reviewer",
            diff: { status: "confirmed", confirmedTotal: "150.00" },
            createdAt: t2,
          },
          // Event from another bill (should be ignored)
          {
            id: newId(),
            businessId,
            entityType: "bill",
            entityId: otherBillId,
            action: "created",
            actorId: userId,
            actorName: "Creator",
            diff: null,
            createdAt: t1,
          },
          // Event 1 (created)
          {
            id: newId(),
            businessId,
            entityType: "bill",
            entityId: billId,
            action: "created",
            actorId: userId,
            actorName: "Uploader",
            diff: { type: "purchase" },
            createdAt: t1,
          },
          // Event 3 (edited)
          {
            id: newId(),
            businessId,
            entityType: "bill",
            entityId: billId,
            action: "edited",
            actorId: userId,
            actorName: "Editor",
            diff: { note: "Updated line 1 rate" },
            createdAt: t3,
          },
        ],
      });

      const history = await getBillHistory(db, businessId, billId);

      expect(history).toHaveLength(3);
      expect(history.map((h) => h.action)).toEqual(["created", "confirmed", "edited"]);
      expect(history[0]?.actor_name).toBe("Uploader");
      expect(history[1]?.actor_name).toBe("Reviewer");
      expect(history[2]?.actor_name).toBe("Editor");

      // Verifies output mapping
      expect(history[0]?.entity_type).toBe("bill");
      expect(history[0]?.entity_id).toBe(billId);
      expect(history[0]?.business_id).toBe(businessId);
      expect(typeof history[0]?.created_at).toBe("string");
      expect(new Date(String(history[0]?.created_at)).toISOString()).toBe(t1.toISOString());
    });

    test("returns empty array when bill has no history", async () => {
      const { db } = createMockDb();
      const history = await getBillHistory(db, newId(), newId());
      expect(history).toEqual([]);
    });

    test("does not return events from another business even if billId matches", async () => {
      const businessA = newId();
      const businessB = newId();
      const billId = newId();
      const userId = newId();

      const { db } = createMockDb({
        auditLog: [
          {
            id: newId(),
            businessId: businessB,
            entityType: "bill",
            entityId: billId,
            action: "created",
            actorId: userId,
            actorName: "User",
            diff: null,
            createdAt: new Date(),
          },
        ],
      });

      const history = await getBillHistory(db, businessA, billId);
      expect(history).toHaveLength(0);
    });
  });

  describe("GET /v1/bills/:id/history Route", () => {
    test("returns history for a bill", async () => {
      const businessId = newId();
      const billId = newId();
      const userId = newId();

      const { db } = createMockDb({
        auditLog: [
          {
            id: newId(),
            businessId,
            entityType: "bill",
            entityId: billId,
            action: "created",
            actorId: userId,
            actorName: "Test User",
            diff: { source: "camera" },
            createdAt: new Date(),
          },
        ],
      });

      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("business", { id: businessId, role: "owner" });
        c.set("user", { id: userId });
        await next();
      });
      app.get("/v1/bills/:id/history", async (c) => {
        const history = await getBillHistory(db, c.var.business.id, c.req.param("id"));
        return c.json({ history, items: history });
      });

      const res = await app.request(`/v1/bills/${billId}/history`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        history: Array<{ action: string; actor_name: string }>;
      };
      expect(json.history).toHaveLength(1);
      expect(json.history[0]?.action).toBe("created");
      expect(json.history[0]?.actor_name).toBe("Test User");
    });
  });
});
