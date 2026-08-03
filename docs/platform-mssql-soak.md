# Platform MSSQL — staging soak runbook

Operator checklist before recommending `MIA_PLATFORM_STORE=mssql` as the hosted
default. Engineering owns the list; staging owners run it. No code hard-stop —
`assertPlatformStoreReady` already allows mssql.

## Preconditions

- Staging SQL Server reachable with a dedicated database (empty or disposable).
- Env set: `MIA_PLATFORM_STORE=mssql` plus `MIA_PLATFORM_MSSQL_*` (server,
  database, user, password, encrypt / trust cert as required).
- LLM env still valid (`.env` / `LLM_PROVIDER`) so seed + override succeed.
- Path-filtered CI green on a recent persistence PR (incl. live mssql job).

## Boot

1. Start the server; confirm log: `Platform store opened (mssql)`.
2. Confirm multi-dialect migrations applied (registry through v9, incl.
   `memory_entries` / caches).
3. Confirm seeds (strategies / policies) and LLM override without error.
4. Confirm memory prune runs (no sqlite-only skip).

## Exercise (smoke under load is better, but these must pass)

| Area | Action | Expect |
| --- | --- | --- |
| Auth / session | Login, refresh session | Session rows persist |
| Runs | Create run, complete or fail | Run + events durable |
| Memory | Complete a run that ingests turns; start a follow-up in the same thread | Working memory returns; episodic/semantic may be weaker (Tier-2) |
| Sync definitions | Load catalog / published definitions from platform store | Reads succeed |
| Identity insert | Trigger a path that writes `notification_log` or `sync_sql_log` | `runInsertIdAsync` / OUTPUT path returns ids |

## Watch

- Pool / connection errors, hung `transactionAsync`, failed migrator on restart.
- Migration drift (second boot must be no-op on applied versions).
- Agent recall quality notes (Tier-2 degraded keyword — document surprises).
- No accidental use of warehouse connector pools for platform life.

## Duration

Multi-day staging soak under normal traffic. Record start/end, incidents, and
whether Tier-2 memory was acceptable for the workload.

## Adoption criteria (all required)

1. Path-filtered CI green including live mssql on persistence changes.
2. This soak completed with no unresolved P0 platform-store issues.
3. Memory Tier-2 documented for product/support
   ([schema README](../packages/server/src/infra/persistence/schema/README.md),
   [doctrine §5c](./doctrine.md)).
4. Hosted deploy env templates point at mssql when flipping the default.

## Out of scope for soak

- Enabling SQL Server Full-Text (future Track B).
- Platform postgres.
- Fixing unrelated full `@mia/sync` orchestrator test suite.
