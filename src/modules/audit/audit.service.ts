import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../../platform/db/client";
import { AppError } from "../../platform/errors";
import { newId } from "../../shared/ids";
import { type AuditAction, type AuditEntityType, auditLog } from "./audit.schema";

export type RecordAuditEventInput = {
  businessId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  actorId: string;
  actorName: string;
  diff?: Record<string, unknown> | null | undefined;
};

export async function recordAuditEvent(db: Executor, input: RecordAuditEventInput) {
  const id = newId();
  const [created] = await db
    .insert(auditLog)
    .values({
      id,
      businessId: input.businessId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actorId: input.actorId,
      actorName: input.actorName,
      diff: input.diff ?? null,
    })
    .returning();

  if (!created) {
    throw new AppError("audit_failed", 500, "Failed to record audit event");
  }

  return created;
}

export async function getBillHistory(db: Executor, businessId: string, billId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.businessId, businessId),
        eq(auditLog.entityType, "bill"),
        eq(auditLog.entityId, billId),
      ),
    )
    .orderBy(asc(auditLog.createdAt));

  return rows.map((r) => ({
    id: r.id,
    business_id: r.businessId,
    entity_type: r.entityType,
    entity_id: r.entityId,
    action: r.action,
    actor_id: r.actorId,
    actor_name: r.actorName,
    diff: r.diff,
    created_at: r.createdAt.toISOString(),
  }));
}
