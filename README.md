# Incident Resolver

Autonomous support and incident agent. Architecture, agents, and build phases are in [PLAN.md](PLAN.md); vocabulary is in [CONTEXT.md](CONTEXT.md).

## Local setup

Requires Node 22 (see `.nvmrc`), pnpm 10, and Docker.

```bash
docker compose up -d --wait   # Postgres 16 + pgvector on 5432, Grafana LGTM on 3000/3100/3200/4317/4318/9090
pnpm install
pnpm db:migrate               # creates the shoplite, portal, and knowledge schemas, the vector extension, the shoplite_reader role, and the knowledge tables
pnpm seed:incidents           # twenty ShopLite Incidents and ten Help articles, embedded through Cohere. Needs COHERE_API_KEY
pnpm prompts:sync             # push the agents' prompts to Langfuse prompt management. Optional; needs the Langfuse keys
pnpm test                     # unit tests, no Docker needed
pnpm test:integration         # tests that need the compose stack
pnpm lint
pnpm typecheck
```

Copy `.env.example` to `.env` to override any model name, threshold, or URL, and to set `COHERE_API_KEY`. Every tunable is read in `packages/shared/src/config.ts`.

## Layout

```
apps/            portal-api (Tickets, timeline, SSE), portal-web (the Reviewer's portal), sentinel (added by a later issue)
packages/        shared (config, db client, migrations), mcp-database, mcp-incidents, mcp-observability, agents (Resolver, subagents, prompts, CLI)
infra/grafana/   dashboards provisioned into the LGTM container's Grafana
```

Tests ending in `.integration.test.ts` need Docker; everything else runs without it. The mcp-incidents MCP client test also needs `COHERE_API_KEY` and is skipped without it. The mcp-observability MCP client test also needs ShopLite running, since it generates the declined checkout it then looks for. The agents end-to-end test needs `OPENAI_API_KEY`, `COHERE_API_KEY` and a running ShopLite, and is skipped without the keys; its wiring test needs only Docker.

## ShopLite

