# Tenant AI platform

The AI module provides tenant-scoped capabilities for:

- private workspace assistant with confirmation-only actions;
- daily operational briefings;
- report insights and summaries;
- daily, weekly and monthly staff-planning assistance;
- communications analysis, drafting, translation and transcription;
- conservative firing insights (no kiln control or live telemetry assumptions);
- audience/effective-date/location-scoped studio knowledge;
- authenticated customer and public studio concierge experiences.

## HTTP API

Workspace routes are mounted at `/ai`; customer routes at `/ai/customer`; and
unauthenticated concierge routes at `/public/tenants/:tenantSlug/ai/concierge`.
Every JSON response uses `{ "data": ... }`.

`GET /ai/knowledge/coverage?locale=en&locationId=<optional-id>` is a
workspace-only Knowledge Hub diagnostic. It requires both `ai.use` and
`knowledge.view` and returns only a score, scan completeness, and missing
common-customer-question warnings. It never returns article content or target
identifiers. The general score counts published, untargeted public/customer
material: without `locationId` it evaluates global articles only, and with an
authorized `locationId` it evaluates global plus that location. Member/course
guidance and unrelated locations cannot inflate common-customer coverage. A
capped article scan returns `complete: false` and `truncated: true`.

Public callers must use the explicit tenant slug. A public conversation is
bound to a random opaque token stored only as a SHA-256 hash and expires after
24 hours. Public messages share the same TTL. Public/customer retrieval never
includes staff or legacy no-audience knowledge.

The authenticated customer concierge intentionally has the same domain-data
boundary as the public concierge, with additional approved, published Knowledge
Hub material authorized for that customer, plus an allowlisted set of basic
public studio and location facts. Membership and course records may authorize
Knowledge Hub audiences server-side, but those records are never inserted into
the provider prompt. Customer profiles, bookings, credits, invoices,
memberships, pottery pieces, payments and account data are also never added to
the prompt. Concierge messages carry a context-policy version so older answers
created under a broader policy cannot re-enter a resumed customer prompt.

## Provider and data handling

Only the backend reads `OPENAI_API_KEY`. Structured calls use the Responses API
with strict JSON Schema output. Provider response bodies and invalid model
output are not included in errors or logs. OpenAI is optional in development;
safe deterministic fallbacks are used when it is not configured.

The workspace assistant receives a bounded snapshot containing the studio
identity and settings, the authenticated actor, and only the domain data that
actor may already view. Depending on enabled modules and permissions, this can
include locations, products, courses, bookings, events, staff, customer
aggregates, inventory, memberships, invoices, pottery workflow, kilns,
firings, tasks, communications and staff planning. Compact, independently
gated summaries also cover credit balances and recent movements, vouchers,
automation and delivery health, piece-pricing and firing profiles, active and
recent firing runs, current-period report KPIs, and website publication state.
Every record query is tenant-pinned and location-scoped where the domain has a
location dimension. Lists, text, history and knowledge are capped, and the
serialized workspace snapshot has a final hard size budget.

`studio-context.service.ts` is the stable entry point for workspace context.
Every snapshot carries `contextVersion` and a `core` or `full` profile. The
core profile serves verified identity, settings and location questions without
loading the broad domain snapshot or calling OpenAI. The full profile remains
the permission-filtered source for operational questions and future command,
briefing and advisory capabilities. Context metadata recorded on an AI run
contains only version, profile, freshness and source coverage—never the studio
snapshot itself.

Sensitive fields are deliberately excluded from prompts, including door codes,
private access instructions, personal contact details, authentication data,
provider/payment identifiers and internal notes. Staff-only knowledge also
requires `knowledge.view`; `ai.use` by itself does not grant Knowledge Hub
access.

Prompt context is explicitly marked as untrusted and delimiter-like stored
content is escaped. AI output cannot execute a mutation directly: supported
actions are stored, re-authorized, validated and atomically claimed only after
an explicit confirmation request. Simple workspace identity and settings
questions have grounded deterministic fallbacks when the provider is
unavailable. Assistant message requests are rate-limited per tenant user.

