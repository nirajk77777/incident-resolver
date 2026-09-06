-- The role mcp-database connects as. It can only SELECT in the shoplite schema, so any
-- write is refused by Postgres itself, whatever the tool layer does. The default
-- privileges cover tables ShopLite's own migrations create later, as long as they run
-- as postgres, which is what both repositories' DATABASE_URL defaults to.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'shoplite_reader') THEN
    CREATE ROLE shoplite_reader LOGIN PASSWORD 'shoplite_reader';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA shoplite TO shoplite_reader;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA shoplite TO shoplite_reader;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA shoplite GRANT SELECT ON TABLES TO shoplite_reader;
--> statement-breakpoint
-- Unqualified table names resolve to shoplite, so `SELECT * FROM orders` works.
ALTER ROLE shoplite_reader SET search_path = shoplite;
--> statement-breakpoint
ALTER ROLE shoplite_reader SET default_transaction_read_only = on;
--> statement-breakpoint
-- A runaway query cannot hold the agent for longer than this.
ALTER ROLE shoplite_reader SET statement_timeout = '10s';
