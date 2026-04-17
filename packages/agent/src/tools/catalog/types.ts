// ── Types ────────────────────────────────────────────────────────

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
  version: 1 | 2
  builtAt: string                 // ISO 8601
  source: string                  // connection name
  tables: CatalogTable[]
  implicitEdges: ImplicitEdge[]
  lineage: ViewLineage[]          // curated lineage maps for critical views
}

export interface CatalogBuildOptions {
  connection?: string
  cachePath?: string
  maxAgeMs?: number               // default 7 days
  forceFresh?: boolean            // ignore cache, rebuild from MSSQL
}
