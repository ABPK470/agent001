/**
 * Dialect-aware time helpers for platform repos.
 *
 * {@link platformNow} returns an application-owned ISO string (portable bind
 * value for TEXT/datetime columns). Use {@link platformNowSql} /
 * {@link coalescePlatformNow} / {@link platformNowMinusSeconds} only when the
 * SQL body itself must express "now".
 */

import { sql } from "kysely"
import { getPlatformDbKind } from "./kysely.js"

/** Current UTC timestamp as an ISO string (bind value — all dialects). */
export function platformNow(): string {
  return new Date().toISOString()
}

/** Current UTC timestamp SQL expression for the bound platform dialect. */
export function platformNowSql() {
  const kind = getPlatformDbKind()
  if (kind === "mssql") return sql`SYSUTCDATETIME()`
  if (kind === "postgres") return sql`(NOW() AT TIME ZONE 'utc')`
  return sql`datetime('now')`
}

/** `coalesce(<column>, now)` for the bound platform dialect. */
export function coalescePlatformNow(column: string) {
  return sql`coalesce(${sql.ref(column)}, ${platformNowSql()})`
}

/**
 * Timestamp that is `seconds` before now (UTC), for activity / retention windows.
 * Prefer binding a JS ISO cutoff when the comparison is simple equality on TEXT;
 * use this when the SQL body must express "now − N seconds".
 */
export function platformNowMinusSeconds(seconds: number) {
  const n = Math.max(0, Math.floor(seconds))
  const kind = getPlatformDbKind()
  if (kind === "mssql") return sql`DATEADD(second, ${-n}, SYSUTCDATETIME())`
  if (kind === "postgres") {
    return sql`(NOW() AT TIME ZONE 'utc') - (${sql.raw(String(n))} * INTERVAL '1 second')`
  }
  return sql`datetime('now', ${`-${n} seconds`})`
}
