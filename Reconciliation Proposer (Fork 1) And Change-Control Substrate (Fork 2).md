Plan: Reconciliation Proposer (Fork 1) + Change-Control Substrate (Fork 2)
Branch: feature/reconciliation-proposer

Agent's one-sentence job (committed to in both forks)
The on-call DBA the customer doesn't have, hovering over the same widget the human uses when they're at their desk — authors proposals, runs continuously, navigates lineage, risk-annotates plans, independently verifies outcomes. Anything outside this isn't the agent's job.

PHASE 0 — Configuration Uplift (ships before the proposer)
Locked decisions (your three):

DB-authoritative + bidirectional YAML import/export
Versioned records — every edit is a new immutable version with its own evidence envelope; proposals reference the exact version they ran against
Hybrid SCD2 — named template-level strategies + per-entity overrides
#	Sub-feature	Fully-featured scope
P0.1	EntityDefinition data model + versioned storage	Two tables (entity_defs current pointer + entity_def_versions immutable history); DB-level triggers refuse UPDATE/DELETE on versions; every save captures editor/timestamp/reason/diff; all plans+envelopes reference entity_def_version_id; per-tenant scoped
P0.2	SCD2/metadata strategies (hybrid)	Bundled: mymi-scd2, generic-scd2, none, audit-cols-only; entity-level strategy id + per-table override merge; strategies themselves versioned; resolved + snapshotted into plans at projection time
P0.3	Bidirectional YAML import/export	Canonical YAML per record type; tar.gz export/import; dry-run + conflict modes (fail/skip/update-as-new-version/interactive); CI round-trip test (export→import→export = byte-identical); CLI for git workflows; import-from-URL with signature verify
P0.4	Environment + connection config	UI CRUD for envs (id user-chosen — dev/uat/prod/sandbox-emea/anything); schemaAllowlist per-env (replaces hardcoded core/gate/coreArchive/gateArchive/master in catalog-drift.ts); auth modes (SQL/integrated/AAD/Kerberos); KMS-wrapped credential storage with rotation flow; Provider interface named with MssqlProvider as sole impl (seam ready for Fork 2 without code fork)
P0.5	FK-graph closure suggester	Walk FK graph from chosen root + idColumn; output candidate tables with auto-derived scope (rootPk/fkPath/sql), suggested executionOrder (topo-sort), confidence score, rationale; cycle detection; rejected candidates retained with reason for audit
P0.6	Importers	All built (no stubs): Mymi sproc importer (repurpose introspect-sync-pipelines.mjs) + generic SQL-script importer + YAML manifest importer + catalog-walk importer + recorder importer (captures live ad-hoc sync via event_log+ALS, derives draft entity from observed statements); every draft goes through human review — never auto-saved
P0.7	Entity wizard UI	5-step (Identity → Root → Closure → SCD2 → Review); each step independently re-editable; bulk re-strategy / bulk policy; live recipe-projection preview at closure+SCD2 steps showing actual SQL that will be generated
P0.8	Entity registry runtime (the code refactor)	New EntityRegistry service + RecipeProjector pure function; deletes VALID_ENTITY_TYPES set + EntityType union; rewrites loadRecipes() in recipes.ts to project from registry; tool descriptions regenerated dynamically from registry (LLM sees the live entity list); backward-compat shim auto-imports legacy sync-recipes.json as mymi-abi template on first start
P0.9	Lineage editor + importers	LineageRef records (versioned same model); sp_depends importer + view-definition parser (sys.sql_modules FROM/JOIN extraction) + YAML manifest importer all built; visual graph view of lineage neighborhood; curated overrides supersede auto-imports with provenance tracking
P0.10	Template system	Bundled: mymi-abi (current 6 entities + Revenue/Balances lineage + mymi-scd2 strategy), generic-scd2-mssql, empty; manifest with version/requires/contents; templates publishable via export flow; per-record decisions on upgrade preserve tenant customizations; optional signature verify on import
P0.11	Config edits are change-control events	Every write to entity/strategy/env/lineage/template/signer/policy/freeze/notification config flows through propose→approve→execute→evidence (same queue as data syncs); bootstrap-admin mode for first-install chicken-and-egg; bulk imports = one approval per batch with full diff manifest
P0.12	Migration of existing Fork 1 data	One-shot, idempotent, logged, audited; auto-snapshots backup before running; imports legacy files as mymi-abi@1.0 template install; in-flight proposals complete against pre-migration snapshots; migration produces its own evidence envelope; rollback CLI tested
Phase 0 acceptance (all 10 must pass before any F1.x work): Mymi-template install reproduces pre-Phase-0 behavior bit-for-bit · empty-template install on non-Mymi MSSQL fixture defines + executes 2 entities end-to-end · YAML round-trip byte-identical · old proposals project against old entity-def-versions correctly + edit-envelopes verify · cross-tenant isolation on same-named contract entity · recorder importer produces draft acceptable with ≤3 edits · migration test on real pre-Phase-0 DB-shape preserves all envelopes + schedules · custom schemaAllowlist confirmed never touches core/gate/etc via SQL trace · stub PostgresProvider compiles in tree without leaking MSSQL outside MssqlProvider · template upgrade mymi-abi@1.0→1.1 preserves customizations.

FORK 1 — Reconciliation Proposer (fully featured, no MVP cuts)
Single shipped feature. All thirteen sub-features required for "shipped":

