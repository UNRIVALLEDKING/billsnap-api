import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env";
import { requireAuth } from "../../http/middleware/auth";
import { errorHandler } from "../../http/middleware/error-handler";
import type { Database, Executor } from "../../platform/db/client";
import { AppError } from "../../platform/errors";
import { newId } from "../../shared/ids";
import { signToken } from "../auth/tokens";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { invitesRoutes, memberRoutes } from "./invites.routes";
import { invites } from "./invites.schema";
import {
  acceptInvite,
  createInvite,
  getInvitePreview,
  hashToken,
  type InviteRole,
  listMembersAndInvites,
  removeMember,
} from "./invites.service";

const dialect = new PgDialect();

type MockDbStore = {
  users: Array<{ id: string; name: string | null; email: string | null; createdAt: Date }>;
  businesses: Array<{ id: string; name: string; createdBy: string; createdAt: Date }>;
  memberships: Array<{
    businessId: string;
    userId: string;
    role: "owner" | "accountant" | "staff";
    createdAt: Date;
  }>;
  invites: Array<{
    id: string;
    businessId: string;
    tokenHash: string;
    role: "accountant" | "staff";
    createdBy: string;
    expiresAt: Date;
    acceptedAt: Date | null;
    acceptedBy: string | null;
    createdAt: Date;
  }>;
};

function createMockDb(initial?: Partial<MockDbStore>): { db: Executor; store: MockDbStore } {
  const store: MockDbStore = {
    users: initial?.users ?? [],
    businesses: initial?.businesses ?? [],
    memberships: initial?.memberships ?? [],
    invites: initial?.invites ?? [],
  };

  const db = {
    insert(table: unknown) {
      return {
        values(val: Record<string, unknown>) {
          const createdAt = (val.createdAt as Date) ?? new Date();
          if (table === invites) {
            store.invites.push({
              acceptedAt: null,
              acceptedBy: null,
              id: String(val.id),
              businessId: String(val.businessId),
              tokenHash: String(val.tokenHash),
              role: val.role as InviteRole,
              createdBy: String(val.createdBy),
              expiresAt: val.expiresAt as Date,
              createdAt,
            });
          } else if (table === memberships) {
            store.memberships.push({
              businessId: String(val.businessId),
              userId: String(val.userId),
              role: val.role as "owner" | "accountant" | "staff",
              createdAt,
            });
          } else if (table === businesses) {
            store.businesses.push({
              id: String(val.id),
              name: String(val.name),
              createdBy: String(val.createdBy),
              createdAt,
            });
          } else if (table === users) {
            store.users.push({
              id: String(val.id),
              name: (val.name as string | null) ?? null,
              email: (val.email as string | null) ?? null,
              createdAt,
            });
          }
          return {
            returning: () => [val],
            then: (resolve: (v: unknown) => void) => resolve([val]),
          };
        },
      };
    },
    select(_fields?: unknown) {
      let currentTable: unknown = null;
      const joins: Array<{ table: unknown; on: unknown }> = [];
      let whereClause: SQL | null = null;

      const builder = {
        from(table: unknown) {
          currentTable = table;
          return builder;
        },
        innerJoin(table: unknown, on: unknown) {
          joins.push({ table, on });
          return builder;
        },
        where(cond: SQL) {
          whereClause = cond;
          return builder;
        },
        limit(_n: number) {
          return builder;
        },
        then(resolve: (v: unknown) => void) {
          if (currentTable === invites) {
            let results = store.invites.map((inv) => {
              const b = store.businesses.find((biz) => biz.id === inv.businessId);
              const u = store.users.find((usr) => usr.id === inv.createdBy);
              return {
                id: inv.id,
                businessId: inv.businessId,
                businessName: b?.name ?? "Unknown Business",
                inviterName: u?.name ?? null,
                inviterEmail: u?.email ?? null,
                role: inv.role,
                tokenHash: inv.tokenHash,
                expiresAt: inv.expiresAt,
                acceptedAt: inv.acceptedAt,
                acceptedBy: inv.acceptedBy,
                createdBy: inv.createdBy,
                createdAt: inv.createdAt,
              };
            });

            if (whereClause) {
              const { sql, params } = dialect.sqlToQuery(whereClause);
              if (sql.includes("token_hash")) {
                results = results.filter((r) => r.tokenHash === params[0]);
              } else if (sql.includes('accepted_at" is null')) {
                const nowTime = new Date(String(params[1])).getTime();
                results = results.filter(
                  (r) =>
                    r.businessId === params[0] &&
                    r.acceptedAt === null &&
                    new Date(r.expiresAt).getTime() > nowTime,
                );
              }
            }
            resolve(results);
          } else if (currentTable === memberships) {
            let results = store.memberships.map((m) => {
              const u = store.users.find((usr) => usr.id === m.userId);
              return {
                userId: m.userId,
                businessId: m.businessId,
                role: m.role,
                createdAt: m.createdAt,
                name: u?.name ?? null,
                email: u?.email ?? null,
              };
            });

            if (whereClause) {
              const { sql, params } = dialect.sqlToQuery(whereClause);
              if (sql.includes("business_id") && sql.includes("user_id")) {
                results = results.filter(
                  (r) => r.businessId === params[0] && r.userId === params[1],
                );
              } else if (sql.includes("business_id") && sql.includes("role")) {
                results = results.filter((r) => r.businessId === params[0] && r.role === params[1]);
              } else if (sql.includes("business_id")) {
                results = results.filter((r) => r.businessId === params[0]);
              }
            }
            resolve(results);
          } else {
            resolve([]);
          }
        },
      };

      return builder;
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(cond: SQL) {
              if (table === invites) {
                const { params } = dialect.sqlToQuery(cond);
                const targetId = params[0];
                for (const inv of store.invites) {
                  if (inv.id === targetId) {
                    Object.assign(inv, values);
                  }
                }
              }
              return {
                then: (resolve: (v: unknown) => void) => resolve([]),
              };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where(cond: SQL) {
          if (table === memberships) {
            const { params } = dialect.sqlToQuery(cond);
            const [bizId, uId] = params;
            store.memberships = store.memberships.filter(
              (m) => !(m.businessId === bizId && m.userId === uId),
            );
          }
          return {
            then: (resolve: (v: unknown) => void) => resolve([]),
          };
        },
      };
    },
  } as unknown as Executor;

  return { db, store };
}

