# Incident Resolver: Autonomous Support and Incident Agent

An agent that takes a support ticket, a tester's bug report, or a metrics alert, investigates using logs, database, past incidents, and source code, and either resolves it, proposes a data fix, or opens a fix PR. Humans approve every write.

Stack: TypeScript, Node 22, pnpm workspaces, Deep Agents (`deepagents`), LangChain, LangGraph, MCP, Postgres with pgvector, React.

## 1. Demo script (drives all scope decisions)

| # | Trigger | What the agent does | What it proves |
|---|---------|---------------------|----------------|
| 0 | Customer ticket: "Product images stopped loading after the sale" | Triage classifies it as a Question, Resolver answers from a Help article (clear cache, hard refresh) in seconds, no Investigators run | Fast path, not every ticket is an engineering problem |
| 1 | Customer ticket: "Checkout failed, money not deducted" | Reads logs, queries orders and payments tables, finds card declined by mock gateway, replies to customer | Tool use, speed, no bug |
| 2 | Tester ticket: "Cart total wrong after removing item" | Finds a near-identical resolved incident in the vector store, proposes the documented data fix, waits for approval, runs it | Knowledge loop, HITL for DB writes |
| 3 | Customer ticket: "Discount applied twice" | Reproduces with a failing test, reads code, writes RCA, patches, tests pass, waits for approval, opens a GitHub PR | Code RCA, real PR, HITL for code |
| 4 | Stretch: click "simulate traffic" | Sentinel sees error rate spike on one endpoint, opens a ticket automatically, same pipeline runs | Proactive detection |

Total demo time target: 8 minutes of the 15.

## 2. Services (what runs as a process)

| # | Service | Tech | Port | Purpose |
|---|---------|------|------|---------|
| 1 | `shoplite-api` | Fastify, Drizzle, Postgres, OpenTelemetry SDK | 4000 | The dummy product. Products, cart, checkout, discounts, mock payment gateway. Pricing, cart, and discount logic live in a pure domain module with unit tests that need no database, so `run_tests` works in any Workspace without infrastructure. Route handlers are thin. The planted code bugs sit in the domain module. No compose file of its own: takes `DATABASE_URL` and `OTEL_EXPORTER_OTLP_ENDPOINT` from env. Instrumented with OTel. Own GitHub repo (PR target, see ADR-0001). |
| 2 | `shoplite-web` | Vite, React | 4001 | Minimal storefront, 4 pages: catalog, cart, checkout, and "My tickets" listing the signed-in customer's Tickets and Replies. A "signed in as" picker of seeded customers, no auth. Error toasts show the trace id and a "Report a problem" button that opens a Ticket in the portal pre-filled with reporter email, trace id, and what they were doing. |
| 3 | `portal-api` | Fastify, LangGraph, deepagents, Langfuse | 5000 | Ticket CRUD, SSE stream of agent events, approval endpoints, runs the agent per ticket. Hosts the MCP client. Every agent run is a Langfuse trace. |
| 4 | `portal-web` | Vite, React, Tailwind | 5001 | Ticket list, Ticket detail with a live timeline of event cards (subagent start and end, tool call, interrupt, decision, Reply), payloads collapsed by default. Approval cards. Tester submit form. "Resolve manually" form for escalated Tickets. "Re-run" button that starts a fresh thread. Links each Ticket to its Langfuse trace and its ShopLite trace. A hidden Demo panel behind a keyboard shortcut with "simulate traffic" and "reset". |
| 5 | `sentinel` | Node worker, LangGraph | none | Runs PromQL error-rate queries against Prometheus every 10s, detects anomalies, opens tickets through `portal-api`. |
| 6 | Postgres 16 + pgvector | Docker | 5432 | One instance, three schemas: `shoplite` (product data), `portal` (tickets, events, approvals, LangGraph checkpoints), `knowledge` (incident embeddings). |
| 7 | Grafana LGTM | Docker, `grafana/otel-lgtm` image | 4318 OTLP, 3000 Grafana, 3100 Loki, 3200 Tempo, 9090 Prometheus | One container bundling the OTel Collector, Loki (logs), Prometheus (metrics), Tempo (traces), and Grafana. ShopLite sends OTLP here. The observability MCP server queries Loki, Tempo, and Prometheus directly. Loki's port 3100 is not published by the image by default and must be mapped in compose. |
| 8 | Langfuse | Langfuse Cloud, or self-hosted Docker Compose | 3001 if self-hosted | Agent observability: traces, spans per subagent and tool call, token usage, latency, prompt versions, and human feedback scores. |

