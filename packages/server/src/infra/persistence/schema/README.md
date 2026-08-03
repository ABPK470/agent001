# Platform schema toolkit

Track B of the RDBMS-agnostic program
([readiness plan](../../../../../.cursor/plans/sqlite_to_mssql_readiness_3d8e6870.plan.md);
[production sign-off](../../../../../.cursor/plans/rdbms_production_signoff_0a436059.plan.md)).

## Operator: choosing the platform store

**One RDBMS per process.** Set `MIA_PLATFORM_STORE` to `sqlite` (default, local)
or `mssql` (hosted). Do not run both. Postgres platform is not product-ready.

| Env | Role |
| --- | --- |
| `MIA_PLATFORM_STORE` | `sqlite` \| `mssql` (postgres refused at boot) |
| `MIA_PLATFORM_MSSQL_SERVER` | SQL Server host (mssql) |
| `MIA_PLATFORM_MSSQL_DATABASE` | Database name |
| `MIA_PLATFORM_MSSQL_USER` / `MIA_PLATFORM_MSSQL_PASSWORD` | Auth |
| `MIA_PLATFORM_MSSQL_ENCRYPT` / `MIA_PLATFORM_MSSQL_TRUST_SERVER_CERTIFICATE` | TLS |

Boot opens the store via `openConfiguredPlatformStore` (migrate + seed on mssql;
sqlite keeps the numbered migrator + memory FTS5 init).

### Memory search tiers (intentional)

Same platform DB — never a sqlite sidecar for search when hosted.

| Platform | Keyword search | Port kind |
| --- | --- | --- |
| sqlite | FTS5 BM25 | `sqlite-fts5` — [`fts-search.ts`](../adapters/sqlite/memory/fts-search.ts) |
| mssql | Degraded token/recency (`LIKE`) | `mssql-degraded` — [`degraded-search.ts`](../adapters/mssql/memory/degraded-search.ts) |

Contract: [`ports/memory-search.ts`](../../../../ports/memory-search.ts).
Agent `retrieveContext` uses this every run; Tier-2 is weaker cross-run
episodic/semantic recall than FTS5. Full-Text catalog on mssql is future work.

### Adoption gate (hosted mssql)

Before defaulting hosted installs to `MIA_PLATFORM_STORE=mssql`:

1. Path-filtered CI green (incl. live mssql job on persistence PRs).
2. Staging soak completed (see [soak runbook](../../../../../docs/platform-mssql-soak.md)).
3. Product/support aware of Tier-2 memory search.

`assertPlatformStoreReady` already allows mssql — the gate is operational
policy, not a code hard-stop.

## Delivered matrix

| Milestone | What | Status |
| --- | --- | --- |
| 3 | Schema toolkit + async SQLite adapter | **Done** — product repos on `run*Async` |
| 4 | Second dialect (**hosted default: mssql**) + multi-dialect migrator | **Bootable** — single Kysely handle; registry v1–9 |
| 8 | Memory search port | **Done** — FTS5 sqlite / degraded mssql |

## Shape

| Piece | Role |
| --- | --- |
| `tables.ts` | Column contracts (`PlatformDatabase`) |
| `kysely.ts` | Process-wide `Kysely`; `bindPlatformDb` for mssql |
| `execute.ts` | Sync compile → better-sqlite3 (sqlite only) |
| `execute-async.ts` | Dialect-aware async execute (sqlite wrap / mssql Kysely) |
| `@mia/sql-kit` `MigrationRunner` / `applyMultiDialectPending` | Shared migrator contract |
| `migrations/registry.ts` | Multi-dialect peer DDL (mssql v1–9 incl. memory base tables) |
| `ports/memory-search.ts` | Keyword search port (FTS5 vs degraded) |
| `sql-time.ts` | `platformNow` / `coalescePlatformNow` / `platformNowMinusSeconds` |
| `upsert.ts` | Dialect-portable select→update\|insert (no `ON CONFLICT`) |
| `json-path.ts` | Portable JSON scalar extract (`json_extract` / `JSON_VALUE`) |
| `adapters/mssql/**` | Sole Kysely/tedious handle + migrator (no platform `mssql` pool) |

## Cutover tables (Kysely)

Product tables through eval/memory/caches are on `PlatformDatabase`. SQLite-only
leftovers: entity append-only triggers, FTS5 virtual table + triggers, WAL
vacuum after prune.

## Future (parked — not unfinished M4)

- Platform `postgres` adapter (un-refuse `MIA_PLATFORM_STORE=postgres`).
- MSSQL Full-Text via `MemorySearchPort` if product rejects Tier-2.
- External search sidecars are last-resort only (outbox projection; SQL remains source of truth).
