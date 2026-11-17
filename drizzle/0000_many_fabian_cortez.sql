CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
--> statement-breakpoint

CREATE TYPE "public"."bill_source" AS ENUM('share', 'camera', 'gallery', 'file');--> statement-breakpoint
CREATE TYPE "public"."bill_status" AS ENUM('queued', 'processing', 'needs_review', 'failed', 'confirmed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."bill_type" AS ENUM('purchase', 'sale');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('succeeded', 'invalid_output', 'error');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'accountant', 'staff');--> statement-breakpoint
CREATE TYPE "public"."merge_entity" AS ENUM('vendor', 'product');--> statement-breakpoint
CREATE TYPE "public"."export_format" AS ENUM('xlsx', 'csv', 'tally_xml');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('queued', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."fee_basis" AS ENUM('weight', 'value');--> statement-breakpoint
CREATE TYPE "public"."fee_category" AS ENUM('transport', 'hamali', 'packaging', 'cess', 'other');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_name" text NOT NULL,
	"diff" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_files_bill_position_uq" UNIQUE("bill_id","position")
);
--> statement-breakpoint
CREATE TABLE "bill_line_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"description_raw" text NOT NULL,
	"product_id" uuid,
	"suggested_product_id" uuid,
	"master_product_id" uuid,
	"hsn_sac" text,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"rate" numeric(14, 4) NOT NULL,
	"discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"printed_amount" numeric(14, 2),
	"taxable_value" numeric(14, 2),
	"gst_rate" numeric(5, 2),
	"cgst" numeric(14, 2) DEFAULT '0' NOT NULL,
	"sgst" numeric(14, 2) DEFAULT '0' NOT NULL,
	"igst" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cess" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"allocated_fees" numeric(14, 2),
	"landed_cost" numeric(14, 2),
	"landed_unit_cost" numeric(14, 4),
	"cost_of_goods" numeric(14, 2),
	"gross_profit" numeric(14, 2),
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"bill_date" date,
	"bill_type" "bill_type",
	"vendor_id" uuid,
	"is_confirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "bill_line_items_bill_position_uq" UNIQUE("bill_id","position")
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"client_ref" uuid NOT NULL,
	"type" "bill_type" NOT NULL,
	"status" "bill_status" DEFAULT 'queued' NOT NULL,
	"source" "bill_source" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"dropped_at" timestamp with time zone NOT NULL,
	"vendor_id" uuid,
	"vendor_name_raw" text,
	"counterparty_gstin" text,
	"suggested_vendor_id" uuid,
	"invoice_number" text,
	"invoice_number_norm" text,
	"bill_date" date,
	"place_of_supply" text,
	"is_reverse_charge" boolean DEFAULT false NOT NULL,
	"subtotal" numeric(14, 2),
	"discount_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cgst_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"sgst_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"igst_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cess_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"other_charges" numeric(14, 2) DEFAULT '0' NOT NULL,
	"charges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"round_off" numeric(14, 2) DEFAULT '0' NOT NULL,
	"taxes_included" boolean DEFAULT false NOT NULL,
	"fee_split_basis" text DEFAULT 'weight' NOT NULL,
	"grand_total" numeric(14, 2),
	"confirmed_total" numeric(14, 2),
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"duplicate_of_id" uuid,
	"failure_reason" text,
	"latest_extraction_id" uuid,
	"file_sha256s" text[] DEFAULT '{}'::text[] NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bills_business_client_ref_uq" UNIQUE("business_id","client_ref")
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"attempt" smallint NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" "extraction_status" NOT NULL,
	"output" jsonb,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"gstin" text,
	"state_code" text,
	"trade_type" text DEFAULT 'general' NOT NULL,
	"configured_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_business_id_user_id_pk" PRIMARY KEY("business_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"entity" "merge_entity" NOT NULL,
	"survivor_id" uuid NOT NULL,
	"merged_ids" uuid[] NOT NULL,
	"details" jsonb NOT NULL,
	"performed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"alias_raw" text NOT NULL,
	"alias_norm" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_aliases_vendor_norm_uq" UNIQUE("vendor_id","alias_norm")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"name_norm" text NOT NULL,
	"hsn_sac" text,
	"unit" text,
	"master_product_id" uuid,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"alias_raw" text NOT NULL,
	"alias_norm" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_aliases_business_norm_uq" UNIQUE("business_id","alias_norm")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"name_norm" text NOT NULL,
	"gstin" text,
	"state_code" text,
	"phone" text,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"format" "export_format" DEFAULT 'xlsx' NOT NULL,
	"status" "export_status" DEFAULT 'queued' NOT NULL,
	"filters" jsonb NOT NULL,
	"storage_key" text,
	"file_bytes" integer,
	"bill_count" integer,
	"line_count" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fee_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"default_basis" text DEFAULT 'weight' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"master_product_id" uuid NOT NULL,
	"bill_id" uuid,
	"bill_line_item_id" uuid,
	"vendor_id" uuid,
	"transaction_type" text NOT NULL,
	"delta_weight" numeric(14, 3) NOT NULL,
	"resulting_stock_weight" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(14, 4),
	"value_delta" numeric(16, 4),
	"lot_id" uuid,
	"note" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"name_norm" text NOT NULL,
	"category" text,
	"standard_unit" text DEFAULT 'kg' NOT NULL,
	"current_stock_weight" numeric(14, 3) DEFAULT '0' NOT NULL,
	"reorder_level" numeric(14, 3),
	"avg_cost" numeric(14, 4),
	"stock_value" numeric(16, 4) DEFAULT '0' NOT NULL,
	"last_landed_cost" numeric(14, 4),
	"last_purchase_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_products_business_norm_uq" UNIQUE("business_id","name_norm")
);
--> statement-breakpoint
CREATE TABLE "stock_lots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"master_product_id" uuid NOT NULL,
	"bill_id" uuid,
	"bill_line_item_id" uuid,
	"vendor_id" uuid,
	"received_on" date,
	"qty" numeric(14, 3) NOT NULL,
	"base_unit_cost" numeric(14, 4) NOT NULL,
	"fees_per_unit" numeric(14, 4) NOT NULL,
	"landed_unit_cost" numeric(14, 4) NOT NULL,
	"remaining_qty" numeric(14, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"role" "member_role" NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_files" ADD CONSTRAINT "bill_files_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_files" ADD CONSTRAINT "bill_files_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_suggested_product_id_products_id_fk" FOREIGN KEY ("suggested_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_suggested_vendor_id_vendors_id_fk" FOREIGN KEY ("suggested_vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_duplicate_of_id_bills_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_events" ADD CONSTRAINT "merge_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_events" ADD CONSTRAINT "merge_events_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_merged_into_id_products_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_aliases" ADD CONSTRAINT "vendor_aliases_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_aliases" ADD CONSTRAINT "vendor_aliases_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_merged_into_id_vendors_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_definitions" ADD CONSTRAINT "fee_definitions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_master_product_id_master_products_id_fk" FOREIGN KEY ("master_product_id") REFERENCES "public"."master_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_products" ADD CONSTRAINT "master_products_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_master_product_id_master_products_id_fk" FOREIGN KEY ("master_product_id") REFERENCES "public"."master_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_business_entity_idx" ON "audit_log" USING btree ("business_id","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_business_idx" ON "audit_log" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "bill_line_items_product_idx" ON "bill_line_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "bill_line_items_suggested_product_idx" ON "bill_line_items" USING btree ("suggested_product_id");--> statement-breakpoint
CREATE INDEX "bill_line_items_vendor_idx" ON "bill_line_items" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "bills_business_id_desc_idx" ON "bills" USING btree ("business_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bills_vendor_idx" ON "bills" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "bills_suggested_vendor_idx" ON "bills" USING btree ("suggested_vendor_id");--> statement-breakpoint
CREATE INDEX "bills_invoice_idx" ON "bills" USING btree ("business_id","invoice_number_norm") WHERE "bills"."invoice_number_norm" is not null;--> statement-breakpoint
CREATE INDEX "bills_sha_idx" ON "bills" USING gin ("file_sha256s");--> statement-breakpoint
CREATE INDEX "extractions_bill_idx" ON "extractions" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "merge_events_business_created_idx" ON "merge_events" USING btree ("business_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "product_aliases_product_idx" ON "product_aliases" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "products_vendor_live_idx" ON "products" USING btree ("vendor_id") WHERE "products"."merged_into_id" is null;--> statement-breakpoint
CREATE INDEX "products_business_idx" ON "products" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "vendor_aliases_vendor_idx" ON "vendor_aliases" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendors_business_live_idx" ON "vendors" USING btree ("business_id") WHERE "vendors"."merged_into_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_business_gstin_live_idx" ON "vendors" USING btree ("business_id","gstin") WHERE "vendors"."gstin" is not null and "vendors"."merged_into_id" is null;--> statement-breakpoint
CREATE INDEX "exports_business_created_idx" ON "exports" USING btree ("business_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "fee_defs_business_active_idx" ON "fee_definitions" USING btree ("business_id","is_active");--> statement-breakpoint
CREATE INDEX "inventory_tx_business_product_idx" ON "inventory_transactions" USING btree ("business_id","master_product_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inventory_tx_bill_idx" ON "inventory_transactions" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "master_products_business_idx" ON "master_products" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "stock_lots_product_received_idx" ON "stock_lots" USING btree ("business_id","master_product_id","received_on","created_at");--> statement-breakpoint
CREATE INDEX "stock_lots_open_idx" ON "stock_lots" USING btree ("master_product_id","received_on","created_at") WHERE "stock_lots"."remaining_qty" > 0;--> statement-breakpoint
CREATE INDEX "invites_business_idx" ON "invites" USING btree ("business_id");