Five Node processes plus three infrastructure pieces. `docker compose up` starts Postgres and LGTM; `pnpm dev` starts the rest. Use Langfuse Cloud for the demo to avoid running its five extra containers, self-host only if data must stay local.

MCP servers are not counted as services. They run as stdio child processes spawned by `portal-api` through `@langchain/mcp-adapters`.

## 3. MCP servers

| # | Server | Build or buy | Tools exposed | Backing store |
|---|--------|--------------|---------------|---------------|
| 1 | `mcp-observability` | Build (`@modelcontextprotocol/sdk`) | `search_logs(query, since, level, traceId?)` via Loki LogQL, `get_trace(traceId)` via Tempo, `query_metrics(promql, window)` and `get_error_rate(route, window)` via Prometheus, `list_recent_errors()` | Grafana LGTM: Loki, Tempo, Prometheus HTTP APIs |
| 2 | `mcp-database` | Build | `describe_schema()`, `run_readonly_sql(sql)`, `propose_data_fix(sql, reason)` | Postgres `shoplite` schema, read-only role. For customer-source Tickets the server is started with the reporter's customer id and rejects queries that don't filter by it (tenant scoping). `propose_data_fix` never executes; it returns a Proposal for the approval gate. |
| 3 | `mcp-incidents` | Build | `search_similar_incidents(text, k)`, `get_incident(id)`, `save_incident(record)`, `search_help_articles(text, k)` | pgvector in `knowledge` schema, two tables: incidents and help articles, same embed and rerank pipeline. `save_incident` is called at ticket close. Help articles are seeded, never written by the agent. |
| 4 | GitHub MCP | Buy (official `github/github-mcp-server`, remote HTTP endpoint with a PAT) | `create_branch`, `push_files` or `create_or_update_file`, `create_pull_request`, `add_issue_comment` | GitHub |

Why build the first three: read-only enforcement, tenant scoping, and PII redaction have to live in the tool, not in the prompt. Why buy GitHub: it is the integration point a customer already has.

Redaction is implemented, not claimed: the database and observability servers run a regex pass over every result that masks card numbers entirely and masks any email that is not the reporter's. Every tool result on the timeline is therefore safe to show on screen.

Filesystem tools (`ls`, `read_file`, `edit_file`, `grep`, `glob`) come from Deep Agents' `FilesystemBackend` rooted at the Ticket's Workspace with `virtualMode` on, so paths cannot escape it. The code agent has **no shell**. It gets two fixed LangChain tools wrapping `execa`: `run_tests` runs the ShopLite test suite, `git_diff_names` lists changed files. If Code RCA needs more, add another fixed tool such as `run_typecheck`, never a shell.

## 4. Agents

One orchestrator deep agent, six subagents, one standalone LangGraph. Eight in total.

