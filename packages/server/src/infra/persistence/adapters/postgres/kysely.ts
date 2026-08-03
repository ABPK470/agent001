/**
 * Kysely PostgresDialect factory — sole platform Postgres connection stack.
 * Warehouse Sync keeps its own pg pools; never share with platform.
 */

import { Kysely, PostgresDialect } from "kysely"
import pg from "pg"
import type { PlatformDatabase } from "../../schema/tables.js"
import type { PostgresPlatformConfig } from "./config.js"

export function createPostgresPlatformKysely(
  cfg: PostgresPlatformConfig,
): Kysely<PlatformDatabase> {
  const pool = cfg.connectionString
    ? new pg.Pool({
        connectionString: cfg.connectionString,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
        max: 10,
      })
    : new pg.Pool({
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
        max: 10,
      })
  return new Kysely<PlatformDatabase>({
    dialect: new PostgresDialect({ pool }),
  })
}