describe("Invites - Unit Tests", () => {
  describe("Token Hashing", () => {
    test("hashToken returns SHA-256 64-char hex string", () => {
      const token = "a".repeat(32);
      const hash = hashToken(token);
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("hashToken is deterministic", () => {
      const token = "test-token-123";
      expect(hashToken(token)).toBe(hashToken(token));
      expect(hashToken(token)).not.toBe(hashToken("different-token"));
    });
  });

  describe("createInvite", () => {
    test("creates an invite with 7 days expiration and valid URL", async () => {
      const { db, store } = createMockDb();
      const businessId = newId();
      const userId = newId();

      const before = Date.now();
      const result = await createInvite(db, businessId, userId, "accountant");
      const after = Date.now();

      expect(result.id).toBeDefined();
      expect(result.token).toHaveLength(32);
      expect(result.url).toBe(`https://billdrop.app/i/${result.token}`);
      expect(result.role).toBe("accountant");
      // The app reads the snake_case twins.
      expect(result.invite_url).toBe(result.url);
      expect(result.expires_at).toBe(result.expiresAt);
      expect(result.business_id).toBe(businessId);

      const expiresTime = new Date(result.expiresAt).getTime();
      const expectedMin = before + 7 * 24 * 60 * 60 * 1000;
      const expectedMax = after + 7 * 24 * 60 * 60 * 1000;
      expect(expiresTime).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresTime).toBeLessThanOrEqual(expectedMax);

      expect(store.invites).toHaveLength(1);
      const stored = store.invites[0];
      expect(stored?.tokenHash).toBe(hashToken(result.token));
      expect(stored?.businessId).toBe(businessId);
      expect(stored?.createdBy).toBe(userId);
      expect(stored?.role).toBe("accountant");
    });
  });

  describe("getInvitePreview", () => {
    test("returns business and inviter details for active invite", async () => {
      const businessId = newId();
      const inviterId = newId();
      const token = "b".repeat(32);

      const { db } = createMockDb({
        users: [
          { id: inviterId, name: "Alice Owner", email: "alice@test.local", createdAt: new Date() },
        ],
        businesses: [
          { id: businessId, name: "Acme Groceries", createdBy: inviterId, createdAt: new Date() },
        ],
        invites: [
          {
            id: newId(),
            businessId,
            tokenHash: hashToken(token),
            role: "staff",
            createdBy: inviterId,
            expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
            acceptedAt: null,
            acceptedBy: null,
            createdAt: new Date(),
          },
        ],
      });

      const preview = await getInvitePreview(db, token);
      expect(preview.businessName).toBe("Acme Groceries");
      expect(preview.inviterName).toBe("Alice Owner");
      expect(preview.role).toBe("staff");
      expect(preview.isExpired).toBe(false);
    });

    test("flags isExpired: true when invite has passed expiration", async () => {
      const businessId = newId();
      const inviterId = newId();
      const token = "c".repeat(32);

      const { db } = createMockDb({
        users: [
          { id: inviterId, name: "Alice Owner", email: "alice@test.local", createdAt: new Date() },
        ],
        businesses: [
          { id: businessId, name: "Acme Groceries", createdBy: inviterId, createdAt: new Date() },
        ],
        invites: [
          {
            id: newId(),
            businessId,
            tokenHash: hashToken(token),
            role: "accountant",
            createdBy: inviterId,
            expiresAt: new Date(Date.now() - 1000),
            acceptedAt: null,
            acceptedBy: null,
            createdAt: new Date(),
          },
        ],
      });

      const preview = await getInvitePreview(db, token);
      expect(preview.isExpired).toBe(true);
    });

    test("throws 404 for unknown token", async () => {
      const { db } = createMockDb();
      expect(getInvitePreview(db, "nonexistent-token")).rejects.toThrow(AppError);
    });

    test("throws 410 for already accepted invite", async () => {
      const businessId = newId();
      const inviterId = newId();
      const token = "d".repeat(32);

      const { db } = createMockDb({
        users: [
          { id: inviterId, name: "Alice Owner", email: "alice@test.local", createdAt: new Date() },
        ],
        businesses: [
          { id: businessId, name: "Acme Groceries", createdBy: inviterId, createdAt: new Date() },
        ],
        invites: [
          {
            id: newId(),
            businessId,
            tokenHash: hashToken(token),
            role: "staff",
            createdBy: inviterId,
            expiresAt: new Date(Date.now() + 10000),
            acceptedAt: new Date(),
            acceptedBy: newId(),
            createdAt: new Date(),
          },
        ],
      });

      expect(getInvitePreview(db, token)).rejects.toThrow("already been accepted");
    });
  });

  describe("acceptInvite", () => {
    test("successfully accepts valid invite and adds membership", async () => {
      const businessId = newId();
      const inviterId = newId();
      const newUserId = newId();
      const token = "e".repeat(32);

      const { db, store } = createMockDb({
        users: [
          { id: inviterId, name: "Alice Owner", email: "alice@test.local", createdAt: new Date() },
          { id: newUserId, name: "Bob Accountant", email: "bob@test.local", createdAt: new Date() },
        ],
        businesses: [
          { id: businessId, name: "Acme Groceries", createdBy: inviterId, createdAt: new Date() },
        ],
        invites: [
          {
            id: newId(),
            businessId,
            tokenHash: hashToken(token),
            role: "accountant",
            createdBy: inviterId,
            expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
            acceptedAt: null,
            acceptedBy: null,
            createdAt: new Date(),
          },
        ],
      });

      const res = await acceptInvite(db, token, newUserId);
      expect(res.businessId).toBe(businessId);
      expect(res.role).toBe("accountant");

      expect(store.memberships).toHaveLength(1);
      expect(store.memberships[0]).toMatchObject({
        businessId,
        userId: newUserId,
        role: "accountant",
      });

      expect(store.invites[0]?.acceptedAt).toBeInstanceOf(Date);
      expect(store.invites[0]?.acceptedBy).toBe(newUserId);
    });

    test("throws 410 when accepting expired invite", async () => {
      const businessId = newId();
      const token = "f".repeat(32);

      const { db } = createMockDb({
        invites: [
          {
            id: newId(),
            businessId,
            tokenHash: hashToken(token),
            role: "accountant",
            createdBy: newId(),
            expiresAt: new Date(Date.now() - 5000),
            acceptedAt: null,
            acceptedBy: null,
            createdAt: new Date(),
          },
        ],
      });

      expect(acceptInvite(db, token, newId())).rejects.toThrow("expired");
    });

    test("throws 409 when user is already a member", async () => {
      const businessId = newId();
      const existingUserId = newId();
      const token = "g".repeat(32);

      const { db } = createMockDb({
        memberships: [
          {
            businessId,
            userId: existingUserId,
            role: "owner",
            createdAt: new Date(),
          },
        ],
        invites: [
          {
            id: newId(),
            businessId,
            tokenHash: hashToken(token),
            role: "staff",
            createdBy: existingUserId,
            expiresAt: new Date(Date.now() + 50000),
            acceptedAt: null,
            acceptedBy: null,
            createdAt: new Date(),
          },
        ],
      });

      expect(acceptInvite(db, token, existingUserId)).rejects.toThrow("already a member");
    });
  });

  describe("listMembersAndInvites", () => {
    test("returns active members and pending unexpired invites", async () => {
      const businessId = newId();
      const ownerId = newId();
      const staffId = newId();

      const { db } = createMockDb({
        users: [
          { id: ownerId, name: "Owner User", email: "owner@test.local", createdAt: new Date() },
          { id: staffId, name: "Staff User", email: "staff@test.local", createdAt: new Date() },
        ],
        memberships: [
          { businessId, userId: ownerId, role: "owner", createdAt: new Date() },
          { businessId, userId: staffId, role: "staff", createdAt: new Date() },
        ],
        invites: [
          {
            id: newId(),
            businessId,
            tokenHash: "hash-1",
            role: "accountant",
            createdBy: ownerId,
            expiresAt: new Date(Date.now() + 100000),
            acceptedAt: null,
            acceptedBy: null,
            createdAt: new Date(),
          },
          {
            id: newId(),
            businessId,
            tokenHash: "hash-expired",
            role: "staff",
            createdBy: ownerId,
            expiresAt: new Date(Date.now() - 1000),
            acceptedAt: null,
            acceptedBy: null,
            createdAt: new Date(),
          },
        ],
      });

      const result = await listMembersAndInvites(db, businessId);
      expect(result.members).toHaveLength(2);
      expect(result.members.map((m) => m.role)).toEqual(["owner", "staff"]);
      expect(result.invites).toHaveLength(1);
      expect(result.invites[0]?.role).toBe("accountant");
    });
  });

  describe("removeMember", () => {
    test("owner can remove a staff member", async () => {
      const businessId = newId();
      const ownerId = newId();
      const staffId = newId();

      const { db, store } = createMockDb({
        memberships: [
          { businessId, userId: ownerId, role: "owner", createdAt: new Date() },
          { businessId, userId: staffId, role: "staff", createdAt: new Date() },
        ],
      });

      const res = await removeMember(db, businessId, staffId, ownerId);
      expect(res.success).toBe(true);
      expect(store.memberships).toHaveLength(1);
      expect(store.memberships[0]?.userId).toBe(ownerId);
    });

    test("non-owner cannot remove members", async () => {
      const businessId = newId();
      const staff1 = newId();
      const staff2 = newId();

      const { db } = createMockDb({
        memberships: [
          { businessId, userId: staff1, role: "staff", createdAt: new Date() },
          { businessId, userId: staff2, role: "staff", createdAt: new Date() },
        ],
      });

      expect(removeMember(db, businessId, staff2, staff1)).rejects.toThrow(
        "Only the business owner",
      );
    });

    test("cannot remove the last owner of a business", async () => {
      const businessId = newId();
      const soleOwner = newId();

      const { db } = createMockDb({
        memberships: [{ businessId, userId: soleOwner, role: "owner", createdAt: new Date() }],
      });

      expect(removeMember(db, businessId, soleOwner, soleOwner)).rejects.toThrow(
        "Cannot remove the only owner",
      );
    });
  });

  describe("HTTP Routes", () => {
    const JWT_SECRET = "test-jwt-secret-for-invites-testing-32-chars";

    function setupApp(storeInitial?: Partial<MockDbStore>) {
      const { db, store } = createMockDb(storeInitial);
      const fakeDb = { db } as unknown as Database;

      const app = new Hono<AppEnv>();
      app.use("/v1/businesses", requireAuth(JWT_SECRET));
      app.use("/v1/businesses/*", requireAuth(JWT_SECRET));
      app.route("/v1/invites", invitesRoutes({ database: fakeDb, jwtSecret: JWT_SECRET }));
      app.route("/v1/businesses", memberRoutes(fakeDb));
      app.onError(errorHandler);

      return { app, store, db };
    }

    test("POST /v1/invites allows owner to create invite", async () => {
      const businessId = newId();
      const ownerId = newId();

      const { app } = setupApp({
        memberships: [{ businessId, userId: ownerId, role: "owner", createdAt: new Date() }],
      });

      const token = await signToken(JWT_SECRET, ownerId, "access");
      const res = await app.request("/v1/invites", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-business-id": businessId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: "accountant" }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as { token: string; role: string; url: string };
      expect(json.token).toBeDefined();
      expect(json.role).toBe("accountant");
      expect(json.url).toContain("https://billdrop.app/i/");
    });

    test("POST /v1/invites rejects non-owner with 403", async () => {
      const businessId = newId();
      const staffId = newId();

      const { app } = setupApp({
        memberships: [{ businessId, userId: staffId, role: "staff", createdAt: new Date() }],
      });

      const token = await signToken(JWT_SECRET, staffId, "access");
      const res = await app.request("/v1/invites", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-business-id": businessId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: "accountant" }),
      });

      expect(res.status).toBe(403);
    });

    test("GET /v1/invites/:token is public and returns preview", async () => {
      const businessId = newId();
      const inviterId = newId();
      const token = "secret-token-12345";

      const { app } = setupApp({
        users: [
          {
            id: inviterId,
            name: "Inviter Name",
            email: "inviter@test.local",
            createdAt: new Date(),
          },
        ],
        businesses: [{ id: businessId, name: "Shop", createdBy: inviterId, createdAt: new Date() }],
        invites: [
          {
            id: newId(),
            businessId,
            tokenHash: hashToken(token),
            role: "staff",
            createdBy: inviterId,
            expiresAt: new Date(Date.now() + 100000),
            acceptedAt: null,
            acceptedBy: null,
            createdAt: new Date(),
          },
        ],
      });

      const res = await app.request(`/v1/invites/${token}`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        businessName: string;
        inviterName: string;
        role: string;
        isExpired: boolean;
      };
      expect(json.businessName).toBe("Shop");
      expect(json.inviterName).toBe("Inviter Name");
      expect(json.role).toBe("staff");
      expect(json.isExpired).toBe(false);
    });

    test("POST /v1/invites/:token/accept requires auth and joins business", async () => {
      const businessId = newId();
      const inviterId = newId();
      const joinerId = newId();
      const token = "secret-token-join";

      const { app, store } = setupApp({
        users: [
          { id: inviterId, name: "Inviter", email: "inviter@test.local", createdAt: new Date() },
          { id: joinerId, name: "Joiner", email: "joiner@test.local", createdAt: new Date() },
        ],
        businesses: [{ id: businessId, name: "Shop", createdBy: inviterId, createdAt: new Date() }],
        invites: [
          {
            id: newId(),
            businessId,
            tokenHash: hashToken(token),
            role: "staff",
            createdBy: inviterId,
            expiresAt: new Date(Date.now() + 100000),
            acceptedAt: null,
            acceptedBy: null,
            createdAt: new Date(),
          },
        ],
      });

      const authToken = await signToken(JWT_SECRET, joinerId, "access");
      const res = await app.request(`/v1/invites/${token}/accept`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; businessId: string; role: string };
      expect(json.success).toBe(true);
      expect(json.businessId).toBe(businessId);
      expect(json.role).toBe("staff");

      expect(store.memberships).toHaveLength(1);
      expect(store.memberships[0]?.userId).toBe(joinerId);
    });

    test("GET /v1/businesses/:id/members lists members for business member", async () => {
      const businessId = newId();
      const userId = newId();

      const { app } = setupApp({
        users: [{ id: userId, name: "Member User", email: "m@test.local", createdAt: new Date() }],
        memberships: [{ businessId, userId, role: "accountant", createdAt: new Date() }],
      });

      const token = await signToken(JWT_SECRET, userId, "access");
      const res = await app.request(`/v1/businesses/${businessId}/members`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { members: Array<{ user_id: string }> };
      expect(json.members).toHaveLength(1);
      expect(json.members[0]?.user_id).toBe(userId);
    });

    test("DELETE /v1/businesses/:id/members/:userId allows owner to remove member", async () => {
      const businessId = newId();
      const ownerId = newId();
      const staffId = newId();

      const { app, store } = setupApp({
        memberships: [
          { businessId, userId: ownerId, role: "owner", createdAt: new Date() },
          { businessId, userId: staffId, role: "staff", createdAt: new Date() },
        ],
      });

      const token = await signToken(JWT_SECRET, ownerId, "access");
      const res = await app.request(`/v1/businesses/${businessId}/members/${staffId}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.status).toBe(200);
      expect(store.memberships).toHaveLength(1);
    });
  });
});
