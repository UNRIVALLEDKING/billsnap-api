ALTER TABLE "bill_line_items" ADD COLUMN "stock_factor" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD COLUMN "stock_factor_source" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "extracted_parties" jsonb;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "name_aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "pack_unit" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "pack_qty" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "pack_qty_unit" text;