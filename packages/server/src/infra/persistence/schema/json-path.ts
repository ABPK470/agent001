/**
 * Dialect-portable JSON scalar extract for WHERE clauses.
 * SQLite: json_extract; MSSQL: JSON_VALUE; Postgres: jsonb_extract_path_text.
 */

import { sql, type RawBuilder } from "kysely"
import { getPlatformDbKind } from "./kysely.js"

/**
 * Sanitize `$.a.b` / `a.b` JSONPath-ish paths into Postgres key segments.
 * Never pass raw `$.…` into jsonb_extract_path_text.
 */
export function jsonPathToPostgresKeys(path: string): string[] {
  let p = path.trim()
  if (p.startsWith("$.")) p = p.slice(2)
  else if (p.startsWith("$")) p = p.slice(1)
  if (p.startsWith(".")) p = p.slice(1)
  const keys = p.split(".").filter((k) => k.length > 0)
  if (keys.length === 0) {
    throw new Error(`jsonPathToPostgresKeys: empty path from ${JSON.stringify(path)}`)
  }
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`jsonPathToPostgresKeys: invalid segment ${JSON.stringify(k)}`)
    }
  }
  return keys
}

/**
 * Extract a JSON scalar at `path` (JSONPath, e.g. `$.opId`).
 * Returns a Kysely expression suitable for comparison.
 */
export function jsonPathText(column: string, path: string): RawBuilder<string | null> {
  const kind = getPlatformDbKind()
  if (kind === "mssql") {
    return sql<string | null>`JSON_VALUE(${sql.ref(column)}, ${sql.lit(path)})`
  }
  if (kind === "postgres") {
    const keys = jsonPathToPostgresKeys(path)
    const keyLits = keys.map((k) => sql.lit(k))
    return sql<string | null>`jsonb_extract_path_text(${sql.ref(column)}::jsonb, ${sql.join(keyLits, sql`, `)})`
  }
  return sql<string | null>`json_extract(${sql.ref(column)}, ${sql.lit(path)})`
}
