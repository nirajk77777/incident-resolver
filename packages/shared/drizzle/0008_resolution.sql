CREATE TYPE "portal"."ticket_resolved_by" AS ENUM('agent', 'human');--> statement-breakpoint
ALTER TABLE "portal"."tickets" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "portal"."tickets" ADD COLUMN "resolved_by" "portal"."ticket_resolved_by";--> statement-breakpoint
ALTER TABLE "portal"."tickets" ADD CONSTRAINT "tickets_resolved_only_when_closed" CHECK ("portal"."tickets"."resolved_by" IS NULL OR "portal"."tickets"."status" = 'closed');