The product the agent investigates lives in its own repository, [nirajk77777/shoplite](https://github.com/nirajk77777/shoplite), per [ADR-0001](docs/adr/0001-shoplite-in-a-separate-repository.md). It has no compose file: it reads `DATABASE_URL` and `OTEL_EXPORTER_OTLP_ENDPOINT` from env and uses the Postgres and LGTM containers started here, owning the `shoplite` schema. Clone it next to this repo, then in it run `pnpm install`, `pnpm db:migrate`, `pnpm db:seed`, and `pnpm dev` for the API on port 4000 and the storefront on port 4001. Its README documents the routes, test cards, a curl checkout, and the storefront's cart tag and error toast.

ShopLite sends traces, logs, and metrics to the LGTM container. The **ShopLite** Grafana dashboard at [localhost:3000/d/shoplite](http://localhost:3000/d/shoplite) shows request rate, error rate by route, p95 latency, the checkout counters, and warn-level logs with clickable trace ids. It is provisioned from `infra/grafana/` through bind mounts in `docker-compose.yml`, so edits to the JSON appear after about ten seconds without restarting.

## Portal API

`apps/portal-api` is the Fastify service that owns the `portal` schema: Tickets from customers, testers and Sentinel, their timelines, and the approval gate's tables. `pnpm portal` starts it on `PORTAL_API_PORT` (5000).

| Route | What it does |
|-------|--------------|
| `POST /tickets` | Opens a Ticket from `source`, `reporterEmail`, `traceId`, `title`, `body`, and starts its run. A customer Ticket without a Reporter email is a 400. |
| `GET /tickets` | The queue, newest first. |
| `GET /tickets/:id` | One Ticket with its status, Category, Confidence, Outcome, Reply, and root cause. |
| `GET /tickets/:id/events` | The live timeline as SSE. |
| `GET /reporters/:email/tickets` | What the storefront's "My tickets" page reads: one Reporter's Tickets and Replies. |
| `GET /config` | What portal-web needs from the portal's configuration: the Resolver in use, and the Grafana and Langfuse base URLs its trace links are built from. |
| `GET /health` | Liveness, and which Resolver is selected. |

A Ticket moves `new` → `triaging` → `investigating` → `awaiting_approval` → `acting` → `closed`, and `closed` always carries exactly one Outcome and one Reply, which a check constraint on the table enforces. The lifecycle is derived in the portal from the Resolver's stream, never inside the agent. A run that fails or times out (`RUN_TIMEOUT_MS`) closes the Ticket as `escalated` with the holding Reply rather than leaving it stuck.

Each entry of the timeline is a `portal.ticket_events` row, written as the run streams and published to every open SSE connection. Frames are unnamed, so `new EventSource(url).onmessage` receives the whole timeline and reads the kind of entry off `type` in the data: `subagent_start`, `subagent_end`, `tool_call`, `tool_result`, `message`, `interrupt`, `decision`, `verdict`, or the portal's own `status`. The frame id is the entry's sequence, so a reloaded page sends `Last-Event-ID` (or `?lastEventId=`) and gets exactly what it missed before the stream goes live. Entries carry the run number, counting re-runs of a Ticket from 1. Tickets run concurrently, one independent run each.

`RESOLVER` chooses what investigates a Ticket, through one `TicketResolver` seam that nothing downstream can see past.

- `fake` is a scripted stand-in that emits Triage and Investigator events, a tool call and its result, a message, and a fixed Verdict, with `FAKE_RESOLVER_STEP_DELAY_MS` between them: the whole lifecycle is exercisable over HTTP with no model and no API key.
- `real` is the Resolver from `packages/agents`. It needs `OPENAI_API_KEY` and `COHERE_API_KEY`, and everything the CLI needs: the compose stack, ShopLite migrated, seeded and running, and `pnpm seed:incidents` done. Each Ticket gets its own MCP servers, scoped to the Reporter, and its own LangGraph thread; the models, the prompts and the checkpointer are the portal's and are shared across runs. Every LangChain event the run produces becomes a timeline entry: a `task` call opens a subagent card and its return closes it, and every other tool call and result is a card of its own, nested subagent tools included.

A traced run reports the Langfuse trace it is writing to before it does any work. That is not a timeline entry — it goes on the Ticket as `langfuseTraceId`, so the portal can link to the trace of whichever run is the latest.

## Portal web

`apps/portal-web` is the Reviewer's portal: a Vite React app on 5001 that reads portal-api through a dev-server proxy on `/api`, so requests are same-origin and the API needs no CORS.

```bash
pnpm portal                                        # portal-api on 5000
pnpm --filter @incident-resolver/portal-web dev     # portal-web on 5001
```

`pnpm dev` starts both, along with every other package that has a dev script.

- **Queue** (`/tickets`): every Ticket newest first, with its status, Source, Category, Outcome and Confidence. It re-reads itself every few seconds, so a Ticket filed elsewhere appears without a reload.
- **Ticket** (`/tickets/:id`): the live Timeline, as a transcript. One rail down the left with the elapsed offset in the gutter and a marker per entry: subagent start and end, tool call and result, message, interrupt, Decision, Verdict, and the portal's own status moves as rules across the rail. Payloads are collapsed by default and Evidence is set in monospace; the Verdict card carries the Reply. The panel beside it fills in with the Outcome, Confidence, root cause, Reply and Evidence as the run reaches them.
- **File a ticket** (`/tickets/new`): a summary, what went wrong, optional steps to reproduce, and an optional ShopLite trace id. Filing it starts the run and opens its Timeline.
- Each Ticket links out to the two traces it carries: the Resolver run in Langfuse, and the ShopLite request in Grafana Explore against Tempo. Both appear only once there is a trace id to point at, and both base URLs come from `GET /config`.

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

### mcp-observability

`packages/mcp-observability` gives the agent ShopLite's telemetry in the LGTM container: `search_logs` over Loki, `get_trace` over Tempo, `query_metrics` and `get_error_rate` over Prometheus, and `list_recent_errors` across all three.

- `search_logs` takes free text, a window such as `15m`, a level meaning that level and above, and an optional trace id, and builds the LogQL itself: `{service_name="shoplite-api"} |~ "(?i)text" | detected_level=~"warn|error|fatal" | trace_id="..."`. It looks back one hour by default, or a day when a trace id is given, since the request behind a Ticket may be hours old. Lines come back newest first with their level, trace and span ids, and the structured fields pino attached, minus the OTel resource noise. At most `LOG_LINE_CAP` lines come back and the result says when it truncated.
- `get_trace` fetches the OTLP trace from Tempo and reduces it to the root span, route, method, status code, every span in start order with hex ids and plain attributes, and the spans that ended in error with their exception events.
- `query_metrics` runs any PromQL: evaluated now without a window, or as a range over the window with about thirty points per series.
- `get_error_rate` counts one route's responses by status code over the window from the OTel HTTP histogram, as the counter's growth since the start of the window rather than `increase()`, so the count is exact and a 60s window works with ShopLite's 10s export interval. `errorRate` counts every 4xx and 5xx, so a declined card (402) counts; `serverErrorRate` counts 5xx only. Which ratio Sentinel thresholds is Sentinel's decision.
- `list_recent_errors` is the starting point for a Ticket without a trace id: routes that returned errors with their rates, `checkout_errors_total` by reason, and the warn-and-above lines grouped by message with trace ids to follow. If one store is unreachable the other signals still come back and `warnings` says what is missing.
- Every result is redacted before it leaves the server: card numbers are masked entirely, and every email except the reporter's is masked. Start it with `REPORTER_EMAIL` for a customer Ticket; leave it unset for tester and Sentinel Tickets.
- `SHOPLITE_SERVICE_NAME` (default `shoplite-api`) is the `service_name` label in Loki and the `job` label in Prometheus.

```bash
REPORTER_EMAIL=ava.chen@example.com pnpm --filter @incident-resolver/mcp-observability start
```

Its integration tests generate one declined checkout against a running ShopLite, then drive every tool through the MCP client, polling the Prometheus-backed tools until ShopLite's next metric export lands.

## Resolver

`packages/agents` is the agent itself: the Resolver deep agent, its Triage subagent and three Investigators, the prompts, and a CLI that runs one Ticket and prints the Verdict.

- The Resolver is a Deep Agents JS agent on `gpt-5.4` with a Postgres checkpointer in the `portal` schema, one LangGraph thread per run. Triage and the three Investigators are subagents on `gpt-5.4-mini`, reached through the `task` tool. Every model name comes from `packages/shared/src/config.ts`.
- Triage's only tool is `search_help_articles`. It returns Zod-structured output: Category (`question`, `user_error`, `data_issue`, `code_bug`, `infra`, `unknown`), severity, component, hypothesis, Confidence, the matching Help article ids, and the best article's text.
- Fast path: a `question` with a Help article at or above `CONFIDENCE_THRESHOLD` is answered from the article with Outcome `answered` and no Investigator run.
- Anything else fans out to all three Investigators in one turn, so their spans overlap in the trace instead of queueing: the **Log Investigator** over the mcp-observability tools (the trace and log lines behind the request, and whether the route is failing for everyone), the **Data Investigator** over the mcp-database tools (the Reporter's rows, and a data fix Proposal when one is wrong), and the **Incident Historian** over the mcp-incidents read tools (past Incidents with their documented resolution, after Cohere rerank). Each returns a short Evidence summary whose every entry carries its provenance.
- The procedure is enforced in code, not only in the prompt. A middleware on the `task` tool refuses any subagent that is not declared, refuses an Investigator before Triage has run or when the fast path applies, refuses a second run of one that has already reported, and appends Triage's hypothesis to each Investigator's brief as focus — worded so it narrows where an Investigator looks first and never licenses it to skip its own source. A refused delegation comes back as a tool error saying what to do instead, so the run continues. The run report flags a run that investigated with fewer than three, or launched them in separate turns.
- The run ends with a Verdict in a Zod response format: Outcome, Category, Confidence, root cause, Evidence references, and the Reply. A Verdict below the threshold is escalated in code, whatever the model wrote.
- Prompts are markdown in `packages/agents/prompts/`, one per agent, with `{{confidenceThreshold}}` filled from config. `pnpm prompts:sync` pushes them to Langfuse prompt management under `LANGFUSE_PROMPT_LABEL` (default `production`), skipping any whose text already matches the labelled version. At startup the agent fetches each prompt by name and label and falls back to the repository file whenever Langfuse is unconfigured, has no version under that label, or is unreachable, so a run never waits on the network. Which version each prompt came from is on the trace as `prompt.<name>` and in the CLI's run report.
- Tracing is Langfuse v5: a `LangfuseSpanProcessor` in the OTel Node SDK plus the LangChain `CallbackHandler` on every invoke. The session id is the Ticket id, tags carry the Source, the model names, and the Category, and the subagent and tool spans nest under the run. Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`; without them the run is untraced and every prompt comes from its file. `LANGFUSE_BASE_URL` defaults to Langfuse Cloud.
- The MCP servers are spawned per run as stdio children from their own package directories, the way portal-api will spawn them. For a customer Ticket the database and observability servers are started with the Reporter's email, so every query is scoped to that customer and every other email is masked.

The CLI takes a Ticket as JSON (`id`, `source`, `reporterEmail` for customers, optional `traceId`, `title`, `body`) and prints the Verdict, Triage, the subagents that ran, whether the fast path was taken, whether the three Investigators ran in parallel, and the prompt versions. Three demo Tickets ship with the package. It needs the compose stack, ShopLite migrated, seeded and running, `pnpm seed:incidents` done, and `OPENAI_API_KEY` and `COHERE_API_KEY` in `.env` or the shell.

```bash
pnpm prompts:sync                                              # optional: push the prompts to Langfuse
pnpm resolve packages/agents/tickets/images-not-loading.json   # answered from the clear cache article, Triage only
pnpm resolve packages/agents/tickets/declined-card.json        # answered from the payments row and the decline log line
pnpm resolve packages/agents/tickets/stale-cart-total.json     # matched to a seeded Incident, whose documented UPDATE it proposes
```

Paths are relative to where you run the command. Pass `-` to read the Ticket from stdin, and `--thread <id>` to name the LangGraph thread; by default each run gets a fresh thread named after the Ticket id and the time.

The two investigated Tickets assume the state they describe exists in ShopLite: the declined-card Ticket needs a recent checkout with a card ending in 0002, and the stale cart total Ticket needs a cart whose line was removed through `DELETE /customers/:customerId/cart/items/:productId`, which leaves `cart_totals` holding the old count. The end-to-end test creates both against a running ShopLite before it runs.
