CREATE TABLE "item_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"master_product_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"per_unit" numeric(14, 6) NOT NULL,
	"approx" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_units_product_unit_uq" UNIQUE("master_product_id","unit")
);
--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD COLUMN "pack_count" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD COLUMN "pack_unit" text;--> statement-breakpoint
ALTER TABLE "item_units" ADD CONSTRAINT "item_units_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_units" ADD CONSTRAINT "item_units_master_product_id_master_products_id_fk" FOREIGN KEY ("master_product_id") REFERENCES "public"."master_products"("id") ON DELETE cascade ON UPDATE no action;