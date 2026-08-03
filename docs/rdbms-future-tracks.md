# RDBMS future tracks (parked)

Not unfinished foundation. Targeted matrix is delivered:

- Platform: `sqlite | mssql | postgres` (one store per process; **default sqlite**)
- Sync warehouse: `mssql | postgres` dialects
- Memory: Tier-1 FTS5 (sqlite), Tier-1 tsvector/`simple` (postgres), Tier-2
  degraded (mssql)

These tracks open only after production sign-off (CI + soak) if product still
needs them.

| Track | Goal | Notes |
| --- | --- | --- |
| A — Platform Postgres | Un-refuse `MIA_PLATFORM_STORE=postgres`; peer registry + open path + tsvector | **Delivered** — see [postgres soak](./platform-postgres-soak.md) |
| B — Dialect-native FTS | MSSQL Full-Text / `CONTAINS` via `MemorySearchPort` on the **same** DB | Preferred if Tier-2 recall fails product bar; needs FTS feature + catalog ops + fallback policy |
| B′ — External search | Meilisearch/Typesense as projection + outbox | Last resort; SQL remains source of truth; high ops tax |

**Freeze for B/B′:** do not start until path-filtered CI stays mandatory on
platform/sync paths and the [mssql soak](./platform-mssql-soak.md) /
[postgres soak](./platform-postgres-soak.md) criteria are written and run for
the chosen host.

See also: [doctrine §5c](./doctrine.md),
[schema README](../packages/server/src/infra/persistence/schema/README.md).
