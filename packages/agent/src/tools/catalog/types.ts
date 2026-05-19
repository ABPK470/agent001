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
  qualifiedName: string          // "schema.name"
  type: "TABLE" | "VIEW"
  rowCount: number | null        // null for views
  columns: CatalogColumn[]
  fkOutgoing: CatalogFK[]       // this table references →
  fkIncoming: CatalogFK[]       // ← referenced BY
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
  matchedColumns: string[]       // columns that matched (for column-match hits)
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
  column: string                  // e.g. "clientId"
  dataType: string                // e.g. "int"
  tables: string[]                // all tables sharing this column+type
}

// ── Lineage types ────────────────────────────────────────────────

/** A dimension key column → dimension table mapping. */
export interface LineageDimJoin {
  column: string                  // e.g. "pkClient"
  dimTable: string                // e.g. "dim.Client"
  dimRows: string                 // e.g. "~26M"
  note: string                    // e.g. "ALWAYS filter — never full scan"
}

/** A single source feeding into a critical view. */
export interface LineageSource {
  qualifiedName: string           // e.g. "publish.MappingTransactionalBankingRules"
  businessArea: string            // e.g. "Transactional Banking"
  group: string                   // e.g. "Retail & Business Banking"
  filter: string                  // e.g. "pkProduct IS NOT NULL AND Amount <> 0"
}

/** Full lineage map for a critical view (e.g. publish.Revenue). */
export interface ViewLineage {
  view: string                    // "publish.Revenue"
  description: string             // "All client revenue across every business line"
  outputColumns: string[]         // column names in the view's output
  dimJoins: LineageDimJoin[]      // dimension key mappings
  sources: LineageSource[]        // all contributing tables/views
  /**
   * Where this lineage entry came from. Used by the catalog merge pipeline
   * to enforce precedence (extended-properties > lineage.json > auto) and
   * by the prompt summary to honestly tell the agent the mix of sources.
   *
   * - "extended-properties": derived at catalog-build time from
   *   `sys.extended_properties` on the live database (see
   *   lineage-extended-properties.ts for the convention). This is the
   *   north-star source — curation lives next to the schema and cannot
   *   silently drift away from it.
   * - "lineage.json": hand-curated JSON file. Transitional fallback,
   *   subject to drift, validated by lineage-validator.ts.
   * - "auto": mechanically derived from sys.sql_expression_dependencies.
   *   Cheap, always fresh, but only knows tables/views — no business
   *   context, no filters, no dim joins.
   */
  provenance?: "extended-properties" | "lineage.json" | "auto"
  /**
   * Drift report attached at load time by validateCuratedLineage().
   *
   * Hand-curated lineage.json has no automatic refresh mechanism — the live
   * schema can drift (sources renamed/dropped, columns removed) without the
   * file being updated. We therefore validate every curated entry against
   * the live CatalogGraph at load time, prune fields that no longer exist,
   * and stamp this `validation` record so the prompt can honestly tell the
   * agent how stale the curation is.
   *
   * Only present on entries that were loaded from a curated source (auto-
   * lineage skips validation — it is derived from the live catalog itself
   * and cannot drift). Absent === entry was not validated (auto-derived,
   * or pre-validation snapshot).
   */
  validation?: {
    verifiedAt: string            // ISO timestamp
    verifiedAgainst: string       // connection name validated against
    viewMissing?: boolean         // true → the view itself no longer exists (entry demoted to stub)
    droppedSources: string[]      // qualifiedNames silently removed because not in live catalog
    droppedDims: string[]         // dim tables silently removed
    droppedColumns: string[]      // outputColumns silently removed
  }
}

/**
 * A business concept node — derived from view lineage, models semantic relationships.
 * Concept nodes bridge tables that share a business purpose even without FK connections.
 * e.g. fact.CommissionAllocation and publish.MappingTransactionalBanking both belong
 * to the concept "Revenue" because they are both sources feeding publish.Revenue.
 */
export interface ConceptNode {
  concept: string           // e.g. "Revenue" (derived from source view name)
  sourceView: string        // e.g. "publish.Revenue" — the canonical aggregating view
  description: string       // from ViewLineage.description
  tables: string[]          // qualified names of all contributing source tables
  businessGroups: string[]  // unique business group names from sources
}

/** Edge type in a concept-aware path. */
export type ConceptPathEdge =
  | { type: "fk"; fromColumn: string; toColumn: string }
  | { type: "implicit"; column: string; dataType: string }
  | { type: "concept"; concept: string; via: string }  // via = source view

/** One step in a concept-aware path. */
export interface ConceptPathStep {
  from: string
  edge: ConceptPathEdge
  to: string
}

/** Result of a concept-aware path search. */
export interface ConceptPathResult {
  steps: ConceptPathStep[]
  totalHops: number
  conceptsUsed: string[]  // concept names traversed
}

/** Serializable snapshot — persisted to JSON on disk for instant startup. */
export interface CatalogSnapshot {
  /**
   * Version 6: view definitions from sys.sql_modules stored in CatalogTable.viewDefinition.
   * Previous: version 5 = dynamic sys catalog (all sys objects from live DB, no curated filter).
   */
  version: 1 | 2 | 3 | 4 | 5 | 6
  builtAt: string
  source: string
  tables: CatalogTable[]
  implicitEdges: ImplicitEdge[]
  lineage?: ViewLineage[]
  viewSourceRows?: Array<{ name: string; sourceRows: number }>
  /** Added in version 4 — sys.* catalog entries from live DB columns (all objects, no filter). */
  sysCatalog?: SysEntry[]
}

export interface CatalogBuildOptions {
  connection?: string
  cachePath?: string
  maxAgeMs?: number               // default 7 days
  forceFresh?: boolean            // ignore cache, rebuild from MSSQL
}
