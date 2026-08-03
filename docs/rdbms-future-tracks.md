# RDBMS future tracks (parked)

Not unfinished foundation. Targeted matrix (platform sqlite|mssql, Sync
mssql|postgres, memory Tier-1/Tier-2) is delivered. These tracks open only
after production sign-off (CI + soak) if product still needs them.

| Track | Goal | Notes |
| --- | --- | --- |
| A — Platform Postgres | Un-refuse `MIA_PLATFORM_STORE=postgres`; peer registry + open path | ~2–3 eng-weeks + soak once adapters exist |
| B — Dialect-native FTS | MSSQL Full-Text / `CONTAINS` via `MemorySearchPort` on the **same** DB | Preferred if Tier-2 recall fails product bar; needs FTS feature + catalog ops + fallback policy |
| B′ — External search | Meilisearch/Typesense as projection + outbox | Last resort; SQL remains source of truth; high ops tax |

**Freeze:** do not start A/B/B′ until path-filtered CI is mandatory on
platform/sync paths and the [mssql soak](./platform-mssql-soak.md) criteria
are written and run.

See also: [doctrine §5c](./doctrine.md),
[schema README](../packages/server/src/infra/persistence/schema/README.md).
