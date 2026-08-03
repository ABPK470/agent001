/**
 * Dialect-aware SQL time fragments for platform repos.
 *
 * Prefer ISO strings from JS (`new Date().toISOString()`) when the value
 * is application-owned. Use {@link platformNow} only when the database
 * should stamp "now" in the statement body.
 */

import { sql } from "kysely"
import { getPlatformDbKind } from "./kysely.js"

/** Current UTC timestamp expression for the bound platform dialect. */
export function platformNow() {
  const kind = getPlatformDbKind()
  if (kind === "mssql") return sql`SYSUTCDATETIME()`
  if (kind === "postgres") return sql`(NOW() AT TIME ZONE 'utc')`
  return sql`datetime('now')`
}

/** `coalesce(<column>, now)` for the bound platform dialect. */
export function coalescePlatformNow(column: string) {
  return sql`coalesce(${sql.ref(column)}, ${platformNow()})`
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
