# Incident Resolver

Autonomous support and incident agent. Architecture, agents, and build phases are in [PLAN.md](PLAN.md); vocabulary is in [CONTEXT.md](CONTEXT.md).

## Local setup

Requires Node 22 (see `.nvmrc`), pnpm 10, and Docker.

```bash
docker compose up -d --wait   # Postgres 16 + pgvector on 5432, Grafana LGTM on 3000/3100/3200/4317/4318/9090
pnpm install
pnpm db:migrate               # creates the shoplite, portal, and knowledge schemas, the vector extension, the shoplite_reader role, and the knowledge tables
pnpm seed:incidents           # twenty ShopLite Incidents and ten Help articles, embedded through Cohere. Needs COHERE_API_KEY
pnpm test                     # unit tests, no Docker needed
pnpm test:integration         # tests that need the compose stack
pnpm lint
pnpm typecheck
```

Copy `.env.example` to `.env` to override any model name, threshold, or URL, and to set `COHERE_API_KEY`. Every tunable is read in `packages/shared/src/config.ts`.

## Layout

```
apps/            portal-api, portal-web, sentinel (added by later issues)
packages/        shared (config, db client, migrations), mcp-database, mcp-incidents, then agents and mcp-observability
infra/grafana/   dashboards provisioned into the LGTM container's Grafana
```

Tests ending in `.integration.test.ts` need Docker; everything else runs without it. The mcp-incidents MCP client test also needs `COHERE_API_KEY` and is skipped without it.

## ShopLite

The product the agent investigates lives in its own repository, [nirajk77777/shoplite](https://github.com/nirajk77777/shoplite), per [ADR-0001](docs/adr/0001-shoplite-in-a-separate-repository.md). It has no compose file: it reads `DATABASE_URL` and `OTEL_EXPORTER_OTLP_ENDPOINT` from env and uses the Postgres and LGTM containers started here, owning the `shoplite` schema. Clone it next to this repo, then in it run `pnpm install`, `pnpm db:migrate`, `pnpm db:seed`, and `pnpm dev` for the API on port 4000 and the storefront on port 4001. Its README documents the routes, test cards, a curl checkout, and the storefront's cart tag and error toast.

ShopLite sends traces, logs, and metrics to the LGTM container. The **ShopLite** Grafana dashboard at [localhost:3000/d/shoplite](http://localhost:3000/d/shoplite) shows request rate, error rate by route, p95 latency, the checkout counters, and warn-level logs with clickable trace ids. It is provisioned from `infra/grafana/` through bind mounts in `docker-compose.yml`, so edits to the JSON appear after about ten seconds without restarting.

## MCP servers

Custom MCP servers run over stdio as child processes of portal-api. Each one can also be started by hand for a quick check with an MCP inspector.

### mcp-database

`packages/mcp-database` gives the agent `describe_schema`, `run_readonly_sql`, and `propose_data_fix` over ShopLite's data.

- It connects as `shoplite_reader`, a role created by migration 0002 with `SELECT` on the `shoplite` schema and nothing else, so Postgres refuses every write whatever the tool layer does. The URL is `SHOPLITE_READONLY_DATABASE_URL`.
- Start it with `REPORTER_CUSTOMER_ID` or `REPORTER_EMAIL` for a customer Ticket. It then rejects any SELECT on a customer-owned table that does not filter by that customer, and exits if the reporter is not a ShopLite customer. Leave both unset for tester and Sentinel Tickets.
- Every result is redacted before it leaves the server: card numbers are masked entirely, and every email except the reporter's is masked.
- `run_readonly_sql` returns at most `QUERY_ROW_CAP` rows and says when it truncated.
- `propose_data_fix` never executes. It checks the statement is a single `UPDATE` or `DELETE` with a `WHERE` clause on a ShopLite table, counts the rows it would touch, and returns a Proposal for the approval gate.

```bash
REPORTER_EMAIL=ava.chen@example.com pnpm --filter @incident-resolver/mcp-database start
```

Its integration tests drive the tools through the MCP client and need ShopLite migrated and seeded.

### mcp-incidents

`packages/mcp-incidents` gives the agent the knowledge base: `search_similar_incidents`, `get_incident`, `save_incident`, and `search_help_articles`.

- Incidents and Help articles live in the `knowledge` schema (migration 0003) with a `vector(1536)` embedding each. Embeddings come from Cohere `embed-v4.0` through `@langchain/cohere`, which sends `search_document` when indexing and `search_query` when searching; the wrapper cannot set the output dimension, so 1536 is the model default.
- Both searches share one pipeline: pgvector returns the `KNOWLEDGE_SEARCH_CANDIDATES` (20) nearest rows by cosine similarity, then Cohere `rerank-v3.5` narrows them to `k` (default `KNOWLEDGE_SEARCH_TOP_K`, 3) with a relevance score from 0 to 1. The score is what Triage's Confidence is built from.
- `save_incident` is called once at Ticket close and writes the distilled record: title, symptoms, root cause, resolution, Category, source Ticket id, who resolved it, and the author. Help articles are seeded and never written by the agent.
- `pnpm seed:incidents` resets both tables and writes twenty ShopLite Incidents dated March to September 2026 by three authors, three of them about the stale cart total problem so rerank has to choose, one a red herring that shares the words but is a discount rule, plus ten Help articles. The seed data is in `packages/mcp-incidents/src/seed-data.ts`.
- It needs `COHERE_API_KEY` and refuses to start without it.

```bash
COHERE_API_KEY=... pnpm --filter @incident-resolver/mcp-incidents start
```

Its integration tests drive the tools through the MCP client and reseed the knowledge schema first, so they need Docker and the Cohere key. The pgvector store test needs only Docker, and the test that proves the documented cart_totals UPDATE against ShopLite's pricing rules needs ShopLite migrated and seeded.
