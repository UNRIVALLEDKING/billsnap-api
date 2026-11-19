import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Executor } from "../../platform/db/client";
import { AppError } from "../../platform/errors";
import { newId } from "../../shared/ids";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { invites } from "./invites.schema";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type InviteRole = "accountant" | "staff";

export async function createInvite(
  db: Executor,
  businessId: string,
  userId: string,
  role: InviteRole,
) {
  const token = randomBytes(16).toString("hex");
  const tokenHash = hashToken(token);
  const id = newId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(invites).values({
    id,
    businessId,
    tokenHash,
    role,
    createdBy: userId,
    expiresAt,
  });

  return {
    id,
    token,
    url: `https://billdrop.app/i/${token}`,
    role,
    expiresAt: expiresAt.toISOString(),
    // snake_case twins, which the app reads
    business_id: businessId,
    invite_url: `https://billdrop.app/i/${token}`,
    expires_at: expiresAt.toISOString(),
    created_at: new Date().toISOString(),
  };
}

export async function getInvitePreview(db: Executor, token: string) {
  const tokenHash = hashToken(token);

  const [row] = await db
    .select({
      id: invites.id,
      businessId: invites.businessId,
      businessName: businesses.name,
      inviterName: users.name,
      inviterEmail: users.email,
      role: invites.role,
      expiresAt: invites.expiresAt,
      acceptedAt: invites.acceptedAt,
    })
    .from(invites)
    .innerJoin(businesses, eq(invites.businessId, businesses.id))
    .innerJoin(users, eq(invites.createdBy, users.id))
    .where(eq(invites.tokenHash, tokenHash))
    .limit(1);

  if (!row) {
    throw new AppError("invite_not_found", 404, "Invite not found");
  }

  if (row.acceptedAt !== null) {
    throw new AppError("invite_already_accepted", 410, "This invite has already been accepted");
  }

  const isExpired = new Date() > row.expiresAt;

  return {
    businessName: row.businessName,
    inviterName: row.inviterName || row.inviterEmail || "Unknown",
    role: row.role as InviteRole,
    isExpired,
  };
}

export async function acceptInvite(db: Executor, token: string, userId: string) {
  const tokenHash = hashToken(token);

  const [invite] = await db.select().from(invites).where(eq(invites.tokenHash, tokenHash)).limit(1);

  if (!invite) {
    throw new AppError("invite_not_found", 404, "Invite not found");
  }

  if (invite.acceptedAt !== null) {
    throw new AppError("invite_already_accepted", 410, "This invite has already been accepted");
  }

  if (new Date() > invite.expiresAt) {
    throw new AppError("invite_expired", 410, "This invite has expired");
  }

  const [existing] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.businessId, invite.businessId), eq(memberships.userId, userId)))
    .limit(1);

  if (existing) {
    throw new AppError("already_member", 409, "User is already a member of this business");
  }

  // One business per account: someone who already belongs to a business can't join another.
  const [other] = await db
    .select({ businessId: memberships.businessId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (other) {
    throw new AppError(
      "business_exists",
      409,
      "This account already belongs to a business. Use a different email to join.",
    );
  }

  await db.insert(memberships).values({
    businessId: invite.businessId,
    userId,
    role: invite.role,
  });

  await db
    .update(invites)
    .set({
      acceptedAt: new Date(),
      acceptedBy: userId,
    })
    .where(eq(invites.id, invite.id));

  return {
    businessId: invite.businessId,
    role: invite.role,
  };
}

export async function listMembersAndInvites(db: Executor, businessId: string) {
  const memberRows = await db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      createdAt: memberships.createdAt,
      name: users.name,
      email: users.email,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.businessId, businessId));

  const now = new Date();
  const inviteRows = await db
    .select({
      id: invites.id,
      role: invites.role,
      createdBy: invites.createdBy,
      expiresAt: invites.expiresAt,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .where(
      and(
        eq(invites.businessId, businessId),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now),
      ),
    );

  return {
    members: memberRows.map((m) => ({
      user_id: m.userId,
      name: m.name,
      email: m.email,
      role: m.role,
      created_at: m.createdAt.toISOString(),
    })),
    invites: inviteRows.map((i) => ({
      id: i.id,
      role: i.role,
      created_by: i.createdBy,
      expires_at: i.expiresAt.toISOString(),
      created_at: i.createdAt.toISOString(),
    })),
  };
}

export async function removeMember(
  db: Executor,
  businessId: string,
  targetUserId: string,
  requesterId: string,
) {
  const [callerMembership] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, requesterId)))
    .limit(1);

  if (callerMembership?.role !== "owner") {
    throw new AppError("forbidden", 403, "Only the business owner can remove members");
  }

  const [targetMembership] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, targetUserId)))
    .limit(1);

  if (!targetMembership) {
    throw new AppError("member_not_found", 404, "Member not found in this business");
  }

  if (targetMembership.role === "owner") {
    const owners = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.role, "owner")));

    if (owners.length <= 1) {
      throw new AppError(
        "cannot_remove_last_owner",
        400,
        "Cannot remove the only owner of the business",
      );
    }
  }

  await db
    .delete(memberships)
    .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, targetUserId)));

  return { success: true };
}

/** Pending (not accepted, not expired) invites of a business. Tokens are stored hashed, so no link. */
export async function listPendingInvites(db: Executor, businessId: string) {
  const rows = await db
    .select({
      id: invites.id,
      role: invites.role,
      createdBy: invites.createdBy,
      expiresAt: invites.expiresAt,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .where(
      and(
        eq(invites.businessId, businessId),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    );
  return rows.map((i) => ({
    id: i.id,
    business_id: businessId,
    role: i.role,
    created_by: i.createdBy,
    invite_url: null,
    expires_at: i.expiresAt.toISOString(),
    created_at: i.createdAt.toISOString(),
  }));
}

/** Deletes a business's invite that has not been accepted yet. */
export async function revokeInvite(db: Executor, businessId: string, inviteId: string) {
  const deleted = await db
    .delete(invites)
    .where(
      and(eq(invites.id, inviteId), eq(invites.businessId, businessId), isNull(invites.acceptedAt)),
    )
    .returning({ id: invites.id });
  if (deleted.length === 0) throw new AppError("not_found", 404, "Invite not found");
}
