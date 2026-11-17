import type { Db } from "../../platform/db/client";
import { businesses, memberships, users } from "../businesses/businesses.schema";
import { DEMO_BUSINESS_ID, DEMO_USER_ID } from "./demo-login";

/** Upserts the demo user, "Demo Business" and the owner membership. Safe to run on every startup. */
export async function seedDemoAccount(db: Db, email: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ id: DEMO_USER_ID, name: "Demo User", email })
      .onConflictDoUpdate({ target: users.id, set: { name: "Demo User", email } });
    await tx
      .insert(businesses)
      .values({ id: DEMO_BUSINESS_ID, name: "Demo Business", createdBy: DEMO_USER_ID })
      .onConflictDoUpdate({
        target: businesses.id,
        set: { name: "Demo Business", gstin: null, stateCode: null },
      });
    await tx
      .insert(memberships)
      .values({ businessId: DEMO_BUSINESS_ID, userId: DEMO_USER_ID, role: "owner" })
      .onConflictDoUpdate({
        target: [memberships.businessId, memberships.userId],
        set: { role: "owner" },
      });
  });
}
