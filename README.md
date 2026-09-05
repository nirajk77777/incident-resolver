# Incident Resolver

Autonomous support and incident agent. Architecture, agents, and build phases are in [PLAN.md](PLAN.md); vocabulary is in [CONTEXT.md](CONTEXT.md).

## Local setup

Requires Node 22 (see `.nvmrc`), pnpm 10, and Docker.

```bash
docker compose up -d --wait   # Postgres 16 + pgvector on 5432, Grafana LGTM on 3000/3100/3200/4317/4318/9090
pnpm install
pnpm db:migrate               # creates the shoplite, portal, and knowledge schemas and the vector extension
pnpm test                     # unit tests, no Docker needed
pnpm test:integration         # tests that need the compose stack
pnpm lint
pnpm typecheck
```

Copy `.env.example` to `.env` to override any model name, threshold, or URL. Every tunable is read in `packages/shared/src/config.ts`.

## Layout

```
apps/        portal-api, portal-web, sentinel (added by later issues)
packages/    shared (config, db client, migrations), agents, mcp-* servers
```

Tests ending in `.integration.test.ts` need Docker; everything else runs without it.

## ShopLite

The product the agent investigates lives in its own repository, [nirajk77777/shoplite](https://github.com/nirajk77777/shoplite), per [ADR-0001](docs/adr/0001-shoplite-in-a-separate-repository.md). It has no compose file: it reads `DATABASE_URL` and `OTEL_EXPORTER_OTLP_ENDPOINT` from env and uses the Postgres and LGTM containers started here, owning the `shoplite` schema. Clone it next to this repo, then in it run `pnpm install`, `pnpm db:migrate`, `pnpm db:seed`, and `pnpm dev` for the API on port 4000. Its README documents the routes, test cards, and a curl checkout.
