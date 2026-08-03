/**
 * MSSQL PlatformStore adapter — scaffold for plan milestone 4.
 *
 * Not production-ready: no connection pool, no migrator DDL, repos still
 * assume SQLite. Selecting `MIA_PLATFORM_STORE=mssql` fails at boot via
 * {@link assertPlatformStoreReady} until this adapter is completed.
 */

import type { PlatformStore } from "../../../../ports/platform-store.js"

export function createMssqlPlatformStore(): PlatformStore {
  throw new Error(
    "MSSQL PlatformStore is not implemented yet (plan milestone 4). " +
      "Need: multi-dialect migrator DDL, Kysely MssqlDialect wiring, and repo cutover. " +
      "Keep MIA_PLATFORM_STORE=sqlite for now.",
  )
}