#	Sub-feature	What's complete about it
F1.1	Proposer pass	3 finding kinds (drift / row-OOS / new-entity), bounded concurrency, deterministic, SSE-streamed, persisted runs, idempotent supersede
F1.2	Proposal storage	Full state machine (open→previewed→executed/dismissed/snoozed/superseded), 1yr retention, supersede chain
F1.3	Risk annotator (LLM)	Strict JSON schema, lineage+90d audit+last-5-syncs as context, reproducible, critical-tier on PII/freeze/large-delete, failure = critical (never auto-downgrade)
F1.4	Ranking + grouping	Multi-key sort, entity/env/lineage-cluster grouping, dependency-aware
F1.5	Scheduler	Per-pair cron, concurrency control, retry/backoff, graceful shutdown, health endpoint, pause/resume
F1.6	Proposals UI	List+filter+detail+bulk-actions+keyboard nav+a11y+history, pre-fills existing widget (no new sync UI)
F1.7	Approval workflow	None/single/dual policies, signed approval URLs, plan-drift-on-approval re-validation, expiry, self-approval refusal, emergency bypass with heightened evidence
F1.8	Evidence envelope	JSON + PDF + JWS signing (pluggable KMS: HMAC/file/AWS-KMS/Azure-KV/GCP-KMS), full chain, immutable-store sink, offline verifier CLI with structured exit codes
F1.9	Admin UI	Envs/allowlist/policies/scheduler/notifications/signer/retention CRUD — every admin action itself produces evidence
F1.10	Notifications	Email + Teams + Slack all built (not "later"), per-user routing, delivery tracking, DLQ visible in UI
F1.11	Independent post-execute verification	Agent re-runs counts + sampled row-hashes + downstream lineage probes; anomalies → critical follow-up proposal + notification
F1.12	Metrics dashboard	Volume/approval-rate/MTTA/MTTE/dismissal-reasons/annotator-quality/scheduler-SLA/signer-health, Prometheus export
F1.13	Runbook + auditor guide	Operator runbook + auditor's standalone verification guide
Fork 1 acceptance (all 9 must pass): deterministic re-runs; 100% schema-valid annotations; approval refuses self/drift/expired; envelope passes offline verifier on 4 tamper variants; PDF round-trips; all 3 notification adapters smoke-pass; independent verification catches injected corruption; 5-day live run ≥80% acceptance rate; admin actions are themselves auditable.

FORK 2 — Change-Control Substrate (direct successor, not replacement)
Premise: Fork 1 proved "proposer + ranker + approval + signed evidence" is wanted. Fork 2 generalizes it as substrate hosting packs. Pack #1 = MSSQL/Mymi (lifted from Fork 1, parity preserved). Pack #2 = Snowflake RBAC (new, locked-in choice — same buyer, same audit pain, large market, different enough to force a real seam).

#	Capability	Fully-featured requirements (no "we'll add later")
F2.1	Pack model	Formal ChangeControlPack interface (catalog/recipes/proposer/investigator/risk/plan/evidence/lifecycle/metadata), semver, multi-version coexistence, contract tests, manifest, isolation, version-upgrade-as-change-control
F2.2	Pack SDK	@change-control/pack-sdk npm + init/verify/simulate CLI + full author docs + fixture-replay harness
F2.3	Pack registry	Private registry, signed publish, vuln scan, atomic install with contract-test gate, per-tenant pinning, public registry deferred but architecturally ready
F2.4	Pack #1 (MSSQL)	Fork 1 lift-and-shift to pack interface, in-place migration, feature parity, doubles as substrate integration test
F2.5	Pack #2 (Snowflake RBAC)	All 8 recipe types (role / userRoleGrant / objectGrant / warehouse / maskingPolicy / rowAccessPolicy / tag / networkPolicy), ACCOUNT_USAGE+INFORMATION_SCHEMA drift, role-graph investigator, access-history post-verify, OAuth+key-pair auth, rollback DDL captured in evidence
F2.6	Multi-pack scheduler	Cross-pack queue, priority by tier, per-target-system rate limiting, cross-pack dependency clustering, SLA tracking
F2.7	Policy/approval engine	7 roles, full RBAC matrix, DAG-based multi-stage policies, delegated approval, escalation, freeze-window calendars, emergency bypass with post-hoc review SLA, policy-as-code export
F2.8	Identity (SSO/SCIM)	SAML 2.0 + OIDC (both), SCIM 2.0 provisioning, group→role mapping, MFA signal in evidence, mTLS option for API
F2.9	Multi-tenancy	All 3 isolation models (SaaS shared / customer-VPC / on-prem air-gapped), per-tenant data residency, cross-tenant guards at every layer, full provisioning + deprovisioning workflows
F2.10	Notifications (extended)	F1.10 + ServiceNow + Jira + PagerDuty + generic webhook, all built
F2.11	Evidence (generalized)	Versioned envelope wraps versioned pack body; KMS adapters: AWS/Azure/GCP/Vault/file; key-rotation flow; immutable stores: S3-OL/Azure-Blob-immut/GCP-Bucket-Lock/on-prem-WORM; bulk signed export for auditors
F2.12	Observability	Multi-pack dashboards, cross-pack rollups, platform-level ops dashboards, Prometheus + OpenTelemetry, pre-built Grafana
F2.13	Public API + webhooks	REST + GraphQL, HMAC-signed webhooks with DLQ, OpenAPI + GraphQL schema, client libs for TS/Python/Java
F2.14	Deployment models	SaaS multi-tenant + customer-VPC (Helm + TF for AWS/Azure/GCP) + air-gapped on-prem (with on-prem LLM option), all 3 tested in CI
F2.15	Compliance	SOC2 Type II from day one, ISO 27001 alignment, GDPR DSR tooling + PII redaction, HIPAA-eligible config, quarterly pen-test
F2.16	Cross-pack reasoning (uniquely-substrate feature)	Lineage joins across packs, coordinated multi-pack execute under unified envelope, cross-pack rollback proposal on partial failure, cross-pack risk escalation
F2.17	Pricing/metering	Per-event metering, platform-sub + per-pack-sub + per-change overage, usage dashboard, Stripe for SaaS / flat-fee for on-prem, free tier defined
F2.18	DR/BCP	SaaS RPO≤5min, RTO≤1h, warm standby tested quarterly, daily encrypted cross-region backups with monthly verified-restore, evidence-store own backup chain
Fork 2 acceptance (all 10 must pass): Snowflake pack passes contract + conformance suites; 2 packs run concurrently with unified cross-pack envelope; SSO works on Okta+AAD+generic SAML; multi-tenant isolation 100% blocked at every layer; KMS rotation drill (old envelopes still verify); air-gapped install with on-prem LLM completes full loop; SOC2 sample-month passes mock-audit; DR drill meets RTO/RPO; cross-pack coordinated execute on planted divergence; pack version upgrade preserves old-envelope verification.

