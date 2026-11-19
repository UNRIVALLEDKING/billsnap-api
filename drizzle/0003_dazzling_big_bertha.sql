ALTER TABLE "bill_line_items" ADD COLUMN "line_kind" text DEFAULT 'goods' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD COLUMN "credit_in_stock" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD COLUMN "credit_ref_bill_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD COLUMN "credit_result" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_credit_ref_bill_id_bills_id_fk" FOREIGN KEY ("credit_ref_bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;