| # | Agent | Kind | Model | Tools | Returns |
|---|-------|------|-------|-------|---------|
| 1 | **Resolver** | Deep agent (orchestrator) | `gpt-5.4` | `write_todos`, `task` (subagents), `send_customer_reply`, `escalate_to_human` | Final resolution, or escalation |
| 2 | **Triage** | Subagent, structured output via Zod | `gpt-5.4-mini` | `search_help_articles` only | `{category, severity, component, hypothesis, confidence, helpArticleIds}`. Categories: `question`, `user_error`, `data_issue`, `code_bug`, `infra`, `unknown` |
| 3 | **Log Investigator** | Subagent | `gpt-5.4-mini` | `mcp-observability` tools | Evidence summary with trace ids, span names, and timestamps |
| 4 | **Data Investigator** | Subagent | `gpt-5.4-mini` | `mcp-database` tools | Evidence summary plus optional data fix proposal |
| 5 | **Incident Historian** | Subagent | `gpt-5.4-mini` | `mcp-incidents` tools | Top matches after Cohere rerank, with their documented resolution |
| 6 | **Code RCA** | Subagent | `gpt-5.4` | filesystem backend, `run_tests`, `grep` | RCA report: root cause, file and line, failing test written, patch applied, tests green |
| 7 | **Fix Shipper** | Subagent | `gpt-5.4-mini` | `git_diff_names`, `read_file`, GitHub MCP | Reads the changed files from the Workspace, pushes them to a new branch with `push_files`, opens the PR with the RCA as body. No local commits, no git credentials outside the MCP config. |
| 8 | **Sentinel** | Standalone LangGraph, cron loop | `gpt-5.4-nano` for ticket text only | `get_error_rate`, `list_recent_errors`, `create_ticket` | New Ticket with Evidence and trace ids attached. Fires when a route's error ratio exceeds 20% over 60s with at least 5 requests. Deduplicates by fingerprint of route plus error type: at most one open Ticket per fingerprint. |

Model choice in one line: `gpt-5.4` where the agent reasons and decides (Resolver, Code RCA), `gpt-5.4-mini` where it gathers evidence or follows a fixed procedure (Triage, the three investigators, Fix Shipper), `gpt-5.4-nano` where it only formats text (Sentinel). All models are set in one config file so any of them can be swapped without touching agent code.

### Embeddings and rerank (Cohere)

- Embeddings: Cohere `embed-v4.0` through `@langchain/cohere` `CohereEmbeddings`. The wrapper cannot set `output_dimension`, so vectors are the model default of 1536. It already sends `search_document` for indexing and `search_query` for queries.
- Rerank: Cohere `rerank-v3.5` through `@langchain/cohere` `CohereRerank`.
- Retrieval in `mcp-incidents`: pgvector returns top 20 by cosine similarity, Cohere rerank narrows to top 3 with relevance scores. The relevance score feeds Triage confidence.

Resolver flow, in prose: run Triage. If the Category is `question` and Triage found a matching Help article with Confidence at or above the threshold, take the **fast path**: write the Reply from the article, no Investigators, Outcome `answered`. Otherwise, always fan out to all three Investigators in parallel, then decide. Triage's hypothesis focuses the Investigators, it never skips one. If Evidence points at user error, write the Reply. If at data, take the Proposal to the approval gate. If at code, run Code RCA, take the patch to the approval gate, then Fix Shipper. If Confidence is below 0.6 or Evidence conflicts, escalate. On close, write the Incident.

### Outcome model

Every Ticket ends with exactly one **Outcome** and exactly one **Reply**.

| Outcome | When | Reply |
|---------|------|-------|
| `answered` | A Question answered from a Help article on the fast path, or no product defect and the explanation found in Evidence | Customer-facing explanation |
| `data_fixed` | Data fix Proposal approved and executed | What was wrong and that it is corrected |
| `fix_proposed` | Code bug confirmed and PR opened. The Ticket is done here; merge is out of scope. | Customer: confirmed, fix underway. Internal note carries the PR link. |
| `escalated` | Confidence below threshold or conflicting Evidence | Holding message; a human resolves in the portal |

Tester and Sentinel Tickets get an internal Reply shown on the Ticket, not sent anywhere. Customer Replies appear on the storefront's "My tickets" page; email delivery is a stub that logs.

Failure handling: model calls retry twice with backoff, which LangChain does natively. If a run still fails or exceeds 10 minutes, the Ticket closes with Outcome `escalated` and reason `agent_error`, with everything gathered so far attached. Re-run starts a fresh LangGraph thread; earlier events stay on the timeline labelled by run number.

Ticket lifecycle: `new`, `triaging`, `investigating`, `awaiting_approval`, `acting`, `closed`. `closed` carries the Outcome. An escalated Ticket is closed by a human through a "resolve manually" form, and that human-written resolution is also saved as an Incident, so the knowledge base learns from the agent's failures.

