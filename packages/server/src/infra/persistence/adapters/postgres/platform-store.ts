/**
 * Postgres PlatformStore adapter — scaffold for plan milestone 4.
 *
 * Same gate as MSSQL: boot refuses `MIA_PLATFORM_STORE=postgres` until
 * migrator + dialect wiring land.
 */

import type { PlatformStore } from "../../../../ports/platform-store.js"

export function createPostgresPlatformStore(): PlatformStore {
  throw new Error(
    "Postgres PlatformStore is not implemented yet (plan milestone 4). " +
      "Need: multi-dialect migrator DDL, Kysely PostgresDialect wiring, and repo cutover. " +
      "Keep MIA_PLATFORM_STORE=sqlite for now.",
  )
}
