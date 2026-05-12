import { buildConceptGraph } from "./concepts.js"
import { tokenize } from "./helpers.js"
import { findConceptPath as findConceptPathModule, findFkPath } from "./paths.js"
import { searchCatalog } from "./search.js"
import { loadCatalogFromDb } from "./graph/build.js"
import { loadCatalogFromSnapshot } from "./graph/snapshot.js"
import { computeStats, formatPromptSummary } from "./graph/stats.js"
import { buildSysCatalog, buildSysIndex } from "./graph/sys-catalog.js"
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
    SysEntry,
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
  /**
   * For every publish VIEW: sum of row_counts of the physical tables it directly references.
   * Built at catalog-build time from Q_VIEW_DEPS — zero runtime cost for the agent.
   * Key = "publish.ViewName", value = total source rows.
   */
  readonly viewSourceRows: Map<string, number>

  /** Concept nodes indexed by concept name (lowercase) — e.g. "revenue" → ConceptNode */
  readonly conceptNodes: Map<string, ConceptNode>
  /** Source view (lowercase) → ConceptNode — fast lookup by view name */
  readonly conceptByView: Map<string, ConceptNode>
  /** tableKey → list of concept nodes this table contributes to (reverse index) */
  readonly conceptEdgeIndex: Map<string, ConceptNode[]>

  /**
   * sys.* catalog — entries for SQL Server system objects (DMVs, catalog views, TVFs).
   * Used by searchSys() to surface DMV guidance when user-table search returns nothing
   * or when the user explicitly asks about sys objects.
   * Key = lowercase sys object name (without schema prefix).
   */
  readonly sysCatalog: Map<string, SysEntry>
  /** Token → Set<sys object name> — built from object + column name tokens. */
  private sysIndex: Map<string, Set<string>>

  private constructor(
    tables: Map<string, CatalogTable>,
    nameIndex: Map<string, Set<string>>,
    columnIndex: Map<string, Set<string>>,
    adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>,
    implicitEdges: ImplicitEdge[],
    builtAt?: Date,
    lineage?: ViewLineage[],
    viewSourceRows?: Map<string, number>,
    sysCatalog?: SysEntry[],
  ) {
    this.tables = tables
    this.nameIndex = nameIndex
    this.columnIndex = columnIndex
    this.adjacency = adjacency
    this.implicitEdges = implicitEdges
    this.builtAt = builtAt ?? new Date()
    this.viewSourceRows = viewSourceRows ?? new Map()
    // Build implicit join index for fast per-table lookup
    this.implicitJoinIndex = new Map()
    for (const edge of implicitEdges) {
      for (const tk of edge.tables) {
        if (!this.implicitJoinIndex.has(tk)) this.implicitJoinIndex.set(tk, [])
        this.implicitJoinIndex.get(tk)!.push(edge)
      }
    }
    // Lineage index
    this.lineageMap = new Map()
    if (lineage) for (const l of lineage) this.lineageMap.set(l.view, l)
    // Concept graph (pure in-memory derivation from lineage — zero SQL)
    this.conceptNodes = new Map()
    this.conceptByView = new Map()
    this.conceptEdgeIndex = new Map()
    if (lineage && lineage.length > 0) {
      buildConceptGraph(this.conceptNodes, this.conceptByView, this.conceptEdgeIndex, lineage)
    }
    // Sys catalog and its search index
    this.sysCatalog = new Map()
    this.sysIndex = new Map()
    if (sysCatalog) {
      for (const entry of sysCatalog) this.sysCatalog.set(entry.name.toLowerCase(), entry)
      this.sysIndex = buildSysIndex(this.sysCatalog)
    }
  }

  // ── Build ─────────────────────────────────────────────────────

  static async build(connection?: string): Promise<CatalogGraph> {
    const r = await loadCatalogFromDb(connection)
    const graph = new CatalogGraph(
      r.tables, r.nameIndex, r.columnIndex, r.adjacency, r.implicitEdges,
      undefined, undefined, r.viewSourceRows, r.sysCatalog,
    )
    // Auto-lineage merged first; hand-curated loadLineage() runs after build() and overwrites these.
    if (r.autoLineage.length > 0) graph.mergeLineage(r.autoLineage)
    return graph
  }

  /**
   * Fetch ALL sys.* column definitions from the live database. Kept on the
   * class for backwards compatibility with any external callers.
   */
  static buildSysCatalog(pool: import("mssql").ConnectionPool): Promise<SysEntry[]> {
    return buildSysCatalog(pool)
  }

  // ── Serialization ─────────────────────────────────────────────

  /** Serialize to a JSON-safe snapshot for disk persistence. */
  toSnapshot(source = "default"): CatalogSnapshot {
    return {
      version: 6,
      builtAt: this.builtAt.toISOString(),
      source,
      tables: [...this.tables.values()],
      implicitEdges: this.implicitEdges,
      lineage: [...this.lineageMap.values()],
      viewSourceRows: [...this.viewSourceRows.entries()].map(([name, sourceRows]) => ({ name, sourceRows })),
      sysCatalog: [...this.sysCatalog.values()],
    }
  }

  /** Rebuild in-memory graph from a persisted snapshot (no SQL needed). */
  static fromSnapshot(snap: CatalogSnapshot): CatalogGraph {
    const r = loadCatalogFromSnapshot(snap)
    return new CatalogGraph(
      r.tables, r.nameIndex, r.columnIndex, r.adjacency,
      snap.implicitEdges, new Date(snap.builtAt),
      (snap as { lineage?: ViewLineage[] }).lineage ?? [],
      r.viewSourceRows,
      r.sysCatalog,
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

  /**
   * Search the sys catalog by keyword. Object-name token match scores +50,
   * column-name token match scores +10. Returns objects with score > 0,
   * limit defaults to 8 (sys results are supplemental).
   */
  searchSys(query: string, limit = 8): SysEntry[] {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []

    const scores = new Map<string, number>()
    for (const tok of tokens) {
      const hits = this.sysIndex.get(tok) ?? new Set()
      for (const key of hits) {
        const entry = this.sysCatalog.get(key)
        if (!entry) continue
        const inName = tokenize(entry.name).includes(tok)
        const score = inName ? 50 : 10
        scores.set(key, (scores.get(key) ?? 0) + score)
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key]) => this.sysCatalog.get(key)!)
  }

  /** Get a specific sys entry by name (case-insensitive). */
  getSysEntry(name: string): SysEntry | null {
    return this.sysCatalog.get(name.toLowerCase().replace(/^sys\./, "")) ?? null
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
    return computeStats(this)
  }

  /** Compact summary string for system prompt injection. */
  promptSummary(): string {
    return formatPromptSummary(this)
  }
}

// Re-export CatalogBuildOptions so store.ts doesn't need to import from types directly
export type { CatalogBuildOptions }
