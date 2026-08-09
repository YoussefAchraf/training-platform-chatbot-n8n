# Training Platform Chatbot

A role-aware AI assistant for `training-platform-backend`, built on n8n. It
sits in front of the same REST API your normal frontend already talks to,
lets Sales, Managers, Instructors, and SuperAdmins ask for things in plain
language ("what trainings do we offer?", "assign an instructor to session
12", "list pending signups"), and only ever does what that person's real
role is actually allowed to do — because every action it takes is a real
HTTP call to your real backend, carrying that person's real login token.

This document explains what was built, why it's built the way it is, and
what every file in this folder is for.

---

## Table of contents

1. [What problem this solves](#what-problem-this-solves)
2. [How a message actually flows through the system](#how-a-message-actually-flows-through-the-system)
3. [The security model: two layers, not one](#the-security-model-two-layers-not-one)
4. [Guardrails: keeping the model on a leash](#guardrails-keeping-the-model-on-a-leash)
5. [Making it fast and cheap](#making-it-fast-and-cheap)
6. [The greeting and suggestions feature](#the-greeting-and-suggestions-feature)
7. [Architecture: the trunk and four role sub-workflows](#architecture-the-trunk-and-four-role-sub-workflows)
8. [Every file in this repository, and why it exists](#every-file-in-this-repository-and-why-it-exists)
9. [Configuration](#configuration)
10. [Running it](#running-it)
11. [The AI model](#the-ai-model)
12. [Observability: metrics for performance, cost, and errors](#observability-metrics-for-performance-cost-and-errors)
13. [Resetting to a clean slate](#resetting-to-a-clean-slate)

---

## What problem this solves

`training-platform-backend` already has a full REST API and a real
authorization model — Sales and Managers manage the training catalog and
sessions, Managers approve new hires, Instructors manage their own
sessions and profiles, SuperAdmins see and touch everything. What it
didn't have was a conversational way to use any of that. You'd still need
to know which endpoint does what, remember IDs, and click through screens
for routine things like "who's on the calendar this week" or "approve
this signup."

This project is that conversational layer. It's not a new product with
its own database or its own idea of what a Session or a Client is — it's
a translator that turns a sentence into the correct authenticated API
call, and turns the API's response back into a sentence. Every piece of
data it shows you, and every write it performs, exists in
`training-platform-backend`'s own Postgres database, created through the
backend's own use cases, subject to the backend's own validation. The
chatbot has no state and no authority of its own.

n8n was chosen as the engine because the problem is fundamentally a
workflow — "read the message, check who's asking, check if it's safe,
route to the right toolset, let the model decide what to call, verify
what it said, respond" — and n8n makes that pipeline visible as a graph
of nodes instead of hidden inside a wall of orchestration code. You can
open the workflow in the editor, click any node, and see exactly what
ran, with what input, and what it produced.

## How a message actually flows through the system

A request comes in as `POST /webhook/chatbot/message` with a real
`training-platform-backend` JWT in the `Authorization` header and a body
of `{ "message": "...", "sessionId": "..." }`. From there, in order:

1. **JWT decode (fast, not authoritative).** The token's payload is
   base64-decoded to read `role`, `userId`, and `exp` — no signature
   check happens here, on purpose (see [the security model](#the-security-model-two-layers-not-one)
   below for why that's fine). If the token is missing, malformed,
   expired, or claims a role that doesn't exist, the request is rejected
   with 401 before anything else runs.
2. **Rate limiting.** A Redis counter keyed by `userId` and the current
   minute enforces a per-user cap, so one chatty user — or a bug in
   whatever's calling this endpoint — can't burn through model spend or
   hammer the backend.
3. **Input guardrail.** The raw message is checked against a blocklist of
   prompt-injection and abuse patterns *before* it ever reaches the
   model. This is a plain JS regex/keyword check — zero tokens spent,
   sub-millisecond, and it means the model never even sees the worst
   inputs.
4. **First-message detection.** A Redis flag (`session-greeted:<sessionId>`,
   4-hour TTL) records whether this conversation has said hello yet. This
   drives the [greeting and suggestions feature](#the-greeting-and-suggestions-feature).
5. **FAQ cache lookup.** For anything past the first message, the exact
   normalized text of the question (per role) is checked against a Redis
   cache of recent answers. A hit skips the model entirely.
6. **Role routing.** A Switch node sends the request down exactly one of
   four lanes — Sales, Manager, Instructor, SuperAdmin — based on the
   role read out of the JWT, into an Execute Workflow node that calls
   that role's own separate sub-workflow (see
   [Architecture](#architecture-the-trunk-and-four-role-sub-workflows)
   below for why it's split out this way).
7. **The agent.** Each role's sub-workflow has its *own* LangChain Agent
   node, its own system prompt, and its own wired subset of tools (more
   on why that split matters below). The agent decides — using the
   model — whether it can answer directly or needs to call one or more
   tools, calls them, and produces a reply, which flows back to the
   trunk workflow that called it.
8. **Output guardrail.** The reply is checked again, after generation,
   for anything that shouldn't go out (leaked internals, unsafe content,
   etc.) before it's sent back.
9. **Response.** If the answer is cacheable (not personalized, not
   sensitive), it's stored in the FAQ cache for next time; either way, a
   JSON reply goes back to the caller.

Every one of those steps is a real node you can open in the n8n editor
and inspect — there's no hidden orchestration logic living in a separate
service.

## The security model: two layers, not one

The single most important design decision in this project is that **the
chatbot is never the source of truth for what someone is allowed to do —
the backend always is.**

The JWT decode at the front of the workflow is explicitly "best-effort."
It doesn't verify the signature, and it's not supposed to. Its only job
is to pick which system prompt and which toolset to hand the model, so
that a Sales user gets offered Sales-shaped suggestions and an Instructor
doesn't get shown "delete any user" as an option. If someone tampered
with the token's payload to claim a role they don't have, this decode
would happily believe them.

But it doesn't matter, because **every single tool call forwards the
original, untouched token** as the real `Authorization` header on a real
HTTP request to `training-platform-backend`. That backend verifies the
signature for real, on every request, exactly as it does for the normal
frontend. If the token's real signature doesn't match a real role with
real permission for that action, the backend rejects it — the chatbot
never overrides that, and never could, since it isn't the one making the
authorization decision.

This is also why the tool wiring is *structural*, not just a system
prompt saying "don't do things outside your role." Each of the four
Agent nodes is physically connected to only its own subset of tool nodes
in the graph (Sales: 16, Manager: 21, Instructor: 9, SuperAdmin: all 30 —
SuperAdmin bypasses every role check in the backend too, by design, so it
gets the full set). A Sales agent can't call an Instructor-only tool
because there is no wire between them in the workflow — it's not a
matter of the model choosing not to; the option doesn't exist in its
tool list at all. Combined with the backend's own signature-checked
authorization, that's defense in depth: even if the routing layer were
somehow wrong, the backend is the actual, final gate.

## Guardrails: keeping the model on a leash

There are two independent guardrail checks, one before the model runs
and one after:

- **Input guardrail** — a cheap, deterministic pattern check that runs on
  every message before the model ever sees it. It catches obvious
  prompt-injection attempts ("ignore previous instructions...", "reveal
  your system prompt...") and abusive content, and rejects them with a
  polite refusal, at zero token cost.
- **Output guardrail** — after the agent produces a reply, it's checked
  again before being sent to the user. An input can look completely
  innocent and still lead a model to generate something it shouldn't
  (accidentally echo a system prompt fragment, produce something unsafe
  in response to a roundabout request) — the output check exists because
  input filtering alone can't catch that class of failure.

Neither guardrail is the model grading its own homework — both are plain
code, not a second AI call, which keeps them fast, free, and impossible
to talk out of.

## Making it fast and cheap

A handful of deliberate choices keep both latency and token spend down:

- **Small, fast model tier.** This is a lookup-and-CRUD assistant, not an
  open-ended reasoning task, so a small/fast model tier is the right fit.
- **Structural tool-gating instead of a mega-prompt.** A single agent
  with all 30 tools and one enormous "here's what you may and may not do"
  prompt would burn far more tokens per call *and* still rely on the
  model correctly self-censoring. Four smaller agents, each with only
  the tools relevant to that role, means shorter prompts, a shorter tool
  list for the model to reason over, and access control that doesn't
  depend on the model behaving.
- **Windowed memory.** Each session keeps only the last 6 messages of
  context, not the entire conversation history — enough for natural
  back-and-forth without the prompt growing without bound.
- **FAQ caching.** Repeated or common questions (per role, exact
  normalized text match) are served straight from Redis without touching
  the model at all — the biggest single cost win for anything asked more
  than once, like "what trainings do we offer."
- **Zero-token guardrails.** As above — both safety checks are plain code,
  not extra model calls.
- **Low temperature (0.2).** This is a tool-calling assistant, not a
  creative one; a low temperature makes tool selection and argument
  filling more consistent and reduces wasted retries from the model
  going off-script.

## The greeting and suggestions feature

The ask behind this feature was: greet each role appropriately on their
first message of a conversation, offer starting suggestions, and keep
offering relevant next-step suggestions on every reply after that —
without the model having to guess whether this is a new conversation.

Guessing is exactly what was avoided. Instead, a Redis flag
(`session-greeted:<sessionId>`) is set with a 4-hour TTL the first time a
session is seen, and checked on every message. A dedicated Code node
computes an explicit `isFirstMessage` boolean from that flag — the model
is never asked to infer this from an empty-looking history, it's told
outright. When it's the first message, the text handed to the agent is
prefixed with an explicit instruction: greet the user by role, offer 3–4
starting suggestions drawn only from that role's real capabilities, then
answer what they asked. Every agent's system prompt also carries a
standing instruction to close every reply — first message or not — with
a short, role-appropriate "you could also..." list, so the suggestions
don't stop after the first turn.

Because the suggestions are generated by the same role-scoped agent that
only has that role's tools wired in, they can't drift into suggesting
something the user isn't actually allowed to do — an Instructor's
suggestions come from the Instructor agent's own system prompt and
toolset, nothing else.

## Architecture: the trunk and four role sub-workflows

The pipeline described above isn't one single workflow file — it's five.
`training-platform-chatbot.n8n.json` is the **trunk**: the webhook, JWT
decode, rate limiting, guardrails, greeting detection, caching, and role
routing. It doesn't contain a single Agent or Tool node. Each role has
its own separate workflow file (`sub-workflow-sales.n8n.json`,
`-manager`, `-instructor`, `-superadmin`) containing that role's Agent
node, its own copy of the Chat Model and Memory nodes, and every tool
that role is allowed to call. The trunk reaches a role's sub-workflow
through an **Execute Workflow** node, and gets the agent's reply back the
same way.

Splitting it this way keeps each file focused — opening the Manager
sub-workflow shows only what a Manager can do, not all four roles'
tools tangled together on one canvas — and it means a change to, say,
the Instructor system prompt only touches a 14-node file, not a
75-node one.

There's a real trade-off worth being upfront about, though: n8n's
LangChain connections (the wires linking an Agent to its tools, memory,
and chat model) only resolve *within a single workflow* — an Execute
Workflow call carries plain JSON data across the boundary, not those
special connections. That means a tool used by more than one role (most
of them are) has to exist as a separate copy in every sub-workflow that
uses it, rather than being defined once and shared. It's a real cost —
editing a shared tool means editing it in more than one file — traded
for each file being small enough to actually read at a glance.

Because the trunk and each sub-workflow are separate workflow
executions, the trunk can't reach into a sub-workflow's nodes by name
the way nodes within one workflow normally can. So right before calling
a sub-workflow, the trunk's `Code: Build Sub-workflow Input` node
assembles a clean, explicit payload — `{ message, role, userId,
authHeader, isFirstMessage, sessionId }` — and that's exactly what the
sub-workflow receives as input. Inside each sub-workflow, the Agent and
its tools read that payload directly (`$json.message`, `$json.authHeader`,
and so on) instead of reaching back into a differently-named node the
way nodes inside a single workflow can. The sub-workflow's Agent reply
flows back out to the trunk unchanged, straight into the output
guardrail — from there on, the rest of the pipeline has no idea whether
the reply came from a 9-tool or a 30-tool sub-workflow.

## Every file in this repository, and why it exists

| File | What it is | Why it's built this way |
|---|---|---|
| `training-platform-chatbot.n8n.json` | The trunk workflow: webhook entry, auth, rate limiting, guardrails, greeting detection, caching, role routing, and the four Execute Workflow calls into the role sub-workflows. | The one workflow that owns the actual `/webhook/chatbot/message` endpoint and everything role-independent. |
| `sub-workflow-sales.n8n.json` / `-manager` / `-instructor` / `-superadmin` | One self-contained sub-workflow per role: that role's Agent node, its own Chat Model and Memory nodes, and every tool it's allowed to call. Invoked only via Execute Workflow from the trunk, never directly. | Kept separate per role rather than as one shared workflow — see [Architecture](#architecture-the-trunk-and-four-role-sub-workflows) above for the full reasoning and the real trade-off involved. |
| `docker-compose.yml` | Three services: `n8n`, `redis`, and `metrics-exporter`, on their own isolated stack. | Deliberately separate from `training-platform-backend`'s own docker-compose project — this chatbot should be deployable independently of the backend's infrastructure, reaching it only over the network via `BACKEND_API_URL`. |
| `metrics-exporter/` | A small Node service (its own `package.json`/`Dockerfile`) that reads the chatbot's execution history via n8n's REST API and exposes token usage, estimated cost, and tool-call reliability as Prometheus metrics. | See [Observability](#observability-metrics-for-performance-cost-and-errors) below for what it does and why it's a separate service rather than nodes bolted onto the workflow itself. |
| `.env` | Every configuration value: n8n owner credentials, the backend URL, the AI provider's key/URL/model, Redis connection info. Not committed to the repository - it holds real credentials, and everyone running this needs their own. | One file, one place to look. Nothing here is hardcoded into the workflow JSON — the workflow reads all of it through `$env`, so this file is the *only* thing you touch to point the same workflow at a different backend, a different AI provider, or a different Redis instance. |
| `.env.example` | A template of `.env` with every variable name, a comment explaining each one, and safe placeholder values - no real secrets. | Committed to the repository so anyone cloning it knows exactly what to fill in, without ever seeing (or accidentally committing) real credentials. |
| `.gitignore` | Excludes `.env` from version control. | The one-line reason `.env.example` exists instead of `.env` itself. |
| `entrypoint.sh` | Replaces the n8n image's default container entrypoint: starts n8n normally, then runs `bootstrap.js` alongside it. | Kept intentionally tiny — a couple of lines of `sh` to launch two processes. Anything more complex than "start this, then run that" was moved into `bootstrap.js`, on purpose (see next row). |
| `bootstrap.js` | Everything that makes this "automatic": waits for n8n to be ready, creates the owner account, imports the Redis and AI provider credentials, imports all 5 workflow files (the trunk plus the 4 role sub-workflows), and activates each of them — all idempotently, every time the container starts. | **Written in Node, not shell script, by necessity rather than preference.** n8n's session authentication is a cookie, so bootstrapping it requires a real HTTP client that can read a `Set-Cookie` header on login and replay it on every subsequent request. The n8n Docker image ships BusyBox's minimal `wget`, which has no cookie-jar support at all (that's a GNU wget feature) — so there's no practical way to do this in POSIX shell. Node's built-in `http` module handles cookies, retries, and JSON with no extra dependencies, which matters since nothing beyond what the n8n image already ships can be relied on inside the container. |
| `README.md` | This file. | — |

## Configuration

`.env` is gitignored on purpose — it holds real credentials (an AI
provider key, the n8n owner password, n8n's own encryption key), and
those should never end up in version control. What's committed instead
is `.env.example`, a template with every variable name and a comment
explaining what it's for, but no real values.

Before running anything, create your own `.env` from that template:

```bash
cp .env.example .env
```

Then fill in the values below.

| Variable | Required | What it's for |
|---|---|---|
| `N8N_ENCRYPTION_KEY` | Yes | A random secret n8n uses to encrypt credentials it stores internally. Generate your own, e.g. `openssl rand -hex 16` — never reuse someone else's. |
| `GENERIC_TIMEZONE` | Yes | Timezone n8n uses for scheduling/timestamps, e.g. `Africa/Casablanca`. |
| `N8N_WEBHOOK_URL` | Yes | The base URL n8n uses when it generates webhook URLs. Defaults to `http://localhost:5678/`; change the host/port if you're not running this locally on the default port. |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | Yes | Must be `false`. n8n blocks `$env` access inside sub-node expressions by default, and this workflow's tool nodes need `$env.BACKEND_API_URL`. |
| `N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD` | Yes | Login for the n8n editor, created automatically on first boot. Change the password before exposing this instance beyond your own machine. |
| `BACKEND_API_URL` | Yes | Where `training-platform-backend` is reachable from inside this container. If the backend runs in its own local docker-compose project, `http://host.docker.internal:<port>` is usually what you want. |
| `MCP_SERVER_URL` | No | Only used by the SuperAdmin agent's optional MCP tool, which is currently disconnected from the workflow. Leave empty unless you've set up an MCP server and reconnected that node. |
| `AI_API_KEY` | Yes | Your API key for whichever AI provider you're using. |
| `AI_BASE_URL` | Yes | That provider's OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. |
| `AI_MODEL` | Yes | The model id to request from that provider, e.g. `gpt-4o-mini`. |
| `REDIS_HOST` / `REDIS_PORT` | Yes | Connection info for the Redis instance used for rate limiting and FAQ caching. The bundled `docker-compose.yml` already starts one for you — only change these if you're pointing at a different Redis. |

See [The AI model](#the-ai-model) below for what to put in the three
`AI_*` variables depending on your provider, and for how to switch to a
provider that isn't OpenAI-compatible.

## Running it

```bash
docker compose up -d
```

Give it 20–30 seconds on first boot (n8n's own database migrations need
to finish), then watch the logs:

```bash
docker logs -f training-platform-chatbot-n8n-n8n-1
```

A `[bootstrap] Ready.` block means the owner account, credentials, and
workflow are all set up and active — nothing left to do by hand.

- **n8n editor**: `http://localhost:5678`, log in with `N8N_OWNER_EMAIL` /
  `N8N_OWNER_PASSWORD` from `.env` (defaults to
  `admin@localhost.local` / `ChangeMe123456!` — change this before
  exposing the instance beyond your own machine). The workflow is already
  imported and active; open it to inspect nodes, watch executions, step
  through what happened on any given request.
- **The actual chatbot endpoint** (what a real frontend would call):
  `POST http://localhost:5678/webhook/chatbot/message` with header
  `Authorization: Bearer <a real training-platform-backend JWT>` and body
  `{ "message": "...", "sessionId": "..." }`.

## The AI model

The Chat Model node is currently pointed at a temporary development
provider, purely so the workflow has something working end-to-end while
you set up your own. It's built on the generic OpenAI-compatible node
(`@n8n/n8n-nodes-langchain.lmChatOpenAi`), not tied to any one provider —
that node type works with any service that speaks the OpenAI
chat-completions format, which covers most providers today, either
natively or through a compatible endpoint. That's what makes swapping
providers a configuration change, not a workflow rebuild.

### The easy path (recommended): any OpenAI-compatible provider

If your provider speaks the OpenAI chat-completions format — OpenAI
itself, or any compatible endpoint — **you don't need to touch the
workflow file at all.** Edit three values in `.env`:

```bash
AI_API_KEY=your-real-key-here
AI_BASE_URL=https://api.openai.com/v1     # or your provider's base URL
AI_MODEL=gpt-4o-mini                      # or whatever model id your provider expects
```

Then recreate the container so `bootstrap.js` picks up the change and
re-imports the credential:

```bash
docker compose up -d --force-recreate n8n
```

That's the entire change. `bootstrap.js` reads those three variables and
creates the matching `openAiApi`-type credential in n8n automatically —
nothing to click through in the UI, and nothing in any workflow JSON to
edit, since all 4 sub-workflows' Chat Model nodes reference that same
credential by id.

### If you want Google's native Gemini API directly (not through a proxy)

This is a slightly bigger change, because it means switching node
*types*, not just credential values, and because the Chat Model node now
exists as one copy per role — so this edit needs to happen in all 4
sub-workflow files (`sub-workflow-sales.n8n.json`, `-manager`,
`-instructor`, `-superadmin`), not just one place:

1. **In each sub-workflow, the Chat Model node** (`id: "model-chat"`):
   change `"type"` from `"@n8n/n8n-nodes-langchain.lmChatOpenAi"` to
   `"@n8n/n8n-nodes-langchain.lmChatGoogleGemini"`, change its
   `"parameters"` to `{ "modelName": "models/gemini-2.0-flash", "options": { "temperature": 0.2 } }`,
   and change its `"credentials"` block to reference a `googlePalmApi`
   credential instead of `openAiApi` (the credential type is named
   `googlePalmApi` for historical reasons — it's the correct type for
   Gemini API-key auth). Since it's a mechanical, identical change across
   4 files, a small script (read each file, find the node by id, replace
   its `type`/`parameters`/`credentials`, write it back) is easier and
   less error-prone than editing each by hand.
2. **`bootstrap.js`**: change the credential-import block to create a
   `googlePalmApi`-type credential instead of `openAiApi` — the data
   shape is `{ host: 'https://generativelanguage.googleapis.com', apiKey: <your key> }`
   rather than `{ apiKey, url }`. This only needs to change once, since
   the credential itself is shared across all 4 sub-workflows by id.
3. **`.env`**: replace `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL` with a single
   `GEMINI_API_KEY` (or keep whatever naming you prefer, as long as
   `bootstrap.js` reads the same variable name).

### If you want native Anthropic (Claude)

Same shape of change as native Gemini above, in the same 4 files: swap
each Chat Model node's `"type"` to
`"@n8n/n8n-nodes-langchain.lmChatAnthropic"`, point its credentials at an
`anthropicApi`-type credential (just an `apiKey` field — the simplest of
the three credential shapes), and update `bootstrap.js`'s credential
import accordingly. Worth calling out separately: **an Anthropic *Pro*
subscription (claude.ai) is not the same thing as API access** — Claude's
API is billed separately through
[console.anthropic.com](https://console.anthropic.com/), with its own
key (`sk-ant-...`), regardless of any claude.ai subscription you have.

Whichever provider you land on, the rest of the workflow — guardrails,
routing, tools, caching, the greeting logic — doesn't know or care which
model is behind the Chat Model node. That separation was deliberate,
specifically so the model could be swapped, upgraded, or replaced
without touching anything else.

## Observability: metrics for performance, cost, and errors

There are two independent layers here, because they cover two genuinely
different things and one of them comes essentially for free.

### Layer 1: n8n's own built-in metrics

n8n ships a real Prometheus metrics endpoint (`prom-client`, bundled in
the image) — it's not something this project added, just something this
project turns on, at `GET http://localhost:5678/metrics`. Enabled and
configured entirely through the `N8N_METRICS*` variables in `.env`. It
covers, generically, for any workflow:

- `n8n_workflow_execution_duration_seconds{status,mode,workflow_id}` —
  latency percentiles *and* success/error rate in one histogram
- `n8n_webhook_request_duration_seconds{method,status_code,webhook_path}` —
  HTTP-level latency and status codes for `/webhook/chatbot/message`
  specifically
- `n8n_workflow_statistics_*` — production success/error counters per
  workflow
- Standard Node.js process metrics (event loop lag, memory, GC) for the
  n8n process itself

This is most of "is the workflow healthy and fast" answered without a
single line of custom code.

### Layer 2: `metrics-exporter/`, for what n8n's metrics don't cover

What n8n's own metrics can't see is anything about *what happened inside*
an execution - token counts, cost, which tool got called and whether it
errored. That data exists, but only inside each execution's raw stored
data, one execution at a time. `metrics-exporter` is a small standalone
service that polls n8n's REST API for new executions across all 5
workflows, decodes each one, and turns what it finds into metrics at
`GET http://localhost:9464/metrics`:

- `chatbot_requests_total{outcome}` — every trunk execution, by how it
  resolved (`success`, `guardrail_blocked`, `cache_hit`, `rate_limited`,
  `unauthorized`, `role_not_recognized`)
- `chatbot_tokens_total{type,role}` and `chatbot_cost_usd_total{role}` —
  prompt/completion tokens and an estimated USD cost, broken down by role
  (cost is an *estimate* from the `AI_PRICE_*_PER_1M_USD` values in
  `.env`, since no real cost figure survives into n8n's stored execution
  data, only token counts do — a real provider invoice is always the
  authoritative number)
- `chatbot_model_calls_total{role}` and
  `chatbot_model_call_duration_seconds{role}` — how often and how long
  the chat model itself took, separate from the whole request's duration
- `chatbot_tool_calls_total{tool,status}` — every tool invocation, by
  name and success/error. This is the one most worth watching: a tool
  suddenly showing a spike in `status="error"` is exactly the kind of
  thing worth catching from a dashboard rather than by noticing users
  are unhappy.

It's a separate service rather than nodes added into the workflow itself
on purpose — the workflow stays exactly what it's designed to be, and
this reads its history from the outside, using the same technique
(log in, fetch an execution, decode its `flatted`-encoded data) that
was used throughout this project's own debugging. It matches tool/model
nodes by **type**, not by hardcoded name, specifically so it keeps
working if you follow the [AI model](#the-ai-model) section's
instructions to swap providers later — a renamed or retyped Chat Model
node doesn't need a matching change here.

Both endpoints return plain Prometheus text format - point a Prometheus
server's scrape config at `n8n:5678` and `metrics-exporter:9464` (or
`localhost` equivalents from outside Docker) whenever you're ready to
add Prometheus/Grafana on top; nothing here depends on that piece
existing.

## Resetting to a clean slate

```bash
docker compose down -v   # wipes n8n's own DB (workflow, credentials, executions) and Redis data
docker compose up -d     # bootstrap runs again from scratch
```
