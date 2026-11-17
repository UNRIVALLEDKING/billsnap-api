import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";

export const tradeTypeEnum = z.enum([
  "vegetables",
  "fruits",
  "electronics",
  "skincare",
  "grocery",
  "general",
]);
export type TradeType = z.infer<typeof tradeTypeEnum>;

export const createBusinessBody = z.object({
  name: z.string().trim().min(1).max(200),
  gstin: z.string().trim().length(15).optional(),
  state_code: z.string().trim().length(2).optional(),
  trade_type: tradeTypeEnum.optional().default("general"),
  configured_categories: z.array(z.string().trim().min(1)).optional().default([]),
});

export const updateBusinessBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  gstin: z.string().trim().length(15).optional().nullable(),
  state_code: z.string().trim().length(2).optional().nullable(),
  trade_type: tradeTypeEnum.optional(),
  configured_categories: z.array(z.string().trim().min(1)).optional(),
});

export const memberRole = pgEnum("member_role", ["owner", "accountant", "staff"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  name: text("name"),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  gstin: text("gstin"),
  stateCode: text("state_code"),
  tradeType: text("trade_type").notNull().default("general"),
  configuredCategories: jsonb("configured_categories")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.businessId, t.userId] }),
    index("memberships_user_idx").on(t.userId),
  ],
);
