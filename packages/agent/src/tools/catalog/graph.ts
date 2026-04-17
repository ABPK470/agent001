import { getPool } from "../mssql.js"
import { buildConceptGraph } from "./concepts.js"
import { buildSearchIndexes, computeImplicitEdges, tableKey } from "./helpers.js"
import { findConceptPath as findConceptPathModule, findFkPath } from "./paths.js"
import { searchCatalog } from "./search.js"
import { Q_COLUMNS, Q_FKS, Q_OBJECTS } from "./sql.js"
import type {
    CatalogBuildOptions,
    CatalogColumn,
    CatalogFK,
    CatalogSearchHit,
    CatalogSnapshot,
    CatalogStats,
    CatalogTable,
    ConceptNode,
    ConceptPathResult,
    ImplicitEdge,
    ViewLineage,
} from "./types.js"

// ── CatalogGraph ─────────────────────────────────────────────────

export class CatalogGraph {
  readonly tables: Map<string, CatalogTable>
  readonly implicitEdges: ImplicitEdge[]
  readonly builtAt: Date
  /** Curated lineage maps for critical views, keyed by qualifiedName. */
  readonly lineageMap: Map<string, ViewLineage>

  readonly nameIndex: Map<string, Set<string>>
  readonly columnIndex: Map<string, Set<string>>
  readonly adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>
  /** tableKey → implicit edges involving this table */
  readonly implicitJoinIndex: Map<string, ImplicitEdge[]>

  /** Concept nodes indexed by concept name (lowercase) — e.g. "revenue" → ConceptNode */
  readonly conceptNodes: Map<string, ConceptNode>
  /** Source view (lowercase) → ConceptNode — fast lookup by view name */
  readonly conceptByView: Map<string, ConceptNode>
  /** tableKey → list of concept nodes this table contributes to (reverse index) */
  readonly conceptEdgeIndex: Map<string, ConceptNode[]>

  private constructor(
    tables: Map<string, CatalogTable>,
    nameIndex: Map<string, Set<string>>,
    columnIndex: Map<string, Set<string>>,
    adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>,
    implicitEdges: ImplicitEdge[],
    builtAt?: Date,
    lineage?: ViewLineage[],
  ) {
    this.tables = tables
    this.nameIndex = nameIndex
    this.columnIndex = columnIndex
    this.adjacency = adjacency
    this.implicitEdges = implicitEdges
    this.builtAt = builtAt ?? new Date()
    // Build implicit join index for fast per-table lookup
    this.implicitJoinIndex = new Map()
    for (const edge of implicitEdges) {
      for (const tk of edge.tables) {
        if (!this.implicitJoinIndex.has(tk)) this.implicitJoinIndex.set(tk, [])
        this.implicitJoinIndex.get(tk)!.push(edge)
      }
    }
    // Build lineage index
    this.lineageMap = new Map()
    if (lineage) {
      for (const l of lineage) this.lineageMap.set(l.view, l)
    }
    // Build concept graph (pure in-memory derivation from lineage — zero SQL)
    this.conceptNodes = new Map()
    this.conceptByView = new Map()
    this.conceptEdgeIndex = new Map()
    if (lineage && lineage.length > 0) {
      buildConceptGraph(this.conceptNodes, this.conceptByView, this.conceptEdgeIndex, lineage)
    }
  }

  // ── Build from live database ─────────────────────────────────

  static async build(connection?: string): Promise<CatalogGraph> {
    const { pool } = await getPool(connection)

    // Step 1: Fetch all tables/views
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
    const implEdges = computeImplicitEdges(tables, columnIndex)

    return new CatalogGraph(tables, nameIndex, columnIndex, adjacency, implEdges)
  }

  // ── Serialization (persistent cache) ───────────────────────

  /** Serialize to a JSON-safe snapshot for disk persistence. */
  toSnapshot(source = "default"): CatalogSnapshot {
    return {
      version: 2,
      builtAt: this.builtAt.toISOString(),
      source,
      tables: [...this.tables.values()],
      implicitEdges: this.implicitEdges,
      lineage: [...this.lineageMap.values()],
    }
  }

  /** Rebuild in-memory graph from a persisted snapshot (no SQL needed). */
  static fromSnapshot(snap: CatalogSnapshot): CatalogGraph {
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

    return new CatalogGraph(
      tables, nameIndex, columnIndex, adjacency,
      snap.implicitEdges, new Date(snap.builtAt),
      (snap as any).lineage ?? [],
    )
  }

  // ── Concept graph ────────────────────────────────────────────

  /** Merge externally-curated lineage maps into the catalog. Rebuilds concept graph. */
  mergeLineage(lineages: ViewLineage[]): void {
    for (const l of lineages) this.lineageMap.set(l.view, l)
    buildConceptGraph(this.conceptNodes, this.conceptByView, this.conceptEdgeIndex, [...this.lineageMap.values()])
  }

  /** Get lineage for a specific view. */
  getLineage(qualifiedName: string): ViewLineage | null {
    return this.lineageMap.get(qualifiedName) ?? null
  }

  /** List all views that have lineage maps. */
  listLineage(): string[] {
    return [...this.lineageMap.keys()]
  }

