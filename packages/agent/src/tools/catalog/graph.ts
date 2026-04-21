import { getPool } from "../mssql.js"
import { buildConceptGraph } from "./concepts.js"
import { buildSearchIndexes, computeImplicitEdges, tableKey, tokenize } from "./helpers.js"
import { findConceptPath as findConceptPathModule, findFkPath } from "./paths.js"
import { searchCatalog } from "./search.js"
import { Q_COLUMNS, Q_FKS, Q_OBJECTS, Q_SYS_COLUMNS, Q_VIEW_DEPS } from "./sql.js"
import { SYS_DESCRIPTORS } from "./sys-descriptors.js"
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
   * Columns are fetched from the live DB at build time; descriptions/aliases are curated
   * in sys-descriptors.ts. Used by searchSys() to surface DMV guidance when keyword search
   * on user tables returns no results or when the user explicitly asks about sys objects.
   * Key = lowercase sys object name (without schema prefix).
   */
  readonly sysCatalog: Map<string, SysEntry>
  /** Token → Set<sys object name> — built from curated aliases + actual column names. */
  private readonly sysIndex: Map<string, Set<string>>
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
    // Build sys catalog and its search index
    this.sysCatalog = new Map()
    this.sysIndex = new Map()
    if (sysCatalog) {
      for (const entry of sysCatalog) {
        this.sysCatalog.set(entry.name.toLowerCase(), entry)
      }
      this._buildSysIndex()
    }
  }

  /**
   * Build the sys search index from the current sysCatalog.
   * Indexes: object name tokens, curated alias tokens, column name tokens.
   */
  private _buildSysIndex(): void {
    const addToken = (token: string, key: string) => {
      if (!this.sysIndex.has(token)) this.sysIndex.set(token, new Set())
      this.sysIndex.get(token)!.add(key)
    }
    for (const entry of this.sysCatalog.values()) {
      const key = entry.name.toLowerCase()
      // Object name tokens
      for (const t of tokenize(entry.name)) addToken(t, key)
      // Curated alias tokens (semantic keywords — highest value)
      for (const alias of entry.aliases) {
        for (const t of tokenize(alias)) addToken(t, key)
        // Also index the alias as a whole phrase token (split on spaces)
        const phrase = alias.toLowerCase().trim()
        if (phrase.includes(" ")) {
          // index each word in multi-word aliases
          for (const word of phrase.split(/\s+/).filter((w) => w.length > 1)) addToken(word, key)
        } else if (phrase.length > 1) {
          addToken(phrase, key)
        }
      }
      // Column name tokens
      for (const col of entry.columns) {
        for (const t of tokenize(col.name)) addToken(t, key)
      }
    }
  }

  // ── Build from live database ─────────────────────────────────

  static async build(connection?: string): Promise<CatalogGraph> {
    const { pool } = await getPool(connection)
    // Start sys catalog fetch in parallel with user catalog (non-fatal if it fails)
    const sysCatalogPromise = CatalogGraph.buildSysCatalog(pool)
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

    // Step 6: Compute per-publish-view source row totals from view→table dependencies.
    // sys.sql_expression_dependencies is catalog metadata — runs in milliseconds.
    const viewSourceRows = new Map<string, number>()
    try {
      const depResult = await pool.request().query(Q_VIEW_DEPS)
      for (const r of depResult.recordset) {
        const viewKey = tableKey(r.view_schema, r.view_name)
        const refKey = tableKey(r.ref_schema, r.ref_name)
        const refTable = tables.get(refKey)
        if (refTable?.rowCount) {
          viewSourceRows.set(viewKey, (viewSourceRows.get(viewKey) ?? 0) + refTable.rowCount)
        }
      }
    } catch { /* non-fatal — older SQL Server versions may not have sys.sql_expression_dependencies */ }

    // Step 7: Await sys catalog
    const sysCatalog = await sysCatalogPromise

    return new CatalogGraph(tables, nameIndex, columnIndex, adjacency, implEdges, undefined, undefined, viewSourceRows, sysCatalog)
  }

  // ── Sys catalog build (separate step) ─────────────────────────

  /**
   * Fetch sys.* column definitions from the live database and build SysEntry objects
   * by overlaying the curated SYS_DESCRIPTORS. Returns only entries present in the
   * curated map (we ignore the hundreds of sys objects we have no guidance for).
   * Non-fatal: if the query fails (older SQL Server, restricted perms) returns [].
   */
  static async buildSysCatalog(pool: import("mssql").ConnectionPool): Promise<SysEntry[]> {
    try {
      const colResult = await pool.request().query(Q_SYS_COLUMNS)
      // Group columns by object name
      const colsByObject = new Map<string, Array<{ name: string; dataType: string }>>()
      for (const r of colResult.recordset) {
        const key = String(r.object_name).toLowerCase()
        if (!colsByObject.has(key)) colsByObject.set(key, [])
        colsByObject.get(key)!.push({ name: r.column_name, dataType: r.data_type })
      }
      // Build SysEntry for each curated descriptor, adding live columns
      const entries: SysEntry[] = []
      for (const [name, desc] of SYS_DESCRIPTORS) {
        entries.push({
          name,
          qualifiedName: `sys.${name}`,
          description: desc.description,
          aliases: desc.aliases,
          columns: colsByObject.get(name) ?? [],
          exampleQuery: desc.exampleQuery,
        })
      }
      return entries
    } catch {
      // Non-fatal: older SQL Server or restricted permissions
      // Build entries without live column data (still fully searchable via aliases)
      return [...SYS_DESCRIPTORS.entries()].map(([name, desc]) => ({
        name,
        qualifiedName: `sys.${name}`,
        description: desc.description,
        aliases: desc.aliases,
        columns: [],
        exampleQuery: desc.exampleQuery,
      }))
    }
  }

  // ── Serialization (persistent cache) ───────────────────────

  /** Serialize to a JSON-safe snapshot for disk persistence. */
  toSnapshot(source = "default"): CatalogSnapshot {
    return {
      version: 4,
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
    // Restore sys catalog from snapshot (re-overlay SYS_DESCRIPTORS to pick up any
    // code-side updates to descriptions/aliases since the snapshot was written)
    const sysCatalogEntries: SysEntry[] = []
    if (snap.sysCatalog) {
      for (const entry of snap.sysCatalog) {
        const descriptor = SYS_DESCRIPTORS.get(entry.name.toLowerCase())
        sysCatalogEntries.push({
          name: entry.name,
          qualifiedName: entry.qualifiedName,
          // Use live columns from snapshot but always use the latest curated descriptions
          columns: entry.columns,
          description: descriptor?.description ?? entry.description,
          aliases: descriptor?.aliases ?? entry.aliases,
          exampleQuery: descriptor?.exampleQuery ?? entry.exampleQuery,
        })
      }
    } else {
      // Old snapshot without sys catalog: build entries from descriptors only (no live columns)
      for (const [name, desc] of SYS_DESCRIPTORS) {
        sysCatalogEntries.push({
          name, qualifiedName: `sys.${name}`,
          description: desc.description, aliases: desc.aliases,
          columns: [], exampleQuery: desc.exampleQuery,
        })
      }
    }
    return new CatalogGraph(
      tables, nameIndex, columnIndex, adjacency,
      snap.implicitEdges, new Date(snap.builtAt),
      (snap as any).lineage ?? [],
      viewSourceRows,
      sysCatalogEntries,
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
   * Search the sys catalog by keyword.
   * Returns sys objects ranked by match quality:
   *   alias match = +80 (semantic, highest value)
   *   object name token match = +50
   *   column name match = +10
   * Only returns objects with score > 0. Limit defaults to 5 (sys results are supplemental).
   */
  searchSys(query: string, limit = 5): SysEntry[] {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []

    // Also consider the raw query string lowercased for multi-word alias matching
    const rawTokens = query.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 1)
    const allTokens = [...new Set([...tokens, ...rawTokens])]

    const scores = new Map<string, number>()
    for (const tok of allTokens) {
      const hits = this.sysIndex.get(tok) ?? new Set()
      for (const key of hits) {
        const entry = this.sysCatalog.get(key)
        if (!entry) continue
        // Determine match category for scoring
        const inAlias = entry.aliases.some(
          (a) => tokenize(a).includes(tok) || a.toLowerCase().includes(tok),
        )
        const inName = tokenize(entry.name).includes(tok)
        const inCol = entry.columns.some((c) => tokenize(c.name).includes(tok))
        const score = inAlias ? 80 : inName ? 50 : inCol ? 10 : 5
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

    const publishViews: Array<{ name: string; sourceRows: number }> = []
    for (const [name, sourceRows] of this.viewSourceRows) {
      if (name.startsWith("publish.")) publishViews.push({ name, sourceRows })
    }
    publishViews.sort((a, b) => b.sourceRows - a.sourceRows)

    return {
      schemas: schemas.size,
      tables,
      views,
      columns,
      fks,
      implicitEdges: this.implicitEdges.length,
      totalRows,
      largestTables: largest.slice(0, 15),
      largestPublishViews: publishViews.slice(0, 15),
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
