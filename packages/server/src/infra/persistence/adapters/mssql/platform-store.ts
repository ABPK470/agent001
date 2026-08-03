/**
 * MSSQL PlatformStore adapter — milestone 4 skeleton.
 *
 * Single connection lifecycle: Kysely MssqlDialect (tedious + tarn) for
 * migrator DDL, typed queries, and transactionAsync. No platform
 * `mssql.ConnectionPool` (npm `mssql` remains for warehouse Sync/Bridge).
 *
 * Product repos still mostly call sync SQLite execute, so boot refuses
 * `MIA_PLATFORM_STORE=mssql` via {@link assertPlatformStoreReady}.
 *
 * Use {@link openMssqlPlatformStore} for migrator / async-execute pilots only.
 */

import type { Kysely } from "kysely"
import type { PlatformStore } from "../../../../ports/platform-store.js"
import type { PlatformDatabase } from "../../schema/tables.js"
import { bindPlatformDb, resetPlatformDbForTests } from "../../schema/kysely.js"
import { resolveMssqlPlatformConfig } from "./config.js"
import { createMssqlPlatformKysely } from "./kysely.js"
import {
  createMssqlMigrationRunner,
  kyselyPlatformDdlExecutor,
} from "./migrations/runner.js"

export type MssqlPlatformStoreHandle = PlatformStore & {
  readonly db: Kysely<PlatformDatabase>
  /** Apply pending multi-dialect DDL (registry via same Kysely handle). */
  applyMigrations(): Promise<void>
  close(): Promise<void>
}

/**
 * Composition-root entry — still refused for product boot.
 * Single Kysely handle lives behind {@link openMssqlPlatformStore}.
 */
export function createMssqlPlatformStore(): PlatformStore {
  throw new Error(
    "MSSQL PlatformStore is not product-ready (plan milestone 4). " +
      "Single Kysely (tedious/tarn) handle + migrator land under adapters/mssql/**; " +
      "repos still call sync SQLite execute. Keep MIA_PLATFORM_STORE=sqlite. " +
      "For pilot only: openMssqlPlatformStore().",
  )
}

/** Open the sole platform Kysely handle; bind process-wide for execute-async. */
export async function openMssqlPlatformStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MssqlPlatformStoreHandle> {
  const cfg = resolveMssqlPlatformConfig(env)
  const db = createMssqlPlatformKysely(cfg)
  bindPlatformDb("mssql", db)
  const runner = createMssqlMigrationRunner(kyselyPlatformDdlExecutor(db))

  const store: MssqlPlatformStoreHandle = {
    kind: "mssql",
    db,
    transaction() {
      throw new Error(
        "MSSQL PlatformStore.transaction (sync) is unsupported — use transactionAsync",
      )
    },
    async transactionAsync(fn) {
      // Same tarn pool as DML/DDL. Rebind ambient getPlatformDb() to trx so
      // in-tx work does not escape onto the outer connection (autocommit).
      return db.transaction().execute(async (trx) => {
        bindPlatformDb("mssql", trx as unknown as Kysely<PlatformDatabase>)
        try {
          return await fn()
        } finally {
          bindPlatformDb("mssql", db)
        }
      })
    },
    applyMigrations() {
      return Promise.resolve(runner.applyPending())
    },
    async close() {
      await db.destroy()
      resetPlatformDbForTests()
    },
  }
  return store
}
