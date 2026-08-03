/**
 * Platform Kysely handle — wraps the process-wide better-sqlite3 connection.
 *
 * Composition root for typed platform SQL under `infra/persistence` only.
 * Not for warehouse Sync pools.
 */

import { Kysely, SqliteDialect } from "kysely"
import { getDb } from "../adapters/sqlite/connection.js"
import type { PlatformDatabase } from "./tables.js"

let platformDb: Kysely<PlatformDatabase> | null = null

/** Typed platform query builder bound to the open SQLite file. */
export function getPlatformDb(): Kysely<PlatformDatabase> {
  if (!platformDb) {
    platformDb = new Kysely<PlatformDatabase>({
      dialect: new SqliteDialect({
        database: getDb(),
      }),
    })
  }
  return platformDb
}

/** Test / shutdown hook — drop the cached Kysely wrapper (not the SQLite file). */
export function resetPlatformDbForTests(): void {
  platformDb = null
}
