/**
 * Postgres PlatformStore adapter — single Kysely (pg pool) handle for
 * migrator DDL, typed queries, and transactionAsync.
 */

import type { Kysely } from "kysely"
import type { PlatformStore } from "../../../../ports/platform-store.js"
import type { PlatformDatabase } from "../../schema/tables.js"
import { bindPlatformDb, resetPlatformDbForTests } from "../../schema/kysely.js"
import { resolvePostgresPlatformConfig } from "./config.js"
import { createPostgresPlatformKysely } from "./kysely.js"
import {
  createPostgresMigrationRunner,
  kyselyPostgresDdlExecutor,
} from "./migrations/runner.js"

export type PostgresPlatformStoreHandle = PlatformStore & {
  readonly db: Kysely<PlatformDatabase>
  applyMigrations(): Promise<void>
  close(): Promise<void>
}

/** @deprecated Use {@link openPostgresPlatformStore} — sync factory is unsupported. */
export function createPostgresPlatformStore(): PlatformStore {
  throw new Error(
    "Postgres PlatformStore must be opened via openPostgresPlatformStore / openConfiguredPlatformStore",
  )
}

export async function openPostgresPlatformStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PostgresPlatformStoreHandle> {
  const cfg = resolvePostgresPlatformConfig(env)
  const db = createPostgresPlatformKysely(cfg)
  bindPlatformDb("postgres", db)
  const runner = createPostgresMigrationRunner(kyselyPostgresDdlExecutor(db))

  const store: PostgresPlatformStoreHandle = {
    kind: "postgres",
    db,
    transaction() {
      throw new Error(
        "Postgres PlatformStore.transaction (sync) is unsupported — use transactionAsync",
      )
    },
    async transactionAsync(fn) {
      return db.transaction().execute(async (trx) => {
        bindPlatformDb("postgres", trx as unknown as Kysely<PlatformDatabase>)
        try {
          return await fn()
        } finally {
          bindPlatformDb("postgres", db)
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
