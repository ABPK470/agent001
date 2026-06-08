// ── Types ────────────────────────────────────────────────────────

/**
 * A SQL Server sys.* object entry in the sys catalog.
 * Built entirely from live database metadata (sys.all_columns) at startup.
 * No hand-curated descriptions or aliases — the column names ARE the semantic index.
 */
export interface SysEntry {
  /** Object name without schema prefix, e.g. "dm_db_column_store_row_group_physical_stats" */
  name: string
  /** Schema-qualified: "sys.dm_db_column_store_row_group_physical_stats" */
  qualifiedName: string
  /** Columns fetched from sys.all_columns at build time — indexed for keyword search. */
  columns: Array<{ name: string; dataType: string }>
}

export interface CatalogColumn {
  name: string
  dataType: string
  maxLength: number | null
  nullable: boolean
  isPK: boolean
}

export interface CatalogTable {
  schema: string
  name: string
  qualifiedName: string // "schema.name"
  type: "TABLE" | "VIEW"
  rowCount: number | null // null for views
  columns: CatalogColumn[]
  fkOutgoing: CatalogFK[] // this table references →
  fkIncoming: CatalogFK[] // ← referenced BY
  /**
   * For VIEWs only: the full CREATE VIEW SQL text from sys.sql_modules.
   * Loaded once at catalog build time — zero per-request cost.
   * May be absent (encrypted modules, restricted permissions, or TABLE type).
   */
  viewDefinition?: string
}

export interface CatalogFK {
  constraint: string
  fromSchema: string
  fromTable: string
  fromColumn: string
  toSchema: string
  toTable: string
  toColumn: string
}

export interface CatalogSearchHit {
  table: CatalogTable
  matchType: "name" | "column"
  matchedColumns: string[] // columns that matched (for column-match hits)
  score: number
}

export interface CatalogStats {
  schemas: number
  tables: number
  views: number
  columns: number
  fks: number
  totalRows: number
  implicitEdges: number
  largestTables: Array<{ name: string; rows: number }>
  /** publish views ranked by sum of their directly referenced source table rows. */
  largestPublishViews: Array<{ name: string; sourceRows: number }>
}

/** An implicit join edge: tables sharing a column name with matching data type. */
export interface ImplicitEdge {
  column: string // e.g. "clientId"
  dataType: string // e.g. "int"
  tables: string[] // all tables sharing this column+type
}

/** Serializable snapshot — persisted to JSON on disk for instant startup. */
export interface CatalogSnapshot {
  /**
   * Version 7: lineage and concept-graph subsystem removed; snapshot no
   * longer carries `lineage` entries. Previous: 6 added `viewDefinition`;
   * 5 added dynamic sys catalog; ≤4 are legacy shapes.
   */
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7
  builtAt: string
  source: string
  tables: CatalogTable[]
  implicitEdges: ImplicitEdge[]
  viewSourceRows?: Array<{ name: string; sourceRows: number }>
  /** Added in version 4 — sys.* catalog entries from live DB columns (all objects, no filter). */
  sysCatalog?: SysEntry[]
}

export interface CatalogBuildOptions {
  connection?: string
  cachePath?: string
  maxAgeMs?: number // default 7 days
  forceFresh?: boolean // ignore cache, rebuild from MSSQL
}
