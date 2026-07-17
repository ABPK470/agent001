/**
 * `object` mode handler — reads T-SQL definition of a single object and
 * appends a duplicate FROM/JOIN reference analysis.
 *
 * @module
 */

import sql from "mssql"
import { formatDuplicates, parseTSqlReferences } from "../helpers.js"
import { GET_DEFINITION } from "../queries.js"
import { splitObjectName } from "./definition-name.js"

export async function runObjectInspection(p: sql.ConnectionPool, objName: string): Promise<string> {
  const split = splitObjectName(objName)
  if (!split) {
    return "Error: provide schema-qualified name, e.g. 'publish.ClientBase' or 'persistedView.fact.Revenue'."
  }
  const { schema, name } = split

  const req = p.request()
  req.input("schema", sql.NVarChar, schema)
  req.input("object", sql.NVarChar, name)
  const result = await req.query(GET_DEFINITION)

  if (!result.recordset.length) {
    return (
      `No definition found for ${objName}. ` +
      `Check the object exists with explore_mssql_schema(search='${name}'). ` +
      `Tables don't have T-SQL definitions — use explore_mssql_schema(table='${objName}') instead.`
    )
  }

  const row = result.recordset[0]
  const definition = String(row.definition ?? "")

  const refs = parseTSqlReferences(definition)
  const allRefs = [...refs.entries()].sort((a, b) => b[1] - a[1])
  const dupeAnalysis = formatDuplicates(refs)

  const refLines = allRefs.map(([refName, count]) =>
    count > 1 ? `  ⚠ ${refName} (${count}x — DUPLICATE)` : `    ${refName}`
  )

  const defTrimmed = definition.slice(0, 8000)
  const defNote =
    definition.length > 8000
      ? `\n(Definition truncated — ${definition.length - 8000} chars omitted. Full source is in the database.)`
      : ""

  return [
    `Definition: ${schema}.${name} (${row.object_type})`,
    `Created: ${row.create_date} | Modified: ${row.modify_date}`,
    "",
    "TABLE/VIEW REFERENCES IN FROM/JOIN CLAUSES:",
    ...refLines,
    "",
    dupeAnalysis,
    "",
    "T-SQL SOURCE:",
    "─".repeat(60),
    defTrimmed + defNote
  ].join("\n")
}
