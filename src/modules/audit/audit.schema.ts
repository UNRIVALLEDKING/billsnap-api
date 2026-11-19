import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { businesses, users } from "../businesses/businesses.schema";

export type AuditEntityType = "bill" | "vendor" | "product";
export type AuditAction =
  | "created"
  | "extracted"
  | "confirmed"
  | "edited"
  | "discarded"
  /** A confirmed bill deleted: its stock movements are undone. */
  | "removed";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    entityType: text("entity_type").$type<AuditEntityType>().notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").$type<AuditAction>().notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    actorName: text("actor_name").notNull(),
    diff: jsonb("diff").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_business_entity_idx").on(t.businessId, t.entityId, t.createdAt),
    index("audit_log_business_idx").on(t.businessId),
  ],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
