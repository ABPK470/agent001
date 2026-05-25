/**
 * Live-DB build of CatalogGraph constructor inputs.
 *
 * Issued queries (in order):
 *   Q_OBJECTS, Q_COLUMNS, Q_FKS                      — required, build core graph
 *   Q_FULL_VIEW_DEPS                                  — non-fatal, view source rows
 *   Q_VIEW_DEFINITIONS                                — non-fatal, attaches CREATE VIEW SQL
 *   Q_SYS_COLUMNS  (in parallel via buildSysCatalog) — non-fatal, sys.* catalog
 *
 * Returns the values needed by the CatalogGraph constructor.
 *
 * @module
 */

import type { AgentHost } from "../../../host/index.js"
import { getPool } from "../../mssql/index.js"
import { buildSearchIndexes, computeImplicitEdges, tableKey } from "../helpers.js"
import { Q_COLUMNS, Q_FKS, Q_FULL_VIEW_DEPS, Q_OBJECTS, Q_VIEW_DEFINITIONS } from "../sql.js"
import type {
    CatalogColumn,
    CatalogFK,
    CatalogTable,
    ImplicitEdge,
    SysEntry,
} from "../types.js"
import { buildSysCatalog } from "./sys-catalog.js"

export interface CatalogLoadResult {
  tables: Map<string, CatalogTable>
  nameIndex: Map<string, Set<string>>
  columnIndex: Map<string, Set<string>>
  adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>
  implicitEdges: ImplicitEdge[]
  viewSourceRows: Map<string, number>
  sysCatalog: SysEntry[]
}

export async function loadCatalogFromDb(host: AgentHost, connection?: string): Promise<CatalogLoadResult> {
  const { pool } = await getPool(host, connection)
  // Start sys catalog fetch in parallel with user catalog (non-fatal if it fails)
  const sysCatalogPromise = buildSysCatalog(pool)

  const objResult = await pool.request().query(Q_OBJECTS)
  const tables = new Map<string, CatalogTable>()
  for (const r of objResult.recordset) {
    const key = tableKey(r.schema_name, r.object_name)
    tables.set(key, {
      schema: r.schema_name,
      name: r.object_name,
      qualifiedName: key,
      type: r.object_type === "USER_TABLE" ? "TABLE" : "VIEW",
      rowCount: r.row_count != null ? Number(r.row_count) : null,
      columns: [],
      fkOutgoing: [],
      fkIncoming: [],
    })
  }

  // Step 2: Fetch all columns
  const colResult = await pool.request().query(Q_COLUMNS)
  for (const r of colResult.recordset) {
    const key = tableKey(r.schema_name, r.table_name)
    const table = tables.get(key)
    if (table) {
      table.columns.push({
        name: r.column_name,
        dataType: r.data_type,
        maxLength: r.max_length,
        nullable: !!r.is_nullable,
        isPK: !!r.is_pk,
      } as CatalogColumn)
    }
  }

  // Step 3: Fetch all FK relationships
  const fkResult = await pool.request().query(Q_FKS)
  const adjacency = new Map<string, Array<{ target: string; fk: CatalogFK }>>()
  for (const r of fkResult.recordset) {
    const fk: CatalogFK = {
      constraint: r.constraint_name,
      fromSchema: r.from_schema,
      fromTable: r.from_table,
      fromColumn: r.from_column,
      toSchema: r.to_schema,
      toTable: r.to_table,
      toColumn: r.to_column,
    }
    const fromKey = tableKey(r.from_schema, r.from_table)
    const toKey = tableKey(r.to_schema, r.to_table)

    tables.get(fromKey)?.fkOutgoing.push(fk)
    tables.get(toKey)?.fkIncoming.push(fk)

    // Bidirectional adjacency
    if (!adjacency.has(fromKey)) adjacency.set(fromKey, [])
    if (!adjacency.has(toKey)) adjacency.set(toKey, [])
    adjacency.get(fromKey)!.push({ target: toKey, fk })
    adjacency.get(toKey)!.push({ target: fromKey, fk })
  }

  // Step 4: Build search indexes
  const { nameIndex, columnIndex } = buildSearchIndexes(tables)

  // Step 5: Compute implicit join edges (shared column names + compatible types)
  const implicitEdges = computeImplicitEdges(tables, columnIndex)

  // Step 6: View dependencies — per-view source-row totals (filter
  // source_type='U', sum physical table rows). Non-fatal: older SQL
  // Server versions or restricted permissions skip it.
  const viewSourceRows = new Map<string, number>()
  try {
    const depResult = await pool.request().query(Q_FULL_VIEW_DEPS)
    for (const r of depResult.recordset) {
      const sourceType = String(r.source_type)
      if (sourceType !== "U") continue
      const viewName = String(r.view_name)
      const sourceName = String(r.source_name)
      const refTable = tables.get(sourceName)
      if (refTable?.rowCount) {
        viewSourceRows.set(viewName, (viewSourceRows.get(viewName) ?? 0) + refTable.rowCount)
      }
    }
  } catch { /* non-fatal */ }

  // Step 7: Fetch view definitions from sys.sql_modules (non-fatal)
  try {
    const defResult = await pool.request().query(Q_VIEW_DEFINITIONS)
    for (const r of defResult.recordset) {
      const key = String(r.qualified_name)
      const t = tables.get(key)
      if (t && t.type === "VIEW") {
        t.viewDefinition = String(r.definition)
      }
    }
  } catch { /* non-fatal */ }

  // Step 8: Await sys catalog
  const sysCatalog = await sysCatalogPromise

  return { tables, nameIndex, columnIndex, adjacency, implicitEdges, viewSourceRows, sysCatalog }
}
