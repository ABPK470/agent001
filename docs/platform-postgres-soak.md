# Platform Postgres — staging soak runbook

Operator checklist before recommending `MIA_PLATFORM_STORE=postgres` for a
deploy that requires Postgres. Engineering owns the list; staging owners run
it. No code hard-stop — `assertPlatformStoreReady` already allows postgres.
Process default remains **sqlite** until a deploy explicitly chooses this peer.

## Preconditions

- Staging Postgres reachable with a dedicated database (empty or disposable).
- Env set: `MIA_PLATFORM_STORE=postgres` plus either `MIA_PLATFORM_PG_URL` or
  `MIA_PLATFORM_PG_HOST` / `DATABASE` / `USER` / `PASSWORD` (optional `PORT`,
  `SSL`).
- LLM env still valid (`.env` / `LLM_PROVIDER`) so seed + override succeed.
- Path-filtered CI green on a recent persistence PR (incl. live postgres job).

## Boot

1. Start the server; confirm log: `Platform store opened (postgres)`.
2. Confirm multi-dialect migrations applied (registry through v10, incl.
   `memory_entries`, caches, `search_vector` trigger + GIN).
3. Confirm seeds (strategies / policies) and LLM override without error.
4. Confirm memory prune runs (LIMIT/OFFSET path).

## Exercise (smoke under load is better, but these must pass)

| Area | Action | Expect |
| --- | --- | --- |
| Auth / session | Login, refresh session | Session rows persist |
| Runs | Create run, complete or fail | Run + events durable |
| Memory | Complete a run that ingests turns; start a follow-up in the same thread | Keyword search via tsvector (`simple`); working memory returns |
| Sync definitions | Load catalog / published definitions from platform store | Reads succeed |
| Identity insert | Trigger a path that writes `notification_log` or `sync_sql_log` | `runInsertIdAsync` / `RETURNING id` returns a single id |

## Watch

- Pool / connection errors, hung `transactionAsync`, failed migrator on restart.
- Migration drift (second boot must be no-op on applied versions).
- `search_vector` trigger firing on content/metadata updates; GIN index present.
- No accidental use of warehouse connector pools for platform life.

## Duration

Multi-day staging soak under normal traffic. Record start/end, incidents, and
whether tsvector recall met the workload bar.

## Adoption criteria (all required)

1. Path-filtered CI green including live postgres on persistence changes.
2. This soak completed with no unresolved P0 platform-store issues.
3. Memory search documented for product/support
   ([schema README](../packages/server/src/infra/persistence/schema/README.md),
   [doctrine §5c](./doctrine.md)).
4. Deploy env templates point at postgres only when that peer is the chosen store.

## Out of scope for soak

- Changing the process default away from sqlite (that stays until a deploy flips).
- Enabling SQL Server Full-Text (Track B).
- Fixing unrelated full `@mia/sync` orchestrator test suite.
