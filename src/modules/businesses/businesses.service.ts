import { eq } from "drizzle-orm";
import type { Database } from "../../platform/db/client";
import { AppError } from "../../platform/errors";
import { newId } from "../../shared/ids";
import { businesses, memberships } from "./businesses.schema";

export async function createBusiness(
  db: Database["db"],
  userId: string,
  data: {
    name: string;
    gstin?: string | undefined;
    state_code?: string | undefined;
    trade_type?: string | undefined;
    configured_categories?: string[] | undefined;
    name_aliases?: string[] | undefined;
  },
) {
  const businessId = newId();
  const [created] = await db
    .insert(businesses)
    .values({
      id: businessId,
      name: data.name,
      gstin: data.gstin ?? null,
      stateCode: data.state_code ?? null,
      tradeType: data.trade_type ?? "general",
      configuredCategories: data.configured_categories ?? [],
      nameAliases: data.name_aliases ?? [],
      createdBy: userId,
    })
    .returning();

  if (!created) {
    throw new AppError("business_create_failed", 500, "Failed to create business");
  }

  await db.insert(memberships).values({
    businessId,
    userId,
    role: "owner",
  });

  return {
    id: created.id,
    name: created.name,
    gstin: created.gstin,
    state_code: created.stateCode,
    trade_type: created.tradeType,
    configured_categories: created.configuredCategories,
    name_aliases: created.nameAliases,
    role: "owner" as const,
    created_at: created.createdAt.toISOString(),
  };
}

export async function getBusiness(db: Database["db"], businessId: string) {
  const [found] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);

  if (!found) {
    throw new AppError("business_not_found", 404, "Business not found");
  }

  return {
    id: found.id,
    name: found.name,
    gstin: found.gstin,
    state_code: found.stateCode,
    trade_type: found.tradeType,
    configured_categories: found.configuredCategories,
    name_aliases: found.nameAliases,
    created_at: found.createdAt.toISOString(),
  };
}

export async function updateBusiness(
  db: Database["db"],
  businessId: string,
  data: {
    name?: string | undefined;
    gstin?: string | null | undefined;
    state_code?: string | null | undefined;
    trade_type?: string | undefined;
    configured_categories?: string[] | undefined;
    name_aliases?: string[] | undefined;
  },
) {
  const values: Partial<typeof businesses.$inferInsert> = {};
  if (data.name !== undefined) values.name = data.name;
  if (data.gstin !== undefined) values.gstin = data.gstin;
  if (data.state_code !== undefined) values.stateCode = data.state_code;
  if (data.trade_type !== undefined) values.tradeType = data.trade_type;
  if (data.configured_categories !== undefined)
    values.configuredCategories = data.configured_categories;
  if (data.name_aliases !== undefined) values.nameAliases = data.name_aliases;

  if (Object.keys(values).length === 0) {
    return getBusiness(db, businessId);
  }

  const [updated] = await db
    .update(businesses)
    .set(values)
    .where(eq(businesses.id, businessId))
    .returning();

  if (!updated) {
    throw new AppError("business_not_found", 404, "Business not found");
  }

  return {
    id: updated.id,
    name: updated.name,
    gstin: updated.gstin,
    state_code: updated.stateCode,
    trade_type: updated.tradeType,
    configured_categories: updated.configuredCategories,
    name_aliases: updated.nameAliases,
    created_at: updated.createdAt.toISOString(),
  };
}

export async function listUserBusinesses(db: Database["db"], userId: string) {
  const rows = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      gstin: businesses.gstin,
      stateCode: businesses.stateCode,
      nameAliases: businesses.nameAliases,
      role: memberships.role,
      createdAt: businesses.createdAt,
    })
    .from(memberships)
    .innerJoin(businesses, eq(memberships.businessId, businesses.id))
    .where(eq(memberships.userId, userId));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    gstin: r.gstin,
    state_code: r.stateCode,
    name_aliases: r.nameAliases,
    role: r.role,
    created_at: r.createdAt.toISOString(),
  }));
}
