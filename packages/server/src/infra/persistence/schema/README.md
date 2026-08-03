# Platform schema toolkit (spike)

Track B of the RDBMS-agnostic program: one schema source of truth that compiles
to sqlite / mssql / postgres, with proper migrations.

## Placement

Lives **only** under `server/infra/persistence/**`.

`drizzle-orm` / `drizzle-kit` stay on the framework denylist for Sync/Agent
`core` + `domain`. Composition roots and this folder may adopt a typed SQL /
schema toolkit once the first table cutover lands.

## Cutover shape (behavior-preserving)

1. Declare tables in a dialect-agnostic schema module (Drizzle or Kysely-class).
2. Generate / apply migrations per `MIA_PLATFORM_STORE` dialect.
3. Keep SQLite adapter green (fast local tests) while adding a second dialect.
4. Repos call the toolkit — no raw SQLite string SQL in product repos after cutover.
5. Memory FTS stays behind a `MemorySearch` port (last hard piece).

## Status

Config kind is already wired (`platform-store-config.ts` → `MIA_PLATFORM_STORE`).
Schema toolkit dependency + first-table migration are the next concrete steps —
not a big-bang rewrite of ~70 tables.
