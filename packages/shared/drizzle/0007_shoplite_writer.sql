-- The role portal-api runs an approved data fix as. It can SELECT, UPDATE and DELETE in the
-- shoplite schema and nothing else: no INSERT, no DDL, no other schema. The tool layer checks
-- that a fix is an UPDATE or DELETE with a WHERE clause and caps the rows it may touch, and
-- this role is what makes anything wider impossible whatever the tool layer does.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'shoplite_writer') THEN
    CREATE ROLE shoplite_writer LOGIN PASSWORD 'shoplite_writer';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA shoplite TO shoplite_writer;
--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shoplite TO shoplite_writer;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA shoplite GRANT SELECT, UPDATE, DELETE ON TABLES TO shoplite_writer;
--> statement-breakpoint
-- Unqualified table names resolve to shoplite, so an Incident's documented `UPDATE cart_totals` runs.
ALTER ROLE shoplite_writer SET search_path = shoplite;
--> statement-breakpoint
-- An approved fix runs in one transaction; a statement that hangs must not hold the run.
ALTER ROLE shoplite_writer SET statement_timeout = '10s';
