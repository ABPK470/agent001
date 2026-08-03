/**
 * Platform Kysely handle — dialect-bound query builder for Mia’s store.
 *
 * Default: SQLite (better-sqlite3). Milestone 4 can bind an MSSQL Kysely
 * via {@link bindPlatformDb} for pilot / async execute — product boot still
 * refuses non-sqlite. Never for warehouse Sync pools.
 */

import { Kysely, SqliteDialect } from "kysely"
import type { RelationalDialectKind } from "@mia/sql-kit"
import { getDb } from "../adapters/sqlite/connection.js"
import type { PlatformDatabase } from "./tables.js"

let platformDb: Kysely<PlatformDatabase> | null = null
let platformKind: RelationalDialectKind = "sqlite"

function createSqlitePlatformDb(): Kysely<PlatformDatabase> {
  return new Kysely<PlatformDatabase>({
    dialect: new SqliteDialect({
      database: getDb(),
    }),
  })
}

/** Active platform dialect for the bound {@link getPlatformDb} instance. */
export function getPlatformDbKind(): RelationalDialectKind {
  if (!platformDb) return "sqlite"
  return platformKind
}

/** Typed platform query builder for the currently bound dialect. */
export function getPlatformDb(): Kysely<PlatformDatabase> {
  if (!platformDb) {
    platformDb = createSqlitePlatformDb()
    platformKind = "sqlite"
  }
  return platformDb
}

/**
 * Bind a non-default dialect Kysely (mssql pilot). Replaces the process-wide
 * handle — call only from the MSSQL adapter composition path.
 */
export function bindPlatformDb(
  kind: RelationalDialectKind,
  db: Kysely<PlatformDatabase>,
): void {
  if (kind === "sqlite") {
    throw new Error("bindPlatformDb(sqlite): use resetPlatformDbForTests + getPlatformDb instead")
  }
  platformDb = db
  platformKind = kind
}

/** Test / shutdown hook — drop the cached Kysely wrapper (not the file/pool). */
export function resetPlatformDbForTests(): void {
  platformDb = null
  platformKind = "sqlite"
}