The Resolver ends its run with a structured **Verdict** (Zod `responseFormat`): outcome, confidence, root cause, evidence references, reply text. The Incident record and the Reply are derived from the Verdict deterministically, not by another model call.

### Deep Agents vs LangGraph

Use Deep Agents for the Resolver and its subagents. Verified against the current JS package (v1.13): `createDeepAgent({ model, systemPrompt, tools, subagents, backend, interruptOn, checkpointer, responseFormat })`. The `task` tool runs several subagents in parallel when the model issues multiple calls in one turn, so the Investigator fan-out needs no custom graph. `FilesystemBackend({ rootDir, virtualMode: true })` confines file tools to the Workspace. Interrupts surface as `actionRequests` and resume with `Command({ resume: { decisions } })`. Requires LangChain v1, LangGraph v1, and Zod 4.

Raw LangGraph is used for:

- **Sentinel**: a timed loop with deterministic thresholds. No planning needed.
- **Ticket lifecycle state**: maintained in `portal-api` from agent stream events and interrupts, not inside the agent.

### Observability

Two pipelines, both OpenTelemetry.

**Application side (ShopLite).** The OTel Node SDK with auto-instrumentation for Fastify, `pg`, and HTTP, plus the OTel Logs API bridged from pino. Everything exports over OTLP to the LGTM container. Every request gets a trace id, and the trace id is returned to the client in a response header and shown in the storefront error toast. A customer pasting that id into a ticket lets the agent jump straight to the trace. Custom metrics: `checkout_total`, `checkout_errors_total` by reason, `discount_applied_total`. Grafana dashboard on port 3000 for the demo.

**Agent side (portal-api).** Langfuse JS SDK v5, which is itself built on OTel. A `LangfuseSpanProcessor` is registered in the portal's OTel `NodeSDK`, and the `CallbackHandler` from `@langfuse/langchain` is passed to every agent invoke. Session and user attributes are set with `propagateAttributes` from `@langfuse/tracing`. Note v5's span processor filters non-LLM spans by default; pass `shouldExportSpan` if MCP tool spans should appear. Mapping:

- Langfuse session id = ticket id, so one ticket's whole lifecycle including resume after approval is one session.
- Langfuse trace per Resolver run, nested spans per subagent and tool call, with model, tokens, and latency.
- Tags: ticket source, triage category, MODEL names.
- Human decisions from the approval gate are written back as Langfuse scores (`approved`, `edited`, `rejected`), and the final outcome as `resolved` or `escalated`. This turns the HITL gate into an evaluation dataset for free.
- Prompts for all eight agents live in the repo as markdown under `packages/agents/prompts/`. A `pnpm prompts:sync` script pushes them to Langfuse prompt management with a label. At runtime the agent fetches from Langfuse by name and label and falls back to the local file, so startup never depends on the network and traces still show the prompt version.

Because both pipelines are OTel, the ShopLite trace id found by the Log Investigator can be attached as an attribute on the agent span, linking the customer's request to the agent's investigation of it. The Ticket page shows both links side by side.

## 5. Human-in-the-loop policy

| Action | Policy |
|--------|--------|
| Read logs, SQL select, vector search, read code, run tests | Automatic |
| `propose_data_fix` execution | Approve, edit, or reject in portal. On approval `portal-api` runs it with a write role: only `UPDATE` or `DELETE` with a `WHERE` clause, inside a transaction, row count capped, and a snapshot of affected rows stored on the approval for rollback. |
| `create_pull_request` | Approve or reject |
| `send_customer_reply` | Approve or edit. Always approved in the demo; auto-send is a policy toggle mentioned in the Vision. |
| PR merge | Never by the agent |
| Confidence below 0.6 after investigation | Auto-escalate with the Evidence attached |
| `escalate_to_human` | Ungated: it writes nothing. Once called, the Ticket is escalated whatever the Verdict then claims (ADR-0003) |

Implemented with Deep Agents `interruptOn` on those three tools, a Postgres checkpointer keyed by ticket id, and a `POST /tickets/:id/decision` endpoint that resumes the thread with `Command({resume})`. One Reviewer role, no login. Multiple Tickets can run concurrently, one LangGraph thread each, no global lock.

