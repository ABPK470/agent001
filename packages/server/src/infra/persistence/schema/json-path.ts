/**
 * Dialect-portable JSON scalar extract for WHERE clauses.
 * SQLite: json_extract; MSSQL: JSON_VALUE.
 */

import { sql, type RawBuilder } from "kysely"
import { getPlatformDbKind } from "./kysely.js"

/**
 * Extract a JSON scalar at `path` (JSONPath, e.g. `$.opId`).
 * Returns a Kysely expression suitable for comparison.
 */
export function jsonPathText(column: string, path: string): RawBuilder<string | null> {
  const kind = getPlatformDbKind()
  if (kind === "mssql") {
    return sql<string | null>`JSON_VALUE(${sql.ref(column)}, ${sql.lit(path)})`
  }
  // sqlite (and future postgres via json_extract / #>> — postgres can join later)
  return sql<string | null>`json_extract(${sql.ref(column)}, ${sql.lit(path)})`
}
