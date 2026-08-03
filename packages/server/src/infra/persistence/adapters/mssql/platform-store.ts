/**
 * MSSQL PlatformStore adapter — milestone 4 skeleton.
 *
 * Pool + multi-dialect migrator exist under this folder. Product repos and
 * `schema/execute.ts` still bind to SQLite, so boot refuses
 * `MIA_PLATFORM_STORE=mssql` via {@link assertPlatformStoreReady}.
 *
 * Use {@link openMssqlPlatformStore} only for migrator / wiring experiments —
 * not for serving the product yet.
 */

import sql, { type ConnectionPool } from "mssql"
import type { PlatformStore } from "../../../../ports/platform-store.js"
import { resolveMssqlPlatformConfig } from "./config.js"
import { createMssqlMigrationRunner, mssqlQueryExecutor } from "./migrations/runner.js"
import { closeMssqlPlatformPool, openMssqlPlatformPool } from "./pool.js"

export type MssqlPlatformStoreHandle = PlatformStore & {
  readonly pool: ConnectionPool
  /** Apply pending multi-dialect DDL (pilot registry). */
  applyMigrations(): Promise<void>
  close(): Promise<void>
}

/**
 * Composition-root entry — still refused for product boot.
 * Pool/migrator live behind {@link openMssqlPlatformStore}.
 */
export function createMssqlPlatformStore(): PlatformStore {
  throw new Error(
    "MSSQL PlatformStore is not product-ready (plan milestone 4). " +
      "Pool config + multi-dialect migrator land under adapters/mssql/**; " +
      "repos/execute still target SQLite. Keep MIA_PLATFORM_STORE=sqlite. " +
      "For pilot DDL only: openMssqlPlatformStore().",
  )
}

/** Open a dedicated platform pool and return a transactional store handle. */
export async function openMssqlPlatformStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MssqlPlatformStoreHandle> {
  const cfg = resolveMssqlPlatformConfig(env)
  const pool = await openMssqlPlatformPool(cfg)
  const runner = createMssqlMigrationRunner(mssqlQueryExecutor(pool))

  const store: MssqlPlatformStoreHandle = {
    kind: "mssql",
    pool,
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
      await closeMssqlPlatformPool()
    },
  }
  return store
}