## 6. Repo layout

Two git repos. The PR demo is cleaner when the diff contains only product code.

```
incident-resolver/                # this repo, pnpm monorepo
  apps/
    portal-api/
    portal-web/
    sentinel/
  packages/
    agents/                       # Resolver, subagents, prompts, Zod schemas. Owns scripts/prompts-sync.ts, which pushes its prompts to Langfuse, run as `pnpm prompts:sync`
    mcp-observability/
    mcp-database/
    mcp-incidents/                # also owns scripts/seed.ts: the 20 seeded Incidents, run as `pnpm seed:incidents`
    shared/                       # ticket types, event types, db client, migrations
  docker-compose.yml              # postgres + pgvector, grafana/otel-lgtm
  scripts/demo-reset.ts           # reseed ShopLite data, clear Tickets and approvals, keep Incidents
  scripts/scorecard.ts            # replay the planted bugs, check each Outcome
  PLAN.md
  CONTEXT.md

shoplite/                         # separate repo on GitHub, PR target
  apps/api/                       # Fastify + Drizzle
  apps/web/                       # Vite storefront
  tests/
```

`portal-api` clones `shoplite` into `workspaces/<ticket-id>/` before Code RCA runs, so the agent never edits a shared checkout. Everything runs locally on one laptop with Docker Compose; nothing is deployed.

Seeded Incidents are ShopLite-specific history, not generic e-commerce: dated across six months, three authors, mixed quality. Two are near-duplicates of the stale cart total bug so rerank has to choose, and one is a red herring that vector search ranks high and rerank drops.

## 7. Data model (portal schema)

- `tickets`: id, source (`customer` | `tester` | `sentinel`), reporter_email, trace_id, title, body, status, category, confidence, outcome, reply, root_cause, resolution, resolved_by (`agent` | `human`, null while nobody has), created_at, closed_at. A check constraint ties `closed` to having exactly one Outcome and one Reply, and another keeps `resolved_by` to closed Tickets. Severity arrives with Triage and fingerprint with Sentinel, each added by the issue that first writes it.
- `ticket_events`: id (the sequence the SSE stream sends as its event id), ticket_id, run, type (`tool_call` | `tool_result` | `subagent_start` | `subagent_end` | `message` | `interrupt` | `decision` | `verdict` | `status`), payload jsonb, created_at. This feeds the live timeline. `verdict` carries the Resolver's structured output and `status` is the portal's own entry, written whenever the lifecycle moves.
- `approvals`: id, ticket_id, action, proposal jsonb, decision, edited_proposal jsonb, snapshot jsonb, decided_at
- `incidents` (knowledge schema): id, title, symptoms, root_cause, resolution, category, embedding vector(1536), source_ticket_id, resolved_by (`agent` | `human`)
- `help_articles` (knowledge schema): id, title, body, tags, embedding vector(1536). Seeded with about ten ShopLite articles: clear cache and hard refresh, reset password, change delivery address, cancel an order, where to find invoices, supported cards, discount code rules, and similar.

## 8. Planted bugs in ShopLite

| Bug | Category | Demo moment | Mechanism |
|-----|----------|-------------|-----------|
| Card declined shows generic "Checkout failed" | `user_error` | 1 | Mock gateway declines cards ending in 0002. Logs show the decline reason; UI hides it. |
| Cart total stale after item removal | `data_issue` | 2 | `cart_totals` is a denormalised table so the header badge shows count and total on every page without a join. Item removal forgets to update it. The reason for the table is a code comment the agent can find and cite. A past Incident documents the `UPDATE` that fixes it. |
| Discount applied twice | `code_bug` | 3 | `applyDiscount` called in both `calculateSubtotal` and `finalizeOrder`. A test for single application is missing. |
| Crash on empty cart checkout | `code_bug` | 4 | `items[0].price` on empty array. "Simulate traffic" sends empty-cart checkouts. |

Three bugs is enough. The fourth is only built if phase 5 happens.

## 9. Build phases