New assistant and concierge messages also persist a stable `evidence` object.
It includes the context basis, freshness timestamp, authorized context source
count, completeness/truncation flags, allowlisted citation metadata and safe
warnings. It deliberately does not serialize arbitrary source or database
properties. This contract powers the UI's Sources and context freshness panel;
legacy messages continue to expose their existing `grounding` and `citations`.
Workspace conversations are also pinned to the current workspace-access
version and location scope. If access is narrowed or revoked, earlier message
text, evidence and saved action previews fail closed instead of remaining
readable or actionable through history.

The shared customer-question catalog in `ai-evaluation.catalog.ts` drives both
Knowledge Hub coverage warnings and offline CI evaluations. The evaluations
exercise realistic owner questions, Czech/English customer coverage and
synthetic private-data canaries without an OpenAI key or live model call. The
coverage diagnostic is deliberately conservative: it considers answer-bearing
body sections and completed custom Q&A only, requires topic plus concrete
answer evidence, and ignores titles, tags, categories, unanswered questions,
placeholders and obvious contradictions. It is a coverage heuristic, not a
claim that the studio's policy is factually correct. The AI context workflow
runs `tests/evals/ai` on every AI-related pull request.

## Feedback regression loop

Thumbs-up/down feedback remains tenant scoped and linked to the exact AI run
whenever the assistant message has one. Operators can inspect repeated negative
patterns with a read-only export:

```bash
npm run ai:feedback-regressions -- --tenant=<tenant-object-id>
```

The command scans the last 30 days by default, requires at least two distinct
negative assistant runs for a candidate, and writes a local report below
`.ai-evals/`. The default report contains only counts, model/prompt-version
metadata, and one-way pattern fingerprints—never prompt or answer text, tenant
ids, user ids, conversation ids, or run ids. Use
`--include-redacted-text` only for a local, privacy-reviewed investigation.
Mechanical redaction is defense in depth, not permission to commit the report.
The output directory is gitignored and the exporter never changes database
state.

Repeated candidates do not modify prompts or tests automatically. A reviewer
must replace production wording with a synthetic, non-identifying case in
`ai-feedback-regression.catalog.ts`. Every curated case then runs offline in
critical CI, including English/Czech ambiguity, multi-turn follow-ups and
proactive priority ordering. This promotion gate prevents personal studio data
or adversarial feedback from becoming repository content or executable test
logic.

Useful optional flags are `--days=90`, `--min-occurrences=3`,
`--max-feedback=10000`, and
`--output=.ai-evals/feedback-regressions-90d.json`.

## Credits and recovery

Credits are reserved before a provider call and settled from actual usage
afterwards. Ledger changes and period counters commit in the same MongoDB
transaction. The scheduled recovery job locks the period before releasing stale
reservations and rebuilding counters, so it cannot erase concurrent admissions.
It uses the reservation's latest update time to preserve a freshly reclaimed
retry. Runs and embedding jobs retain their idempotency/CAS guards.

AI and metered-email allowances use an actual monthly billing window (up to 32
days), or the actual trial window while a trial of at most 14 days is running.
Annual subscriptions and manual access grants use UTC calendar months. Historical
trial fields on an active manual grant never extend its monthly allowance.

Rollout does not re-key or rewrite old usage ledgers. A tenant previously metered
against an incorrect multi-year manual-grant period starts a fresh calendar-month
allowance after this fix; old period consumption remains available as historical
data. Moving past usage into monthly periods would require a separate reviewed
data migration. All API instances must run the transactional implementation
before relying on its reconciliation concurrency guarantee.

## Required production configuration

Set `OPENAI_API_KEY`. The model, base URL, timeout, retries, moderation,
embedding and transcription models have documented defaults in `.env.example`.
Keep this key server-only; never expose it through a `NEXT_PUBLIC_*` variable.
