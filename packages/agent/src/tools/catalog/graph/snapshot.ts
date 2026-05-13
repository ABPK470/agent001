/**
 * Snapshot ↔ catalog conversion. Re-derives in-memory indexes
 * (adjacency, name/column indexes) from a serialized snapshot so
 * we don't have to round-trip them through JSON.
 *
 * @module
 */

import { buildSearchIndexes, tableKey } from "../helpers.js"
import type {
    CatalogFK,
    CatalogSnapshot,
    CatalogTable,
    SysEntry,
} from "../types.js"

export interface SnapshotRebuildResult {
  tables: Map<string, CatalogTable>
  nameIndex: Map<string, Set<string>>
  columnIndex: Map<string, Set<string>>
  adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>
  viewSourceRows: Map<string, number>
  sysCatalog: SysEntry[]
}

export function loadCatalogFromSnapshot(snap: CatalogSnapshot): SnapshotRebuildResult {
  const tables = new Map<string, CatalogTable>()
  for (const t of snap.tables) tables.set(t.qualifiedName, t)

  const { nameIndex, columnIndex } = buildSearchIndexes(tables)
  const adjacency = new Map<string, Array<{ target: string; fk: CatalogFK }>>()

  for (const table of tables.values()) {
    for (const fk of table.fkOutgoing) {
      const fromKey = tableKey(fk.fromSchema, fk.fromTable)
      const toKey = tableKey(fk.toSchema, fk.toTable)
      if (!adjacency.has(fromKey)) adjacency.set(fromKey, [])
      if (!adjacency.has(toKey)) adjacency.set(toKey, [])
      adjacency.get(fromKey)!.push({ target: toKey, fk })
      adjacency.get(toKey)!.push({ target: fromKey, fk })
    }
  }

  const viewSourceRows = new Map<string, number>()
  if (snap.viewSourceRows) {
    for (const { name, sourceRows } of snap.viewSourceRows) viewSourceRows.set(name, sourceRows)
  }

  // Restore sys catalog from snapshot as-is — no curated overlay
  const sysCatalog: SysEntry[] = snap.sysCatalog
    ? snap.sysCatalog.map((e) => ({ name: e.name, qualifiedName: e.qualifiedName, columns: e.columns ?? [] }))
    : []

  return { tables, nameIndex, columnIndex, adjacency, viewSourceRows, sysCatalog }
}
