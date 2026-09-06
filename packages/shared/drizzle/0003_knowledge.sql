CREATE TYPE "knowledge"."incident_category" AS ENUM('question', 'user_error', 'data_issue', 'code_bug', 'infra', 'unknown');--> statement-breakpoint
CREATE TYPE "knowledge"."incident_resolved_by" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TABLE "knowledge"."help_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"embedding" vector(1536) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge"."incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"symptoms" text NOT NULL,
	"root_cause" text NOT NULL,
	"resolution" text NOT NULL,
	"category" "knowledge"."incident_category" NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"source_ticket_id" uuid,
	"resolved_by" "knowledge"."incident_resolved_by" NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "help_articles_embedding_idx" ON "knowledge"."help_articles" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "incidents_embedding_idx" ON "knowledge"."incidents" USING hnsw ("embedding" vector_cosine_ops);