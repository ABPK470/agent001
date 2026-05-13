/**
 * `scan_duplicates` mode — bulk-scan many T-SQL definitions for duplicate
 * FROM/JOIN references in a single round-trip. Replaces per-object
 * delegation when answering "how many of these N objects have duplicate
 * joins?" type questions.
 *
 * @module
 */

import sql from "mssql"
import { parseTSqlReferences } from "../helpers.js"
import { BULK_DEFINITIONS } from "../queries.js"

interface ScanArgs {
  schema?: string
  names?: unknown
  names_query?: string
  object_types?: string
}

export async function runScanDuplicates(p: sql.ConnectionPool, args: ScanArgs): Promise<string> {
  const schemaFilter = args.schema ? String(args.schema).trim() : null
  const objectTypes = args.object_types
    ? String(args.object_types)
    : "VIEW,SQL_STORED_PROCEDURE,SQL_TABLE_VALUED_FUNCTION,SQL_INLINE_TABLE_VALUED_FUNCTION"

  // names may arrive as a comma-separated string OR a JSON array
  let nameList: string[] = []
  if (Array.isArray(args.names)) {
    nameList = args.names.map((n) => String(n).trim()).filter(Boolean)
  } else if (typeof args.names === "string" && args.names.trim()) {
    nameList = args.names.split(",").map((n) => n.trim()).filter(Boolean)
  }

  // names_query — let the tool source the names list itself.
  if (typeof args.names_query === "string" && args.names_query.trim()) {
    const nq = args.names_query.trim()
    if (!/^\s*select\b/i.test(nq)) {
      return "Error: names_query must be a SELECT statement returning a single column of qualified names."
    }
    if (/[;\s](insert|update|delete|drop|alter|truncate|exec|execute|merge)\b/i.test(nq)) {
      return "Error: names_query must be read-only (SELECT only)."
    }
    try {
      const nqResult = await p.request().query(nq)
      const cols = nqResult.recordset.length > 0 ? Object.keys(nqResult.recordset[0]) : []
      const col = cols[0]
      if (!col) return `names_query returned no rows. Cannot build name list.`
      const fromQuery = nqResult.recordset
        .map((r) => String((r as Record<string, unknown>)[col] ?? "").trim())
        .filter(Boolean)
      nameList = nameList.concat(fromQuery)
    } catch (err) {
      return `Error running names_query: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // Dedup
  nameList = [...new Set(nameList)]

  if (nameList.length > 5000) {
    return `Error: scan_duplicates accepts at most 5000 names, got ${nameList.length}. ` +
      `Narrow the names_query (e.g. add a WHERE clause) or split into batches.`
  }
  const namesCsv = nameList.length > 0 ? nameList.join(",") : null

  if (!schemaFilter && !namesCsv) {
    return "Error: scan_duplicates needs scope. Provide ONE of: " +
      "names_query='SELECT name FROM core.Dataset' (recommended for list-bearing tables), " +
      "names='schema.A,schema.B,...', " +
      "or schema='core' (only scans objects defined in that schema). " +
      "Scanning every object in the database is not allowed."
  }

  const req = p.request()
  req.input("schemaFilter", sql.NVarChar, schemaFilter)
  req.input("namesCsv", sql.NVarChar, namesCsv)
  req.input("objectTypes", sql.NVarChar, objectTypes)
  const result = await req.query(BULK_DEFINITIONS)

  const rows = result.recordset as Array<{
    schema_name: string
    object_name: string
    object_type: string
    definition: string
  }>

  const requestedCount = namesCsv ? nameList.length : rows.length
  const scanned = rows.length
  const withDupes: Array<{ qname: string; type: string; dupes: Array<[string, number]> }> = []

  for (const r of rows) {
    const refs = parseTSqlReferences(String(r.definition ?? ""))
    const dupes = [...refs.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
    if (dupes.length > 0) {
      withDupes.push({
        qname: `${r.schema_name}.${r.object_name}`,
        type: r.object_type,
        dupes,
      })
    }
  }

  // Names that were requested but had no T-SQL definition (tables, missing, etc.)
  let missingLine = ""
  if (namesCsv) {
    const found = new Set(rows.map((r) => `${r.schema_name}.${r.object_name}`))
    const missing = nameList.filter((n) => !found.has(n))
    if (missing.length > 0) {
      const preview = missing.slice(0, 10).join(", ")
      missingLine =
        `\nNote: ${missing.length} of ${requestedCount} requested names had no T-SQL definition ` +
        `(physical tables, missing objects, or types not in object_types filter). ` +
        `First few: ${preview}${missing.length > 10 ? ", ..." : ""}`
    }
  }

  withDupes.sort((a, b) => b.dupes.length - a.dupes.length)
  const lines = [
    `Scanned ${scanned} object${scanned === 1 ? "" : "s"}` +
      (schemaFilter ? ` in schema '${schemaFilter}'` : "") +
      (namesCsv ? ` from ${requestedCount} requested name${requestedCount === 1 ? "" : "s"}` : "") +
      ".",
    `Objects with duplicate FROM/JOIN references: ${withDupes.length} of ${scanned} (${
      scanned === 0 ? "0" : ((withDupes.length / scanned) * 100).toFixed(1)
    }%).`,
    "",
  ]

  if (withDupes.length === 0) {
    lines.push("No duplicate joins found in any scanned object.")
  } else {
    const top = withDupes.slice(0, 50)
    lines.push(`Top ${top.length} (highest duplicate count first):`)
    for (const d of top) {
      const summary = d.dupes
        .slice(0, 3)
        .map(([n, c]) => `${n}×${c}`)
        .join(", ")
      const more = d.dupes.length > 3 ? `, +${d.dupes.length - 3} more` : ""
      lines.push(`  ${d.qname} (${d.type}) — ${d.dupes.length} duplicate ref${d.dupes.length === 1 ? "" : "s"}: ${summary}${more}`)
    }
    if (withDupes.length > top.length) {
      lines.push(`  ... and ${withDupes.length - top.length} more.`)
    }
    lines.push("", "Tip: inspect_definition(object='schema.Name') on any of the above to read full T-SQL.")
  }
  if (missingLine) lines.push(missingLine)
  return lines.join("\n")
}
