# Incident Resolver

An agent that investigates problems reported against a product, using logs, database, past incidents, and source code, and resolves them with human approval on every write.

## Language

### Requests and outcomes

**Ticket**:
Any request for investigation opened in the portal, whatever its source: a customer, a tester, or Sentinel.
_Avoid_: issue (reserved for GitHub), case, report, alert

**Source**:
Where a Ticket came from. One of customer, tester, or sentinel.

**Reporter**:
The person or system that opened a Ticket. For customer tickets, identified by their email in the product.
_Avoid_: user, requester, submitter

**Outcome**:
How a Ticket ended. Exactly one of: answered, data fixed, fix proposed, escalated.
_Avoid_: resolution, result, status

**Reply**:
The message sent back to the Reporter when a Ticket ends. Customer-facing for customer tickets, internal for tester and Sentinel tickets. Every Ticket gets exactly one.
_Avoid_: response, resolution message, answer

**Status**:
Where a Ticket is in its lifecycle: `new`, `triaging`, `investigating`, `awaiting_approval`, `acting`, or `closed`. Distinct from Outcome, which only a closed Ticket has. The portal derives it from the Resolver's stream.

**Run**:
One pass of the Resolver over a Ticket, numbered from 1. Re-running a Ticket starts a new Run on a fresh thread; every Timeline entry says which Run wrote it.

**Timeline**:
The ordered record of what a Run did to a Ticket: subagent starts and ends, tool calls and results, messages, interrupts, Decisions, status moves, and the Verdict. Stored as it streams and served live to the portal.
_Avoid_: log, history, feed, audit trail

**Incident**:
The distilled record of a closed Ticket written to the knowledge base: symptoms, root cause, and what fixed it. Written for both agent-resolved and human-resolved tickets.
_Avoid_: ticket, case, past issue

### Investigation

**Triage**:
The first classification of a Ticket: category, severity, component, and a hypothesis to focus the investigators.

**Category**:
Triage's classification of what kind of problem a Ticket is. One of: question, user error, data issue, code bug, infra, unknown.

**Question**:
A Category for Tickets that need an answer, not an investigation: how-to requests and known workarounds such as clearing the cache. Answered from Help articles on the fast path.
_Avoid_: FAQ, support request, simple issue

**Help article**:
A piece of product guidance in the knowledge base, written ahead of time, that answers a Question. Distinct from an Incident, which records a resolved problem.
_Avoid_: FAQ entry, doc, knowledge item

**Fast path**:
Resolving a Question directly from Help articles without running the Investigators. Falls through to full investigation when no article matches with enough Confidence.

**Evidence**:
A fact gathered during investigation, with its provenance: a log line, a trace id, a query result, or a matching Incident.
_Avoid_: finding, observation

**Confidence**:
The Resolver's stated certainty, from 0 to 1, that its Outcome is correct. Below the threshold, the Ticket is escalated.

**Verdict**:
The Resolver's structured final output for a Ticket: Outcome, Confidence, root cause, Evidence references, and Reply text. The Incident and the Reply are derived from it.
_Avoid_: result, report, summary

**Escalation**:
Handing a Ticket to a human because Confidence is too low or Evidence conflicts. The human's resolution still becomes an Incident.

### Approvals

**Proposal**:
A write the agent wants to perform and cannot without approval: a data fix, a pull request, or a customer Reply.
_Avoid_: action, suggestion, request

**Reviewer**:
The human who approves, edits, or rejects a Proposal. One role, no login, in this project.
_Avoid_: admin, operator, approver

**Decision**:
The Reviewer's verdict on a Proposal: approve, edit, or reject.

**Data fix**:
A Proposal to change product data with SQL. Runs only after approval, in a transaction, with a snapshot of affected rows kept for rollback.

### Agents

**Resolver**:
The orchestrating agent that owns a Ticket from Triage to Outcome.

**Investigator**:
A subagent that gathers Evidence from one source: logs, database, or past Incidents. All three always run whenever a Ticket is investigated; none run on the fast path.

**Sentinel**:
The watcher that opens Tickets from metrics anomalies. At most one open Ticket per fingerprint of route and error type.
_Avoid_: monitor, watcher, alerting

### Product under investigation

**ShopLite**:
The dummy e-commerce product the agent investigates. Lives in its own repository, which is the target of fix pull requests.
_Avoid_: the app, the dummy app, target system

**Workspace**:
A per-Ticket clone of the ShopLite repository where the code agent reads, edits, and runs tests.
_Avoid_: checkout, sandbox