| Phase | Deliverable | Demo moment unlocked | Estimate |
|-------|-------------|----------------------|----------|
| 1 | ShopLite API and web with seed data, OTel instrumentation into LGTM, Grafana dashboard, tests, 3 planted bugs, pushed to GitHub | none yet | 1 day |
| 2 | Three custom MCP servers plus a CLI runner for the Resolver with Triage, Log, Data, and Historian subagents, traced in Langfuse from day one. Seed 20 incidents. | 1 and 2 (from CLI) | 1.5 days |
| 3 | `portal-api` with tickets, SSE timeline, checkpointer, interrupts, Langfuse scores on decisions. `portal-web` with list, detail, approval cards, trace links. | 1 and 2 (in UI) | 1.5 days |
| 4 | Code RCA and Fix Shipper subagents, workspace cloning, GitHub MCP | 3 | 1 day |
| 5 | Sentinel, "simulate traffic" button, empty cart bug | 4 | 0.5 day |
| 6 | README with architecture diagram and one-command setup, `pnpm demo:reset`, scorecard script that replays the planted bugs and checks each Outcome, screen recording as a fallback, rehearsal | | 0.5 day |

Seven working days are available: six for the phases above, one held as buffer. Everything in the plan is in scope. If the buffer is consumed, drop phase 5 first.

## 10. Key packages

- `deepagents`, `@langchain/core`, `@langchain/openai`, `@langchain/langgraph`, `@langchain/langgraph-checkpoint-postgres`
- `@langchain/mcp-adapters` (MCP client), `@modelcontextprotocol/sdk` (custom servers)
- `@langchain/community` for `PGVectorStore`, `@langchain/cohere` for `CohereEmbeddings` and `CohereRerank`
- `fastify`, `drizzle-orm`, `pg`, `pino`, `execa`, `zod`
- `react`, `vite`, `tailwindcss`
- OTel: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node` (its pino instrumentation bridges pino to the OTel logs API, so `pino-opentelemetry-transport` is not needed), `@fastify/otel` (the contrib fastify instrumentation is no longer in the auto bundle), `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/api-logs`
- Langfuse v5: `@langfuse/otel`, `@langfuse/tracing`, `@langfuse/langchain`, `@langfuse/client`

Versions verified on 2026-09-05: `deepagents` 1.13, `@langchain/cohere` 1.1, `@langfuse/client` 5.11. GitHub MCP remote endpoint is `https://api.githubcopilot.com/mcp/` with a PAT as a bearer token, and its `repos` and `pull_requests` toolsets carry `create_branch`, `push_files`, and `create_pull_request`.

## 11. Decisions

All settled on 2026-09-05.

- LLMs: OpenAI `gpt-5.4` family through a plain OpenAI API key. Embeddings and rerank: Cohere.
- GitHub PRs are real, against a `shoplite` repo under the author's account, through the official GitHub MCP server.
- Langfuse Cloud.
- Customer Replies always go through approval in the demo.
- Seven working days available; full plan in scope.
- Vocabulary is in `CONTEXT.md`. Ticket, Outcome, Reply, Incident, Proposal, Reviewer, Verdict are the canonical terms.

## 12. Engineering conventions

- **Tooling**: pnpm workspaces, `tsx` for dev, `vitest`, Drizzle with `drizzle-kit` migrations, Biome for lint and format. Node 22.
- **Portal look**: clean support desk, light theme, spacious. Evidence inside cards is monospace so logs and SQL read as logs and SQL. Built with the frontend design pass, not a stock Tailwind template.
- **Approval editing**: data fix Proposals open in a SQL textarea; Replies in a plain textarea. PRs are approve or reject only.
- **Config**: model names, Confidence threshold (0.6), Sentinel thresholds, run timeout, and row cap live in one `config.ts` read from env with defaults.
- **Timeline transport**: `portal-api` writes `ticket_events` as the agent streams, and serves them over SSE with last-event-id so a refreshed page catches up.
- **Decisions are recorded** in `docs/adr/`: ADR-0001 ShopLite in a separate repository, ADR-0002 no shell for the code agent, ADR-0003 the Resolver owns every write and the gate is on its own tools.
