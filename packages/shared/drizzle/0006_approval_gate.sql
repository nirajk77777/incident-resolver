ALTER TABLE "portal"."approvals" ADD COLUMN "run" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "portal"."approvals" ADD COLUMN "preview" jsonb;--> statement-breakpoint
ALTER TABLE "portal"."approvals" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "portal"."approvals" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "portal"."approvals" ADD COLUMN "executed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "approvals_ticket_id_idx" ON "portal"."approvals" USING btree ("ticket_id","created_at");