CREATE TYPE "portal"."approval_decision" AS ENUM('approve', 'edit', 'reject');--> statement-breakpoint
CREATE TYPE "portal"."ticket_event_type" AS ENUM('status', 'subagent_start', 'subagent_end', 'tool_call', 'tool_result', 'message', 'interrupt', 'decision', 'verdict');--> statement-breakpoint
CREATE TYPE "portal"."ticket_outcome" AS ENUM('answered', 'data_fixed', 'fix_proposed', 'escalated');--> statement-breakpoint
CREATE TYPE "portal"."ticket_source" AS ENUM('customer', 'tester', 'sentinel');--> statement-breakpoint
CREATE TYPE "portal"."ticket_status" AS ENUM('new', 'triaging', 'investigating', 'awaiting_approval', 'acting', 'closed');--> statement-breakpoint
CREATE TABLE "portal"."approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"action" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"decision" "portal"."approval_decision",
	"edited_proposal" jsonb,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "portal"."ticket_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"run" integer NOT NULL,
	"type" "portal"."ticket_event_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal"."tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "portal"."ticket_source" NOT NULL,
	"reporter_email" text,
	"trace_id" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "portal"."ticket_status" DEFAULT 'new' NOT NULL,
	"category" "knowledge"."incident_category",
	"confidence" real,
	"outcome" "portal"."ticket_outcome",
	"reply" text,
	"root_cause" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tickets_closed_carries_outcome_and_reply" CHECK (("portal"."tickets"."status" = 'closed') = ("portal"."tickets"."outcome" IS NOT NULL AND "portal"."tickets"."reply" IS NOT NULL)),
	CONSTRAINT "tickets_customer_has_reporter_email" CHECK ("portal"."tickets"."source" <> 'customer' OR "portal"."tickets"."reporter_email" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "portal"."approvals" ADD CONSTRAINT "approvals_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "portal"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal"."ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "portal"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_id_id_idx" ON "portal"."ticket_events" USING btree ("ticket_id","id");--> statement-breakpoint
CREATE INDEX "tickets_reporter_email_idx" ON "portal"."tickets" USING btree ("reporter_email");