# Platform schema toolkit

Track B of the RDBMS-agnostic program
([readiness plan](../../../../../.cursor/plans/sqlite_to_mssql_readiness_3d8e6870.plan.md);
[production sign-off](../../../../../.cursor/plans/rdbms_production_signoff_0a436059.plan.md);
[platform postgres peer](../../../../../.cursor/plans/platform_postgres_peer_058b416a.plan.md)).

## Operator: choosing the platform store

**One RDBMS per process.** Default is **`sqlite`** (local and current hosted).
Set `MIA_PLATFORM_STORE` to `mssql` or `postgres` only when that deploy
explicitly chooses a peer. Do not run two.

| Env | Role |
| --- | --- |
| `MIA_PLATFORM_STORE` | `sqlite` \| `mssql` \| `postgres` |
| `MIA_PLATFORM_MSSQL_SERVER` | SQL Server host (mssql) |
| `MIA_PLATFORM_MSSQL_DATABASE` | Database name |
| `MIA_PLATFORM_MSSQL_USER` / `MIA_PLATFORM_MSSQL_PASSWORD` | Auth |
| `MIA_PLATFORM_MSSQL_ENCRYPT` / `MIA_PLATFORM_MSSQL_TRUST_SERVER_CERTIFICATE` | TLS |
| `MIA_PLATFORM_PG_URL` | Postgres URL (postgres; preferred) |
| `MIA_PLATFORM_PG_HOST` / `PORT` / `DATABASE` / `USER` / `PASSWORD` | Postgres discrete fields |
| `MIA_PLATFORM_PG_SSL` | Optional TLS for discrete Postgres config |

Boot opens the store via `openConfiguredPlatformStore` (migrate + seed on
mssql/postgres; sqlite keeps the numbered migrator + memory FTS5 init).

### Memory search tiers (intentional)

Same platform DB — never a sqlite sidecar for search when hosted.

| Platform | Keyword search | Port kind |
| --- | --- | --- |
| sqlite | FTS5 BM25 | `sqlite-fts5` — [`fts-search.ts`](../adapters/sqlite/memory/fts-search.ts) |
| postgres | `tsvector` + `plainto_tsquery('simple')` + `ts_rank` | `postgres-tsvector` — [`tsvector-search.ts`](../adapters/postgres/memory/tsvector-search.ts) |
| mssql | Degraded token/recency (`LIKE`) | `mssql-degraded` — [`degraded-search.ts`](../adapters/mssql/memory/degraded-search.ts) |

Postgres uses regconfig **`simple`** (no English stemming) so identifiers and
code tokens stay aligned with sqlite FTS5’s default tokenizer. The
`search_vector` column is maintained by a BEFORE INSERT/UPDATE trigger — not
a `GENERATED ALWAYS` column.

Contract: [`ports/memory-search.ts`](../../../../ports/memory-search.ts).
Agent `retrieveContext` uses this every run; mssql Tier-2 is weaker cross-run
episodic/semantic recall than FTS5/tsvector. Full-Text catalog on mssql is
future work.

### Adoption gate (mssql peer)

Before flipping a deploy from sqlite to `MIA_PLATFORM_STORE=mssql`:

1. Path-filtered CI green (incl. live mssql job on persistence PRs).
2. Staging soak completed (see [soak runbook](../../../../../docs/platform-mssql-soak.md)).
3. Product/support aware of Tier-2 memory search.
4. Architect / ops sign-off that SQL Server is required for that environment.

### Adoption gate (postgres peer)

Before choosing `MIA_PLATFORM_STORE=postgres` for a deploy:

1. Path-filtered CI green (incl. live postgres job on persistence PRs).
2. Staging soak completed (see [soak runbook](../../../../../docs/platform-postgres-soak.md)).
3. Product/support aware of tsvector/`simple` search behavior.

`assertPlatformStoreReady` already allows mssql and postgres — the gate is
operational policy, not a code hard-stop. **Process default stays sqlite**
until a deploy sets `MIA_PLATFORM_STORE` otherwise.

## Delivered matrix

| Milestone | What | Status |
| --- | --- | --- |
| 3 | Schema toolkit + async SQLite adapter | **Done** — product repos on `run*Async` |
| 4 | Second dialect (mssql peer) + multi-dialect migrator | **Bootable** — single Kysely handle; registry v1–10 |
| 4b | Platform postgres peer | **Bootable** — Kysely + registry + tsvector search |
| 8 | Memory search port | **Done** — FTS5 / tsvector / degraded |

## Shape

| Piece | Role |
| --- | --- |
| `tables.ts` | Column contracts (`PlatformDatabase`) |
| `kysely.ts` | Process-wide `Kysely`; `bindPlatformDb` for mssql/postgres |
| `execute.ts` | Sync compile → better-sqlite3 (sqlite only) |
| `execute-async.ts` | Dialect-aware async execute (sqlite wrap / RDBMS Kysely) |
| `@mia/sql-kit` `MigrationRunner` / `applyMultiDialectPending` | Shared migrator contract |
| `migrations/registry.ts` | Multi-dialect peer DDL (mssql/postgres v1–10 incl. memory + search_vector) |
| `ports/memory-search.ts` | Keyword search port (FTS5 / tsvector / degraded) |
| `sql-time.ts` | `platformNow` / `coalescePlatformNow` / `platformNowMinusSeconds` |
| `upsert.ts` | Dialect-portable select→update\|insert (no `ON CONFLICT`) |
| `json-path.ts` | Portable JSON scalar extract (`json_extract` / `JSON_VALUE` / `jsonb_extract_path_text`) |
| `adapters/mssql/**` | Sole Kysely/tedious handle + migrator (no platform `mssql` pool) |
| `adapters/postgres/**` | Sole Kysely/`pg` handle + migrator (no warehouse pool) |

## Cutover tables (Kysely)

Product tables through eval/memory/caches are on `PlatformDatabase`. SQLite-only
leftovers: entity append-only triggers, FTS5 virtual table + triggers, WAL
vacuum after prune.

## Future (parked — not unfinished M4)

- MSSQL Full-Text via `MemorySearchPort` if product rejects Tier-2.
- External search sidecars are last-resort only (outbox projection; SQL remains source of truth).
