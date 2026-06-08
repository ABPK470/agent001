/**
 * Dependency / search handlers (depends_on, search modes).
 *
 * @module
 */

import sql from "mssql"
import { GET_DEPENDENCIES, SEARCH_DEFINITIONS } from "../queries.js"
import { normalizePersistredViewName } from "./definition-name.js"

export async function runDependsOn(p: sql.ConnectionPool, qualName: string): Promise<string> {
  const normalizedName = normalizePersistredViewName(qualName)
  const req = p.request()
  req.input("qualifiedName", sql.NVarChar, normalizedName)
  const result = await req.query(GET_DEPENDENCIES)

  if (!result.recordset.length) {
    return `No dependencies found for ${qualName}. It may have no static references, or use dynamic SQL.`
  }

  const tables = result.recordset.filter(
    (r: Record<string, string>) => r.ref_type === "USER_TABLE" || r.ref_type === "SYSTEM_TABLE"
  )
  const views = result.recordset.filter((r: Record<string, string>) => r.ref_type === "VIEW")
  const procs = result.recordset.filter(
    (r: Record<string, string>) => r.ref_type?.includes("PROCEDURE") || r.ref_type?.includes("FUNCTION")
  )

  const lines = [`Dependencies of ${qualName} (${result.recordset.length} direct references):\n`]
  if (views.length > 0) {
    lines.push(`  Views (${views.length}):`)
    for (const v of views) lines.push(`    ${v.ref_schema}.${v.ref_name}`)
  }
  if (tables.length > 0) {
    lines.push(`  Base tables (${tables.length}):`)
    for (const t of tables) lines.push(`    ${t.ref_schema}.${t.ref_name}`)
  }
  if (procs.length > 0) {
    lines.push(`  Procs/Functions (${procs.length}):`)
    for (const p2 of procs) lines.push(`    ${p2.ref_schema}.${p2.ref_name}`)
  }
  lines.push(
    "",
    `Tip: Call inspect_definition(object='${qualName}') to read the full T-SQL and spot duplicate joins.`,
    `Tip: Call inspect_definition(depends_on='schema.ViewName') on any listed view for deeper traversal.`
  )
  return lines.join("\n")
}

export async function runSearch(p: sql.ConnectionPool, pattern: string): Promise<string> {
  const req = p.request()
  req.input("pattern", sql.NVarChar, `%${pattern}%`)
  const result = await req.query(SEARCH_DEFINITIONS)

  if (!result.recordset.length) {
    return `No objects found whose definition references '${pattern}'.`
  }

  const lines = [`Objects referencing '${pattern}' in their definition (${result.recordset.length} found):\n`]
  const byType = new Map<string, Array<{ schema: string; name: string; modified: string }>>()
  for (const r of result.recordset) {
    const type = String(r.object_type)
    if (!byType.has(type)) byType.set(type, [])
    byType
      .get(type)!
      .push({ schema: r.schema_name, name: r.object_name, modified: String(r.modify_date ?? "") })
  }
  for (const [type, items] of byType) {
    lines.push(`  ${type} (${items.length}):`)
    for (const item of items) lines.push(`    ${item.schema}.${item.name}`)
  }
  lines.push("", `Use inspect_definition(object='schema.Name') on any of these to read its T-SQL.`)
  return lines.join("\n")
}
