/**
 * MSSQL PlatformStore adapter — milestone 4 skeleton.
 *
 * Pool + multi-dialect migrator + Kysely MssqlDialect bind exist here.
 * Product repos still mostly call sync SQLite execute, so boot refuses
 * `MIA_PLATFORM_STORE=mssql` via {@link assertPlatformStoreReady}.
 *
 * Use {@link openMssqlPlatformStore} for migrator / async-execute pilots only.
 */

import sql, { type ConnectionPool } from "mssql"
import type { Kysely } from "kysely"
import type { PlatformStore } from "../../../../ports/platform-store.js"
import type { PlatformDatabase } from "../../schema/tables.js"
import { bindPlatformDb, resetPlatformDbForTests } from "../../schema/kysely.js"
import { resolveMssqlPlatformConfig } from "./config.js"
import { createMssqlPlatformKysely } from "./kysely.js"
import { createMssqlMigrationRunner, mssqlQueryExecutor } from "./migrations/runner.js"
import { closeMssqlPlatformPool, openMssqlPlatformPool } from "./pool.js"

export type MssqlPlatformStoreHandle = PlatformStore & {
  readonly pool: ConnectionPool
  readonly db: Kysely<PlatformDatabase>
  /** Apply pending multi-dialect DDL (pilot registry). */
  applyMigrations(): Promise<void>
  close(): Promise<void>
}

/**
 * Composition-root entry — still refused for product boot.
 * Pool/migrator/Kysely live behind {@link openMssqlPlatformStore}.
 */
export function createMssqlPlatformStore(): PlatformStore {
  throw new Error(
    "MSSQL PlatformStore is not product-ready (plan milestone 4). " +
      "Pool + migrator + Kysely MssqlDialect land under adapters/mssql/**; " +
      "most repos still call sync SQLite execute. Keep MIA_PLATFORM_STORE=sqlite. " +
      "For pilot only: openMssqlPlatformStore().",
  )
}

/** Open platform pool + bind Kysely; return a transactional store handle. */
export async function openMssqlPlatformStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MssqlPlatformStoreHandle> {
  const cfg = resolveMssqlPlatformConfig(env)
  const pool = await openMssqlPlatformPool(cfg)
  const db = createMssqlPlatformKysely(cfg)
  bindPlatformDb("mssql", db)
  const runner = createMssqlMigrationRunner(mssqlQueryExecutor(pool))

  const store: MssqlPlatformStoreHandle = {
    kind: "mssql",
    pool,
    db,
    transaction() {
      throw new Error(
        "MSSQL PlatformStore.transaction (sync) is unsupported — use transactionAsync",
      )
    },
    async transactionAsync(fn) {
      const tx = new sql.Transaction(pool)
      await tx.begin()
      try {
        const result = await fn()
        await tx.commit()
        return result
      } catch (err) {
        await tx.rollback()
        throw err
      }
    },
    applyMigrations() {
      return Promise.resolve(runner.applyPending())
    },
    async close() {
      await db.destroy()
      await closeMssqlPlatformPool()
      resetPlatformDbForTests()
    },
  }
  return store
}