  /** Check if a table appears as a source in any lineage map. */
  getLineageParents(qualifiedName: string): Array<{ view: string; businessArea: string }> {
    const results: Array<{ view: string; businessArea: string }> = []
    for (const l of this.lineageMap.values()) {
      for (const s of l.sources) {
        if (s.qualifiedName.toLowerCase() === qualifiedName.toLowerCase()) {
          results.push({ view: l.view, businessArea: s.businessArea })
        }
      }
    }
    return results
  }

  /** Get all business concepts a table/view contributes to (derived from lineage maps). */
  getTableConcepts(qualifiedName: string): ConceptNode[] {
    return this.conceptEdgeIndex.get(qualifiedName) ?? []
  }

  /**
   * Get a concept node by concept name (e.g. "Revenue") or source view
   * (e.g. "publish.Revenue"). Case-insensitive.
   */
  getConcept(nameOrView: string): ConceptNode | null {
    return this.conceptNodes.get(nameOrView.toLowerCase())
      ?? this.conceptByView.get(nameOrView.toLowerCase())
      ?? null
  }

  /** List all loaded concept nodes (one per lineage view). */
  listConcepts(): ConceptNode[] {
    return [...this.conceptNodes.values()]
  }

  // ── Search & traversal ────────────────────────────────────────

  /** Keyword search across table names and column names. Returns ranked results. */
  search(query: string, limit = 15): CatalogSearchHit[] {
    return searchCatalog(
      this.tables, this.nameIndex, this.columnIndex,
      this.implicitJoinIndex, this.conceptNodes, query, limit,
    )
  }

  /** Concept-aware path finding between two tables (FK + implicit + concept edges). */
  findConceptPath(from: string, to: string, maxDepth = 6): ConceptPathResult[] {
    return findConceptPathModule(
      this.tables, this.adjacency, this.implicitJoinIndex,
      this.conceptEdgeIndex, from, to, maxDepth,
    )
  }

  /** BFS path-finding between two tables via FK edges. */
  findPath(from: string, to: string, maxDepth = 5): CatalogFK[][] {
    return findFkPath(this.tables, this.adjacency, from, to, maxDepth)
  }

  /** Get a specific table by qualified name ("schema.Table"). */
  getTable(qualifiedName: string): CatalogTable | null {
    return this.tables.get(qualifiedName) ?? null
  }

  /** Find all tables that have a column with this exact name. */
  findTablesWithColumn(columnName: string, limit = 20): Array<{ table: CatalogTable; column: CatalogColumn }> {
    const colLower = columnName.toLowerCase()
    const keys = this.columnIndex.get(colLower) ?? new Set()
    const results: Array<{ table: CatalogTable; column: CatalogColumn }> = []
    for (const key of keys) {
      const table = this.tables.get(key)!
      const col = table.columns.find((c) => c.name.toLowerCase() === colLower)
      if (col) results.push({ table, column: col })
    }
    results.sort((a, b) => (b.table.rowCount ?? 0) - (a.table.rowCount ?? 0))
    return results.slice(0, limit)
  }

  /** Get all implicit join edges for a given table. */
  getImplicitJoins(key: string, limit = 20): ImplicitEdge[] {
    return (this.implicitJoinIndex.get(key) ?? []).slice(0, limit)
  }

  // ── Stats & summary ────────────────────────────────────────────

  /** High-level catalog statistics. */
  stats(): CatalogStats {
    let tables = 0, views = 0, columns = 0, fks = 0, totalRows = 0
    const schemas = new Set<string>()
    const largest: Array<{ name: string; rows: number }> = []

    for (const t of this.tables.values()) {
      schemas.add(t.schema)
      if (t.type === "TABLE") tables++; else views++
      columns += t.columns.length
      fks += t.fkOutgoing.length
      if (t.rowCount) {
        totalRows += t.rowCount
        largest.push({ name: t.qualifiedName, rows: t.rowCount })
      }
    }
    largest.sort((a, b) => b.rows - a.rows)

    return {
      schemas: schemas.size,
      tables,
      views,
      columns,
      fks,
      implicitEdges: this.implicitEdges.length,
      totalRows,
      largestTables: largest.slice(0, 15),
    }
  }

  /** Compact summary string for system prompt injection. */
  promptSummary(): string {
    const s = this.stats()
    const age = Math.round((Date.now() - this.builtAt.getTime()) / 3600000)
    const lineageViews = this.listLineage()
    const lines = [
      `Schema Catalog (built ${age}h ago): ${s.schemas} schemas, ${s.tables} tables, ${s.views} views, ${s.columns} columns, ${s.fks} FKs, ${s.implicitEdges} implicit join edges.`,
      `Total rows: ~${(s.totalRows / 1e6).toFixed(0)}M.`,
    ]
    if (lineageViews.length > 0) {
      lines.push(`Lineage maps available: ${lineageViews.join(", ")} — use search_catalog(lineage='view') to explore.`)
    }
    const conceptList = this.listConcepts()
    if (conceptList.length > 0) {
      lines.push(`Business concepts: ${conceptList.map((c) => c.concept).join(", ")} — use search_catalog(concepts='table') for semantic tags, search_catalog(concept_path=['A','B']) to trace cross-concept paths.`)
    }
    return lines.join("\n")
  }
}

// Re-export CatalogBuildOptions so store.ts doesn't need to import from types directly
export type { CatalogBuildOptions }