Sequencing (acceptance-gated, not month-windowed)
Fork 1 ships when: all F1 acceptance pass + ≥1 design-partner customer ran it 30 consecutive days in prod
Fork 2 starts when: Fork 1 above + ≥2 paying customers + ≥1 explicitly asking for a 2nd system + Fork 1 codebase clean enough that lifting MSSQL to pack is 2 weeks (not a rewrite)
Fork 2 ships when: all F2 acceptance pass + Snowflake pack ≥1 paying customer 30d in prod alongside MSSQL pack + ≥1 customer-authored pack hosted (proves SDK is real)


# Plan: Reconciliation Proposer (Fork 1) + Change-Control Substrate (Fork 2)

**Date**: 2026-05-16
**Branch**: `feature/reconciliation-proposer`

## What the agent is, in one sentence
**The on-call DBA the customer doesn't have, hovering over the same widget the human uses when they're at their desk.** It authors proposals (humans don't), runs continuously (widgets don't), navigates lineage graphs (widgets can't), risk-annotates human-authored plans (widgets don't reason), and independently verifies post-execute outcomes (widgets don't double-check). Anything that doesn't fit this definition is not the agent's job.

The plan that follows commits to this definition concretely in Fork 1 and generalizes it across systems in Fork 2.

---

# FORK 1 — Reconciliation Proposer (one branch, fully featured, no minimal versions)

The single shipped feature for Fork 1 in this branch. All sub-features are required for "shipped"; there is no MVP cut line below.

## F1.1 — Proposer pass (deterministic discovery)

**What**: Function `runProposerPass(envPair)` in `packages/sync/src/proposer/pass.ts`. Pure code, no LLM.

**Complete requirements**
- Discovers three kinds of findings, all required:
  1. **Schema drift** — wraps existing `detectCatalogDrift` over recipe tables for every entity type
  2. **Row-level out-of-sync** — for each `EntityType` runs `previewSync(..., { dryRun: true })`, captures per-entity insert/update/delete/unchanged counts
  3. **New entities** — entity rows present on source but with no PK on target at all (separated from "update" because risk profile differs)
- Bounded concurrency (max 4 entity types in parallel per env-pair; configurable per env in `environments.ts`)
- Per-entity timeout (default 60s); failures captured as `proposerError` rows, not silently swallowed
- Deterministic: re-running over an unchanged source produces byte-identical proposal payloads (verified by test)
- Emits SSE events (`proposer.pass.started`, `proposer.entity.scanned`, `proposer.pass.completed`) on the existing event bus so the UI shows live progress
- Persists a `proposer_runs` row (id, envPair, startedAt, finishedAt, status, counts, error if any) for full audit
- Idempotent re-runs collapse identical findings against open proposals (no duplicate rows)

## F1.2 — Proposal storage (schema + lifecycle)

**What**: New SQLite tables, migrations in `packages/server/src/db/`.

**Complete requirements**
- `sync_proposals` table: `id, generated_at, env_pair, entity_type, entity_id, entity_label, kind ('drift'|'out_of_sync'|'new'), counts_json, risk_tier ('low'|'medium'|'high'|'critical'), risk_score (0-100), rationale_md, recommended_window, status, snoozed_until, dismissed_reason, dismissed_by, dismissed_at, executed_plan_id, executed_by, executed_at, superseded_by, originating_run_id`
- `proposer_runs` table (see F1.1)
- Status state machine: `open → previewed → executed | dismissed | snoozed | superseded`. Transitions validated in code; illegal transitions throw
- Superseding: when a new proposer pass finds the same entity still out of sync, the old proposal is `superseded_by` the new one (preserves audit trail)
- Retention: completed/dismissed proposals retained 1 year by default, configurable per tenant

## F1.3 — Risk annotator (this is the LLM's job)

**What**: `annotateProposal(proposalId)` in `packages/sync/src/proposer/annotate.ts`. Where the agent earns its place.

**Complete requirements**
- Inputs to the model: the proposal payload, the lineage subgraph for the entity from `lineage.json`, the entity's last 90 days of audit_log activity, the last 5 executions of similar (same entity type, same env-pair) syncs and their outcomes, current calendar (is this a known change-freeze window?), and the recipe `executionOrder` + table list
- Outputs (strict JSON schema, validated):
  - `riskTier` in {low, medium, high, critical}
  - `riskScore` 0–100 with documented rubric
  - `rationale` 3–6 sentences explaining the score in plain English
  - `recommendedWindow` (ISO datetime range or "any")
  - `dependsOn` (list of other entity ids the model thinks should be synced first, may be empty)
  - `warnings` (list of structured warnings: known-failure-mode, lineage-impact, freeze-window-violation, large-delete-batch, etc.)
- Critical-tier triggers: any proposal that would delete >100 rows, touch a table referenced by a `publish.*` view in `lineage.json`, or fall in a configured freeze window
- Annotation is reproducible: same inputs → same outputs (low temperature + cached). Audit envelope captures model name, version, prompt hash, response hash
- Failures: if the annotator can't run (LLM down, schema validation fails after 2 retries), proposal is saved with `riskTier='critical'` + rationale explaining the annotation failure — never auto-downgraded
- All annotation calls billable through existing LLM token accounting

## F1.4 — Ranking + grouping (across the proposal queue)

**What**: `rankProposals(envPair)` orders all open proposals for display.

**Complete requirements**
- Ranking inputs: risk tier (primary), risk score (secondary), age (older first within tier), lineage centrality (entities feeding multiple `publish.*` views weighted up), `dependsOn` ordering (dependencies above dependents)
- Grouping: proposals can be displayed flat or grouped by entity-type, by source-env, or by lineage cluster (e.g. all proposals impacting `publish.Revenue` together)
- Bulk-action support in ranking: a "promote all from dev→uat for contract X" virtual group when multiple proposals share an entity ancestor

## F1.5 — Scheduler (production-grade)

**What**: `packages/server/src/proposer/scheduler.ts`.

**Complete requirements**
- Per-env-pair cron schedule, configurable in environments config (`proposerSchedule: "0 7 * * MON-FRI"` style; defaults provided)
- On-demand trigger via `POST /api/sync/proposer/run` (env-pair body)
- Concurrency control: one in-flight pass per env-pair (next trigger queued, not parallel)
- Failure handling: failed run logged + alerted (notification adapter, F1.10) + retried with exponential backoff up to 3 times
- Graceful shutdown: in-flight passes finish before server exit
- Health endpoint: `GET /api/sync/proposer/health` returns per-env-pair last run, last success, last failure, current state, next scheduled
- Pause/resume controls in admin UI (F1.9)

## F1.6 — UI: Proposals tab in EnvSync widget (fully featured)

**What**: New tab/panel in `packages/ui/src/widgets/EnvSync/`.

**Complete requirements**
- List view: all open proposals, ranked per F1.4; columns: severity badge, entity, kind, counts, age, recommended window, actions
- Filters: env-pair, entity type, risk tier, status, lineage cluster, freeform search
- Per-proposal detail panel: full counts breakdown, rationale, warnings, `dependsOn` graph (mini-viz), audit history of prior syncs for this entity, button group
- Actions per proposal: **Preview** (pre-fills the existing sync widget form and switches tabs — no new sync UI built), **Dismiss with reason** (required reason text, captured for audit), **Snooze until** (date picker), **Re-rank now** (re-runs annotator)
- Bulk actions: select multiple → preview-as-batch (validates dependency order, refuses if dependencies conflict), dismiss-batch (one reason)
- Live updates: SSE-driven, no polling; new proposals appear at the top with subtle animation
- Empty state: explains the proposer + last-run timestamp + "Run now" button
- History view: dismissed/executed/superseded proposals with full timeline per proposal
- Keyboard navigation: full (j/k/x/p/d/s muscle-memory for power users)
- Accessibility: WCAG AA — keyboard, screen reader, no color-only severity

## F1.7 — Approval workflow (production-grade)

**What**: Multi-stage approval for execute. Today's single `confirm:true` is insufficient for prod.

**Complete requirements**
- Approval policy per env-target: `none` (dev), `single-approver` (uat — anyone in `syncAllowlist`), `dual-approver` (prod — two distinct UPNs from `syncAllowlist`, neither can be the executor)
- Approval requests: when executor clicks "execute" on a prod proposal, the proposal moves to `awaiting_approval` state and approvers are notified (F1.10). A signed approval URL routes to a one-click approve/reject screen with the full plan diff visible
- Approvals captured with: approver UPN, timestamp, IP, user-agent, decision, comment (required for reject). HMAC-signed token to prevent forgery
- Approval expiry: 24h default (configurable). Expired approvals require re-request, plan re-previewed to catch source drift between approval and execute
- "Plan drift on approval" check: if the preview re-runs and the diff has changed since approval, approval is invalidated and re-requested (with diff-of-diffs shown)
- Self-approval refusal: executor cannot approve their own (or for dual: same person can't be both approvers)
- Emergency bypass: configurable per env (`allowEmergencyBypass: true`); when used, requires a written reason and triggers heightened-evidence mode (extra envelope fields, immediate notification to all `syncAllowlist` members + admin)
- All approval events captured in audit_log AND attached to the evidence envelope (F1.8)

## F1.8 — Evidence envelope (fully featured: JSON + PDF + signing + verifier)

**What**: One artifact per executed sync, signed, tamper-evident, both machine- and human-readable.

**Complete requirements**

JSON envelope (`evidence-<planId>.json`):
- Identity: executor UPN + session fingerprint + IP; approver(s) UPN/timestamp/IP/decision/comment; tenant id
- Subject: source env, target env, entity type + id + display label, linked-server name
- Plan provenance: plan id, originating proposal id (if any), agent rationale + risk tier (if any), recipe-snapshot SHA-256, source-state SHA-256 (PKs+row-hashes at preview time), preview counts per table with per-table sample rows (configurable redaction policy for PII)
- Approval chain: every approval/reject/expiry event with full attestation
- Execution: every SQL statement executed (from `event_log` with ALS attribution), per-table durations, per-table row counts, final commit/rollback verdict, source target-DB transaction id, total wall-clock
- Outcome: post-execute hashes for rows actually written; comparison to plan's expected post-state; any deltas highlighted
- Independent verification (F1.11): result of post-execute validation queries the agent re-runs without re-using the executor's SQL
- Chain: SHA-256 chain across sections (each section hashes the previous + its own content + a per-envelope nonce)
- Signature: detached JWS over the canonical JSON. Key from pluggable signer (env-var HMAC for dev, file-based RSA for on-prem, AWS KMS / Azure Key Vault / GCP KMS for cloud — adapter pattern)
- Schema version + tenant policy version captured so future verifier knows how to interpret

PDF render (`evidence-<planId>.pdf`):
- Generated from the same canonical JSON (single source of truth — PDF is a renderer, never authoritative)
- Cover page: who/what/when/where/authority, signature status, verification instructions QR
- Section per envelope field, formatted for a non-developer auditor
- All SQL pretty-printed with syntax highlighting, table samples in proper tables not JSON dumps
- Page-footer with envelope hash + page number
- Embedded JWS signature block (auditor can extract the JSON from the PDF attachments and re-verify)

Storage:
- Written to `data/evidence/<yyyy>/<mm>/<planId>.{json,pdf}` plus row in `evidence_index` table
- Optional immutable-store sink (S3 Object Lock / Azure Blob immutability) configurable per tenant

Retrieval:
- `GET /api/sync/evidence/:planId` returns either format (Accept header)
- `GET /api/sync/evidence?envPair=&from=&to=&entityType=` for the audit search UI

Verifier:
- `scripts/verify-evidence.mjs <file.json>` — full chain verification + signature verification + canonical JSON re-hashing
- Returns structured exit code (0 ok, 10 chain broken, 20 signature invalid, 30 schema unknown, 40 tampered)
- Documented for auditors to run standalone (no server access required) — must work offline given just the JSON and a public verification key

## F1.9 — Admin UI

**What**: New "Change Control" admin section in UI.

**Complete requirements**
- Environments CRUD (today edited via JSON file — must move to UI with audit trail of who edited what)
- `syncAllowlist` management with SSO user picker
- Approval policy per env (none/single/dual + bypass toggle + freeze windows)
- Scheduler per-env-pair config + pause/resume + last-run health
- Notification routing per severity (F1.10)
- Signer config (which KMS, which key, rotation schedule)
- Evidence retention policy
- All admin changes themselves produce evidence envelopes (admin actions are change-control too)

## F1.10 — Notifications

**What**: Adapter-based routing for events that need humans.

**Complete requirements**
- Events: new high/critical proposal, approval requested, approval granted/rejected/expired, scheduler failure, execute failure, evidence-signing failure
- Adapters: Email (SMTP), Microsoft Teams (incoming webhook), Slack (incoming webhook). All three implemented (no "we'll add Teams later")
- Templates per adapter per event type (handlebars-style), customizable per tenant
- Per-user routing rules (this approver wants Teams DM for prod, email for uat)
- Delivery tracking: each notification attempt logged with success/failure, retried 3x exp backoff, dead-letter visible in admin UI
- Bounce/failure surfaced in UI alongside the originating proposal/approval so nothing silently disappears

## F1.11 — Independent post-execute verification

**What**: After execute commits, the agent independently re-validates outcomes (humans skip this; agent doesn't).

**Complete requirements**
- For each table touched, agent issues a fresh `SELECT COUNT(*) ... WHERE <recipe predicate>` against target and compares to envelope's expected post-state
- For new/updated entities, agent re-fetches a stratified sample (5 random rows) from target and compares row-hashes to source — must match
- Lineage downstream check: for each `publish.*` view downstream per `lineage.json`, agent runs row count + last-modified probe pre/post to detect collateral damage
- Anomalies appended to envelope under `independentVerification` with explicit pass/warn/fail status
- A failed verification does NOT auto-rollback (commit already happened) but raises a critical-tier follow-up proposal to investigate, plus immediate notification

## F1.12 — Metrics dashboard

**What**: New "Operations" tab in admin UI.

**Complete requirements**
- Per-env-pair: proposal volume by tier over time, approval-rate, mean-time-to-approve, mean-time-to-execute, dismissal-rate-with-reasons (top reasons surfaced — feedback loop for ranker quality)
- Annotator quality: percentage of executed proposals where agent's risk tier matched human's after-the-fact judgement (collected via a one-click thumbs-up/down on each executed proposal)
- Scheduler SLA: percent of scheduled runs completed on time, percent of envs with drift currently
- Evidence integrity: count of envelopes signed, count of failures, last signer health check
- All metrics exported as Prometheus endpoint for external observability

## F1.13 — Documentation + runbook

- Operator runbook covering: scheduler tuning, approval policy guidance, signer rotation, freeze-window calendar, evidence retention, incident response (executor down, KMS unavailable, drift detected mid-pass)
- Auditor's verification guide (how to run `verify-evidence.mjs`, how to interpret a PDF, where the signing key chain comes from)
- Pack-author preparation note (internal, for Fork 2 prep): which interfaces the proposer/annotator/evidence-assembly call into today — this is the inventory Fork 2 generalizes

## F1 verification (Fork 1 acceptance — all must pass)

1. Proposer pass against a known-divergent UAT env-pair produces deterministic proposal set; running twice with no source change yields zero new proposals
2. Annotator output matches its schema 100% across a 100-proposal regression set; reproducibility test passes
3. Approval workflow refuses self-approval, refuses execute when source has drifted since approval, expires approvals correctly, emergency-bypass logs all required fields
4. Evidence envelope passes verifier offline (no server) with both happy path and 4 tamper variants (each tamper detected with correct exit code)
5. PDF round-trip: extract JSON from PDF, verify, hashes match
6. Notification adapters: smoke test for SMTP, Teams, Slack — all deliver, all retry, all surface failures in UI
7. Independent verification catches a deliberately-corrupted target row (test injects bad data post-execute, verifier flags it)
8. 5-day live run against own dev/uat: ≥80% of surfaced proposals would be approved by the human operator (acceptance bar for ranker quality)
9. All admin actions produce their own evidence envelopes; "admin sets new approval policy" is itself auditable

---

# FORK 2 — Change-Control Substrate ("the on-call expert, for every system")

**Premise**: Fork 1 proved that "proposer + ranker + approval + signed evidence" is a thing customers want. Fork 2 generalizes that loop across systems by re-shipping it as a **substrate** that hosts **packs**. The first two packs are MSSQL/Mymi (lifted from Fork 1) and **Snowflake RBAC** (new). Same loop, different domain knowledge.

**Why Snowflake RBAC as pack #2 (locked-in decision, not deferred)**:
- Same buyer (data platform owner)
- Same pain (changes that need audit but have no source-of-truth Git)
- Mature auditor expectations around grants/roles/warehouses/masking policies
- Snowflake's `ACCOUNT_USAGE` views give us the same "drift query" + "audit history" we used for MSSQL
- Different enough from MSSQL row-metadata sync that it forces the seam to be real (not a thin wrapper)
- Large addressable market — Snowflake is in every modern data team

## F2.1 — Pack model (formal, complete)

A pack is a Node package implementing `ChangeControlPack` interface. Five required capabilities:

```
catalog:        snapshot(env), drift(envA, envB, scope?)
recipes:        list(), get(entityType), validate(env)
proposer:       scan(envPair, opts) → ProposerFinding[]
investigator:   investigate(question, scope) → InvestigationResult
risk:           annotate(finding, context) → RiskAnnotation
plan:           preview(args) → Plan, execute(planId, approval) → Result
evidence:       schema(), assemble(planId) → EvidenceBody (substrate wraps in envelope)
lifecycle:      init(config), healthCheck(), shutdown()
metadata:       id, version, displayName, supportedConnectorTypes, ownerContact
```

**Complete requirements**
- Pack identity is a stable string + semver. Two pack versions can coexist (one tenant pins to a version)
- Pack manifest in `pack.json` with declared capabilities, required connector types, required permissions on target system, declared evidence schema version
- Pack ships with: contract tests (run by substrate at install time + nightly), example fixtures, doc index
- Substrate enforces pack isolation: pack runs in its own module scope with declared dependencies; cannot reach into substrate internals beyond the exposed interfaces
- Pack version upgrade is itself a change-control event (substrate proposes "upgrade pack X 1.2 → 1.3 in tenant Y", auditor sees evidence)

## F2.2 — Pack SDK (the kit pack authors use)

**Complete requirements**
- `@change-control/pack-sdk` npm package: types, base classes, test harness, dev CLI
- `npx pack-sdk init <name>` scaffolds a pack with all eight capabilities stubbed + sample tests
- `npx pack-sdk verify` runs the contract test suite locally against the pack
- `npx pack-sdk simulate` runs a full propose→approve→execute→evidence cycle against a recorded fixture system so authors don't need the live system to iterate
- SDK docs: end-to-end pack-author tutorial, capability-by-capability reference, evidence-schema cookbook, troubleshooting guide
- SDK stays separate from substrate code — versioned independently — so substrate can evolve without breaking packs

## F2.3 — Pack registry + distribution

**Complete requirements**
- Private registry (substrate-hosted) with: pack publishing CLI for authors, signature on publish (author's key), tenant pull with version pinning, vulnerability scan on publish, deprecation flags
- Pack install = atomic: download, signature-verify, run contract tests in isolated sandbox, only then make available to tenant
- Per-tenant pack catalog: which packs enabled, which version, which config
- Public registry: out of scope for Fork 2 v1 (the registry code is generic enough to flip to public later — designed that way, not retrofitted)

## F2.4 — Pack #1: MSSQL/Mymi (lifted from Fork 1)

**Complete requirements**
- The Fork 1 sync/recipe/proposer/annotator/evidence code is refactored to implement `ChangeControlPack` — no behavioral change for existing customers
- Migration path: existing Fork 1 deployments upgrade in place; their environments + audit history are preserved; first-run migration converts internal state to pack-model schema
- Continues to ship as the reference pack — its tests double as substrate integration tests
- Maintained at feature parity with Fork 1 through Fork 2 release (no regressions; Fork 1 capabilities all reachable through pack interface)

## F2.5 — Pack #2: Snowflake RBAC (new, fully built)

**Complete requirements** (each capability fully implemented, not stub)

Catalog:
- Snapshot via `INFORMATION_SCHEMA` + `ACCOUNT_USAGE.GRANTS_TO_ROLES`, `GRANTS_TO_USERS`, `ROLES`, `WAREHOUSES`, `MASKING_POLICIES`, `ROW_ACCESS_POLICIES`, `TAGS`
- Drift: compare role hierarchies, grants, warehouse configs, masking-policy bodies, tag assignments between two accounts (typically dev account ↔ prod account)

Recipes:
- `role` (CREATE/ALTER/DROP ROLE + role-to-role grants)
- `userRoleGrant` (USER → ROLE)
- `objectGrant` (privilege on DB/schema/table/view to role)
- `warehouse` (size, auto-suspend, auto-resume, scaling policy, resource monitors)
- `maskingPolicy` (policy body, attachments)
- `rowAccessPolicy` (policy body, attachments)
- `tag` (definition + assignments)
- `networkPolicy` (allow/block CIDR lists)
- All recipes verified against Snowflake DDL semantics; execution order respects dependencies (role exists before grant to it)

Proposer:
- Detects: missing-in-prod role/grant/warehouse, drifted warehouse settings (e.g. dev sized larger), masking-policy divergence (security-critical, always critical tier), tag assignment drift, unauthorized grants (grants in prod not in dev source-of-truth)
- Scans use `ACCOUNT_USAGE` (12-hour lag acceptable, declared in finding metadata) supplemented by `INFORMATION_SCHEMA` for fresh views

Investigator:
- "Who can read table X?" — role-graph traversal
- "When did this grant appear and who issued it?" — `QUERY_HISTORY` + `ACCESS_HISTORY` walk
- "Why is this masking policy in effect?" — policy chain
- "What changed for role R in the last 7 days?" — diff against snapshot history

Risk:
- Annotator inputs: change type, target object sensitivity (tag-driven), lineage downstream impact, last similar change outcome, role membership cardinality (granting to PUBLIC = critical)
- Critical triggers: any grant to PUBLIC, any masking-policy weakening, any new network-policy entry, any grant on tagged-as-PII objects

Plan/execute:
- Preview generates DDL with full rollback DDL alongside (Snowflake supports re-grant/re-create patterns reliably); rollback DDL captured in evidence
- Execute runs in a transaction where Snowflake supports it; non-transactional DDLs are sequenced with per-statement evidence so partial failures are fully auditable
- Per-statement timing + per-statement `QUERY_ID` captured (Snowflake's native trace id) for cross-reference

Evidence body:
- Snowflake-specific: list of objects affected, role-graph diff, `QUERY_ID`s for every executed statement, `ACCESS_HISTORY` verification post-execute showing the new grant actually took effect
- Substrate wraps in universal envelope; auditor sees both pack body and envelope chain

Connector:
- OAuth + key-pair auth supported; key rotation flow built in
- Per-env Snowflake account binding

## F2.6 — Substrate: scheduler + proposal queue (multi-pack)

**Complete requirements**
- One scheduler for all packs across all tenants; per-pack-per-env-pair cadence
- Priority queueing: critical-tier findings jump ahead of low-tier across packs
- Rate limiting per target system (don't hammer Snowflake or MSSQL with parallel scans)
- Cross-pack dependency awareness: if Snowflake pack discovers a grant on a Mymi-mapped table, and MSSQL pack has a pending sync for that table, surface them together as a coordinated proposal cluster (Fork 1 already had "depends-on"; Fork 2 makes it cross-pack)
- SLA tracking per pack per tenant; SLA breach raises operational notification

## F2.7 — Substrate: policy + approval engine (full RBAC)

**Complete requirements**
- Roles: `viewer`, `proposer-operator` (can trigger scans), `executor`, `approver`, `pack-admin`, `tenant-admin`, `platform-admin`
- Permissions matrix: per role × per pack × per env × per action (preview/execute/approve/dismiss/configure)
- Multi-stage approval policies: configurable as a DAG ("uat needs 1 approver from team A; prod needs 1 from team A AND 1 from team B; freeze-window violation needs platform-admin")
- Delegated approval: an approver can delegate to a named person for a time window (recorded in evidence)
- Escalation: pending-approval past threshold auto-escalates to next person in chain
- Change-freeze calendars per env, per pack, per tenant (override requires policy permission + extra evidence)
- Emergency bypass: requires `platform-admin` + reason + post-hoc review SLA (auto-creates a follow-up review task)
- Policy engine is data-driven (YAML/JSON in tenant config) with a UI editor and a policy-as-code export

## F2.8 — Substrate: identity (SSO/SCIM)

**Complete requirements**
- SSO via SAML 2.0 AND OIDC (both, not one)
- SCIM 2.0 user/group provisioning (so corporate IdP pushes users + group membership automatically)
- Group-to-role mapping per tenant (AD/Okta group → substrate role)
- Session management: configurable timeout, idle timeout, forced re-auth for execute/approve actions, MFA enforcement signal from IdP captured in evidence
- API auth: service accounts with scoped tokens for CI/CD integration; short-lived JWTs; mTLS option

## F2.9 — Substrate: multi-tenancy

**Complete requirements**
- Tenant isolation models, all supported:
  - Shared-DB schema-per-tenant (SaaS multi-tenant)
  - Single-tenant DB (customer-VPC deployment)
  - Fully on-prem air-gapped (customer-managed)
- Per-tenant config: enabled packs, pack versions, policy, signer, notification routing, retention, branding
- Per-tenant data residency: tenant config declares region; all storage + processing constrained
- Cross-tenant operations forbidden at every layer (enforced by middleware + DB-row guards + integration test suite)
- Tenant provisioning + deprovisioning workflows fully built (deprovision = export-all-evidence + delete with proof)

## F2.10 — Substrate: notification routing (generalized from F1.10)

**Complete requirements**
- All F1.10 adapters carry over (Email, Teams, Slack)
- Add: ServiceNow ticket creation, Jira issue creation, PagerDuty incident (each as adapter, fully built)
- Per-tenant routing rules; per-pack templates
- Webhook adapter for arbitrary downstream integration
- Delivery audit (every notification tracked end-to-end, surfaced in admin UI)

## F2.11 — Substrate: evidence (generalized envelope + signing infra)

**Complete requirements**
- Envelope schema versioned; envelope wraps pack-supplied body (pack body schema versioned independently)
- Signer adapters fully built: AWS KMS, Azure Key Vault, GCP KMS, HashiCorp Vault, file-based (on-prem)
- Key rotation: orchestrated rotation flow; old envelopes remain verifiable (signing key + version captured in envelope)
- Immutable-store adapters: S3 Object Lock, Azure Blob immutability, GCP Bucket Lock, on-prem WORM (filesystem with append-only attribute + offsite backup hook)
- Evidence-chain visualization in UI: timeline view per envelope showing every event from proposer-scan → annotation → preview → approval → execute → independent-verification
- Bulk export: tenant admin can export N envelopes (date range + filters) as signed `.tar.gz` with a master manifest signed by the tenant's key — for handing to external auditors

## F2.12 — Substrate: observability + metrics (generalized from F1.12)

**Complete requirements**
- Multi-pack dashboards: per-pack proposer health, per-pack approval funnel, per-pack annotator quality
- Cross-pack rollups per tenant: total changes proposed, approved, executed, rolled-back
- Platform-level dashboards for substrate ops: tenant health, signer health, queue depth, SLA breaches
- Prometheus metrics + OpenTelemetry traces throughout; pre-built Grafana dashboards
- Audit log of substrate itself (who configured what, when) — substrate's own actions are change-control events

## F2.13 — Substrate: public API + webhooks

**Complete requirements**
- REST API covering: list/create/dismiss proposals, request approval, execute, fetch evidence, list runs, run scheduler on-demand
- GraphQL API for complex queries (proposal cluster traversal, lineage walks across packs)
- Webhook subscriptions per tenant (event types from F2.10 list); HMAC-signed payloads; delivery retry + DLQ
- OpenAPI + GraphQL schema published; client libraries for TS, Python, Java
- Rate limiting + tenant-scoped tokens

## F2.14 — Substrate: deployment models (all supported)

**Complete requirements**
- SaaS multi-tenant (hosted by vendor): full CI/CD, blue-green deploys, zero-downtime upgrades
- Customer-VPC single-tenant (Helm chart + Terraform modules for AWS/Azure/GCP)
- Fully on-prem air-gapped: offline installer, no outbound dependencies at runtime, internal LLM option supported (Ollama / vLLM / Azure OpenAI in tenant's own subscription)
- Same code, deployment-mode-aware config; tested in CI in all three modes

## F2.15 — Substrate: compliance posture

**Complete requirements**
- SOC2 Type II readiness from day one: controls inventory, evidence collection automated, annual audit calendar
- ISO 27001 alignment
- GDPR: data-subject rights tooling (export, delete, restrict), PII tagging on evidence samples with redaction rules
- HIPAA-eligible deployment configuration (BAAs, encryption at rest + transit, audit log retention 6+ years)
- Penetration test cadence: quarterly external, monthly internal
- Threat model maintained; reviewed quarterly

## F2.16 — Cross-pack reasoning (the unique-to-substrate feature)

**Complete requirements**
- Lineage join across packs: MSSQL pack publishes "table T feeds publish.Revenue"; Snowflake pack publishes "external table E reads from T's published export". Substrate joins these so a proposal on T surfaces a recommended Snowflake action too
- Coordinated execute: a multi-pack plan can be approved + executed as one unit (each pack's portion executes within its own transactional semantics; the substrate enforces ordering and produces a unified evidence envelope referencing per-pack envelopes)
- Cross-pack rollback: if pack A succeeds and pack B fails, substrate auto-creates a critical proposal to either retry pack B or undo pack A (does not auto-undo — surfaces choice to human)
- Cross-pack risk annotation: annotator can see findings from all packs for the same logical entity; risk tier escalates if multiple packs flag related issues

## F2.17 — Pricing + metering

**Complete requirements**
- Metering subsystem captures: tenant, pack, env-pair, event type, count — all events that drive billing
- Pricing model (configurable per tenant contract): platform subscription + per-pack subscription + per-executed-change overage
- Usage dashboard for tenant (transparent metering)
- Stripe (and equivalent) integration for SaaS; flat-fee licensing for on-prem
- Free-tier definition for evaluation (limited envs, limited proposals/month)

## F2.18 — Disaster recovery + business continuity

**Complete requirements**
- RPO ≤ 5 min for SaaS tier (continuous DB replication)
- RTO ≤ 1 hour for SaaS tier (warm standby region; documented failover runbook tested quarterly)
- Daily encrypted backups with cross-region replication; 90-day retention minimum; verified-restore test monthly
- Evidence store has its own backup chain (immutability + offsite)
- BCP documentation for customer-VPC and on-prem deployments

## F2 verification (Fork 2 acceptance — all must pass)

1. Snowflake pack passes its own contract test suite + the substrate's pack-conformance suite
2. Two packs running concurrently against the same tenant produce non-overlapping evidence envelopes; cross-pack proposal cluster produces a single unified envelope referencing both
3. End-to-end SAML SSO + SCIM provisioning works against Okta, AAD/Entra, and a generic SAML IdP (all three tested)
4. Multi-tenant isolation test suite: 100% of attempted cross-tenant reads/writes blocked at every layer
5. KMS rotation drill: rotate signing key, verify old envelopes still validate with old key, new envelopes use new key
6. Air-gapped install completes without any outbound network access; full propose→execute→evidence loop works with on-prem LLM
7. SOC2 controls evidence collection runs automatically; sample-month evidence pack passes mock-auditor review
8. DR drill: simulated region loss; failover completes within RTO; zero data loss within RPO
9. Cross-pack reasoning: planted divergence in both MSSQL recipe and Snowflake grant on same logical entity → substrate produces one coordinated proposal cluster, both packs' previews respect dependency order, single envelope on execute
10. Pack version upgrade flow: tenant upgrades MSSQL pack 1.0→2.0; previous evidence still verifies with old pack schema; new evidence uses new schema; no downtime

---

# Sequencing + decision gates (not artificial 6-month windows)

- **Fork 1 ships when** all F1 acceptance criteria pass AND ≥1 design-partner customer has operated it for 30 consecutive days in production
- **Fork 2 starts when** Fork 1 has the above + ≥2 paying customers + ≥1 customer asking out loud for a second system to be governed the same way + Fork 1 codebase has been refactored cleanly enough that lifting MSSQL into a `ChangeControlPack` is a 2-week job (not a rewrite)
- **Fork 2 ships when** all F2 acceptance criteria pass AND the Snowflake pack has ≥1 paying customer running it in production for 30 days alongside MSSQL pack AND substrate has hosted ≥1 customer-authored pack from a design partner (proves pack SDK is real, not just internal)

No artificial month windows. Acceptance criteria are the gate.

---

# Out of scope (explicit, both forks)
- Public pack marketplace (registry is private; flip to public is a later business decision, not engineering)
- General browser automation as a customer feature (kept in code, not pitched)
- WhatsApp/Messenger channels (kept in code, not pitched)
- Trajectory replay as a customer-facing feature (internal regression harness only)
- Pack #3 in Fork 2 v1 (architecture supports it; commercial decision later)
- Generic "any system" framing in marketing — Fork 2 markets the two packs concretely, then expands
