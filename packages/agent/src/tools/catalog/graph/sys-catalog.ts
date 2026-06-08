/**
 * sys.* catalog fetch + token index.
 *
 * Live DB call returns ~400+ system objects (catalog views, DMVs, TVFs)
 * with their columns. The token index supports keyword-based DMV lookup
 * via CatalogGraph.searchSys().
 *
 * @module
 */

import { tokenize } from "../helpers.js"
import { Q_SYS_COLUMNS } from "../sql.js"
import type { SysEntry } from "../types.js"

/**
 * Fetch ALL sys.* column definitions from the live database and build
 * SysEntry objects. Non-fatal: returns [] on restricted permissions or
 * older SQL Server versions.
 */
export async function buildSysCatalog(pool: import("mssql").ConnectionPool): Promise<SysEntry[]> {
  try {
    const colResult = await pool.request().query(Q_SYS_COLUMNS)
    const colsByObject = new Map<string, Array<{ name: string; dataType: string }>>()
    for (const r of colResult.recordset) {
      const key = String(r.object_name).toLowerCase()
      if (!colsByObject.has(key)) colsByObject.set(key, [])
      colsByObject.get(key)!.push({ name: r.column_name, dataType: r.data_type })
    }
    return [...colsByObject.entries()].map(([name, columns]) => ({
      name,
      qualifiedName: `sys.${name}`,
      columns
    }))
  } catch {
    return []
  }
}

/**
 * Build the sys-catalog token search index. Indexes object-name and
 * column-name tokens so keyword search can locate DMVs even when the
 * user only supplies a fragment of a column name.
 */
export function buildSysIndex(sysCatalog: Map<string, SysEntry>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  const addToken = (token: string, key: string) => {
    if (!index.has(token)) index.set(token, new Set())
    index.get(token)!.add(key)
  }
  for (const entry of sysCatalog.values()) {
    const key = entry.name.toLowerCase()
    for (const t of tokenize(entry.name)) addToken(t, key)
    for (const col of entry.columns) {
      for (const t of tokenize(col.name)) addToken(t, key)
    }
  }
  return index
}
