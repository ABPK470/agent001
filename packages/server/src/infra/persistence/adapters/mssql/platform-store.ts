/**
 * MSSQL PlatformStore adapter — single Kysely (tedious + tarn) handle for
 * migrator DDL, typed queries, and transactionAsync.
 *
 * Open via {@link openMssqlPlatformStore} / boot
 * {@link import("../../open-platform-store.js").openConfiguredPlatformStore}.
 * No platform `mssql.ConnectionPool` (npm `mssql` remains for warehouse Sync/Bridge).
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
