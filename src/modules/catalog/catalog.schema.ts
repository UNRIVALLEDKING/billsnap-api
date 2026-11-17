import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses, users } from "../businesses/businesses.schema";

export const mergeEntity = pgEnum("merge_entity", ["vendor", "product"]);

const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    displayName: text("display_name").notNull(),
    nameNorm: text("name_norm").notNull(),
    gstin: text("gstin"),
    stateCode: text("state_code"),
    phone: text("phone"),
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => vendors.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vendors_business_live_idx").on(t.businessId).where(sql`${t.mergedIntoId} is null`),
    uniqueIndex("vendors_business_gstin_live_idx")
      .on(t.businessId, t.gstin)
      .where(sql`${t.gstin} is not null and ${t.mergedIntoId} is null`),
  ],
);

export const vendorAliases = pgTable(
  "vendor_aliases",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    aliasRaw: text("alias_raw").notNull(),
    aliasNorm: text("alias_norm").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("vendor_aliases_business_norm_uq").on(t.businessId, t.aliasNorm),
    index("vendor_aliases_vendor_idx").on(t.vendorId),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    displayName: text("display_name").notNull(),
    nameNorm: text("name_norm").notNull(),
    hsnSac: text("hsn_sac"),
    unit: text("unit"),
    masterProductId: uuid("master_product_id"),
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => products.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("products_vendor_live_idx").on(t.vendorId).where(sql`${t.mergedIntoId} is null`),
    index("products_business_idx").on(t.businessId),
  ],
);

export const productAliases = pgTable(
  "product_aliases",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    aliasRaw: text("alias_raw").notNull(),
    aliasNorm: text("alias_norm").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("product_aliases_vendor_norm_uq").on(t.vendorId, t.aliasNorm),
    index("product_aliases_product_idx").on(t.productId),
  ],
);

export const mergeEvents = pgTable(
  "merge_events",
  {
    id: uuid("id").primaryKey(),
    businessId: businessId(),
    entity: mergeEntity("entity").notNull(),
    survivorId: uuid("survivor_id").notNull(),
    mergedIds: uuid("merged_ids").array().notNull(),
    details: jsonb("details").notNull(),
    performedBy: uuid("performed_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("merge_events_business_created_idx").on(t.businessId, t.createdAt.desc())],
);
