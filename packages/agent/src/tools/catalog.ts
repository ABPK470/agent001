/**
 * Schema Catalog — persistent, searchable knowledge graph of the entire database.
 *
 * Architecture:
 *   BUILD PHASE (expensive, done rarely — daily/weekly):
 *     - 3 SQL queries against sys.* DMVs → tables, columns, FK edges
 *     - Compute implicit join edges (shared column names + compatible types)
 *     - Build in-memory indexes (keyword, column, FK adjacency, implicit joins)
 *     - Persist snapshot to JSON cache file on disk
 *
 *   LOAD PHASE (fast, every startup):
 *     - Read JSON cache file → rebuild in-memory indexes (milliseconds, no SQL)
 *
 *   QUERY PHASE (instant, every agent call):
 *     - In-memory graph traversal — microsecond lookups
 *
 * Rebuild interval is configurable via CATALOG_MAX_AGE_HOURS (default 168 = 7 days).
 * Force rebuild: search_catalog(refresh=true) or buildCatalog({ forceFresh: true }).
 */

import { getPool } from "./mssql.js"

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

// ── Tokenization ─────────────────────────────────────────────────

function tokenize(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
}

function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`
}
/** Is this column name likely a join candidate (ID, key, code, FK pattern)? */
function isJoinCandidate(colName: string): boolean {
  const l = colName.toLowerCase()
  return l.endsWith("id") || l.endsWith("key") || l.endsWith("code") ||
    l.endsWith("_fk") || l.endsWith("_pk") || l.includes("identifier") ||
    l.startsWith("fk_") || l.startsWith("pk_")
}

/**
 * Compute implicit join edges: groups of tables sharing a join-candidate
 * column name with the same data type.  Skips columns appearing in 100+
 * tables (too generic).
 */
function computeImplicitEdges(
  tables: Map<string, CatalogTable>,
  columnIndex: Map<string, Set<string>>,
): ImplicitEdge[] {
  const edges: ImplicitEdge[] = []
  for (const [colName, tableKeys] of columnIndex) {
    if (tableKeys.size < 2 || tableKeys.size > 100) continue
    if (!isJoinCandidate(colName)) continue
    const byType = new Map<string, string[]>()
    for (const key of tableKeys) {
      const col = tables.get(key)?.columns.find((c) => c.name.toLowerCase() === colName)
      if (!col) continue
      const dt = col.dataType.toLowerCase()
      if (!byType.has(dt)) byType.set(dt, [])
      byType.get(dt)!.push(key)
    }
    for (const [dataType, group] of byType) {
      if (group.length >= 2) edges.push({ column: colName, dataType, tables: group })
    }
  }
  return edges
}
// ── SQL introspection queries ────────────────────────────────────

const Q_OBJECTS = `
  SELECT
    s.name       AS schema_name,
    o.name       AS object_name,
    o.type_desc  AS object_type,
    CASE WHEN o.type = 'U' THEN (
      SELECT SUM(p.rows) FROM sys.partitions p
      WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)
    ) ELSE NULL END AS row_count
  FROM sys.objects o
  JOIN sys.schemas s ON o.schema_id = s.schema_id
  WHERE o.type IN ('U', 'V')
    AND o.is_ms_shipped = 0
  ORDER BY s.name, o.name
`

const Q_COLUMNS = `
  ;WITH pk_cols AS (
    SELECT ic.object_id, ic.column_id
    FROM sys.index_columns ic
    JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    WHERE i.is_primary_key = 1
  )
  SELECT
    s.name       AS schema_name,
    t.name       AS table_name,
    c.name       AS column_name,
    ty.name      AS data_type,
    c.max_length,
    c.is_nullable,
    CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_pk
  FROM sys.columns c
  JOIN sys.objects t  ON c.object_id = t.object_id
  JOIN sys.schemas s  ON t.schema_id = s.schema_id
  JOIN sys.types ty   ON c.user_type_id = ty.user_type_id
  LEFT JOIN pk_cols pk ON c.object_id = pk.object_id AND c.column_id = pk.column_id
  WHERE t.type IN ('U', 'V')
    AND t.is_ms_shipped = 0
  ORDER BY s.name, t.name, c.column_id
`

const Q_FKS = `
  SELECT
    fk.name  AS constraint_name,
    ps.name  AS from_schema,
    pt.name  AS from_table,
    pc.name  AS from_column,
    rs.name  AS to_schema,
    rt.name  AS to_table,
    rc.name  AS to_column
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
  JOIN sys.tables pt  ON fkc.parent_object_id     = pt.object_id
  JOIN sys.schemas ps ON pt.schema_id              = ps.schema_id
  JOIN sys.columns pc ON fkc.parent_object_id      = pc.object_id AND fkc.parent_column_id     = pc.column_id
  JOIN sys.tables rt  ON fkc.referenced_object_id  = rt.object_id
  JOIN sys.schemas rs ON rt.schema_id              = rs.schema_id
  JOIN sys.columns rc ON fkc.referenced_object_id  = rc.object_id AND fkc.referenced_column_id = rc.column_id
  ORDER BY fk.name, fkc.constraint_column_id
`

// ── CatalogGraph ─────────────────────────────────────────────────

export class CatalogGraph {
  readonly tables: Map<string, CatalogTable>
  readonly implicitEdges: ImplicitEdge[]
  readonly builtAt: Date
  /** Curated lineage maps for critical views, keyed by qualifiedName. */
  private lineageMap: Map<string, ViewLineage>

  private nameIndex: Map<string, Set<string>>
  private columnIndex: Map<string, Set<string>>
  private adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>
  /** tableKey → implicit edges involving this table */
  private implicitJoinIndex: Map<string, ImplicitEdge[]>

  /** Concept nodes indexed by concept name (lowercase) — e.g. "revenue" → ConceptNode */
  private conceptNodes: Map<string, ConceptNode>
  /** Source view (lowercase) → ConceptNode — fast lookup by view name */
  private conceptByView: Map<string, ConceptNode>
  /** tableKey → list of concept nodes this table contributes to (reverse index) */
  private conceptEdgeIndex: Map<string, ConceptNode[]>

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
      this._buildConceptGraph(lineage)
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
        })
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
    const nameIndex = new Map<string, Set<string>>()
    const columnIndex = new Map<string, Set<string>>()

    for (const [key, table] of tables) {
      // Index table/view name tokens
      for (const token of tokenize(table.name)) {
        if (!nameIndex.has(token)) nameIndex.set(token, new Set())
        nameIndex.get(token)!.add(key)
      }
      // Index schema name as token too
      const sToken = table.schema.toLowerCase()
      if (!nameIndex.has(sToken)) nameIndex.set(sToken, new Set())
      nameIndex.get(sToken)!.add(key)

      // Index column names
      for (const col of table.columns) {
        const colLower = col.name.toLowerCase()
        if (!columnIndex.has(colLower)) columnIndex.set(colLower, new Set())
        columnIndex.get(colLower)!.add(key)

        // Also index column name tokens into nameIndex (so "revenue" finds revenueAmount columns)
        for (const token of tokenize(col.name)) {
          if (!nameIndex.has(token)) nameIndex.set(token, new Set())
          nameIndex.get(token)!.add(key)
        }
      }
    }

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

    const nameIndex = new Map<string, Set<string>>()
    const columnIndex = new Map<string, Set<string>>()
    const adjacency = new Map<string, Array<{ target: string; fk: CatalogFK }>>()

    for (const [key, table] of tables) {
      for (const token of tokenize(table.name)) {
        if (!nameIndex.has(token)) nameIndex.set(token, new Set())
        nameIndex.get(token)!.add(key)
      }
      const sToken = table.schema.toLowerCase()
      if (!nameIndex.has(sToken)) nameIndex.set(sToken, new Set())
      nameIndex.get(sToken)!.add(key)

      for (const col of table.columns) {
        const colLower = col.name.toLowerCase()
        if (!columnIndex.has(colLower)) columnIndex.set(colLower, new Set())
        columnIndex.get(colLower)!.add(key)
        for (const token of tokenize(col.name)) {
          if (!nameIndex.has(token)) nameIndex.set(token, new Set())
          nameIndex.get(token)!.add(key)
        }
      }

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

  // ── Concept graph (private) ──────────────────────────────────

  /**
   * Rebuild concept graph from all current lineage maps.
   * For each view lineage, derives a ConceptNode (name = view's own name without schema)
   * and builds bi-directional indexes:
   *   conceptNodes["revenue"] → ConceptNode
   *   conceptEdgeIndex["publish.MappingTransactionalBanking"] → [ConceptNode(Revenue)]
   *   conceptEdgeIndex["publish.Revenue"] → [ConceptNode(Revenue)]  ← the view itself
   */
  private _buildConceptGraph(lineages: ViewLineage[]): void {
    this.conceptNodes.clear()
    this.conceptByView.clear()
    this.conceptEdgeIndex.clear()

    for (const l of lineages) {
      const concept = l.view.includes(".") ? l.view.split(".").pop()! : l.view
      const tables = [...new Set(l.sources.map((s) => s.qualifiedName))]
      const businessGroups = [...new Set(l.sources.map((s) => s.group))]
      const node: ConceptNode = { concept, sourceView: l.view, description: l.description, tables, businessGroups }

      this.conceptNodes.set(concept.toLowerCase(), node)
      this.conceptByView.set(l.view.toLowerCase(), node)

      // Reverse index: source tables → concepts they contribute to
      for (const tk of tables) {
        if (!this.conceptEdgeIndex.has(tk)) this.conceptEdgeIndex.set(tk, [])
        if (!this.conceptEdgeIndex.get(tk)!.some((n) => n.concept === concept)) {
          this.conceptEdgeIndex.get(tk)!.push(node)
        }
      }
      // The source view itself belongs to its own concept
      if (!this.conceptEdgeIndex.has(l.view)) this.conceptEdgeIndex.set(l.view, [])
      if (!this.conceptEdgeIndex.get(l.view)!.some((n) => n.concept === concept)) {
        this.conceptEdgeIndex.get(l.view)!.push(node)
      }
    }
  }

  private _pathVisited(steps: ConceptPathStep[], node: string): boolean {
    return steps.some((s) => s.from === node || s.to === node)
  }

  // ── Lineage ────────────────────────────────────────────

  /** Merge externally-curated lineage maps into the catalog. Rebuilds concept graph. */
  mergeLineage(lineages: ViewLineage[]): void {
    for (const l of lineages) this.lineageMap.set(l.view, l)
    this._buildConceptGraph([...this.lineageMap.values()])
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

  // ── Concept graph (public) ───────────────────────────────────

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

  /**
   * Concept-aware path finding between two tables.
   *
   * Traverses three edge types:
   *   • FK edges        — declared FK constraints (structural)
   *   • Implicit edges  — shared column name + type (inferred)
   *   • Concept edges   — tables sharing a business concept via lineage:
   *       tableA ──[concept:Revenue]──> publish.Revenue ──[concept:Revenue]──> tableB
   *
   * This surfaces semantic relationships that pure FK traversal cannot find.
   * E.g. fact.CommissionAllocation → publish.Revenue even with no FK between them.
   */
  findConceptPath(from: string, to: string, maxDepth = 6): ConceptPathResult[] {
    if (!this.tables.has(from) || !this.tables.has(to)) return []

    const results: ConceptPathResult[] = []
    const queue: Array<{ node: string; steps: ConceptPathStep[] }> = [{ node: from, steps: [] }]
    const visited = new Set<string>()

    while (queue.length > 0 && results.length < 5) {
      const { node, steps } = queue.shift()!
      if (steps.length > maxDepth) continue

      if (node === to && steps.length > 0) {
        const conceptsUsed = [...new Set(
          steps
            .filter((s) => s.edge.type === "concept")
            .map((s) => (s.edge as { type: "concept"; concept: string; via: string }).concept),
        )]
        results.push({ steps, totalHops: steps.length, conceptsUsed })
        continue
      }

      const depthKey = `${node}@${steps.length}`
      if (visited.has(depthKey)) continue
      visited.add(depthKey)

      // 1. FK edges (structural — declared FK constraints)
      for (const { target, fk } of (this.adjacency.get(node) ?? [])) {
        if (this._pathVisited(steps, target) && target !== to) continue
        queue.push({
          node: target,
          steps: [...steps, { from: node, edge: { type: "fk", fromColumn: fk.fromColumn, toColumn: fk.toColumn }, to: target }],
        })
      }

      // 2. Implicit join edges (inferred — shared column name + compatible type)
      for (const edge of (this.implicitJoinIndex.get(node) ?? [])) {
        for (const target of edge.tables) {
          if (target === node) continue
          if (this._pathVisited(steps, target) && target !== to) continue
          queue.push({
            node: target,
            steps: [...steps, { from: node, edge: { type: "implicit", column: edge.column, dataType: edge.dataType }, to: target }],
          })
        }
      }

      // 3. Concept edges (semantic — route through source view as hub)
      //    tableA → sourceView:  contributing table reaches the aggregating view
      //    sourceView → tableB:  the aggregating view fans out to all contributors
      for (const conceptNode of (this.conceptEdgeIndex.get(node) ?? [])) {
        const hub = conceptNode.sourceView
        const conceptEdge: ConceptPathEdge = { type: "concept", concept: conceptNode.concept, via: hub }

        if (node !== hub) {
          // This node is a contributing table → step toward the source view (hub)
          if (!this._pathVisited(steps, hub) || hub === to) {
            queue.push({ node: hub, steps: [...steps, { from: node, edge: conceptEdge, to: hub }] })
          }
        } else {
          // This node IS the source view → fan out to all contributing tables
          for (const target of conceptNode.tables) {
            if (target === node) continue
            if (this._pathVisited(steps, target) && target !== to) continue
            queue.push({ node: target, steps: [...steps, { from: node, edge: conceptEdge, to: target }] })
          }
        }
      }
    }

    return results
  }

  // ── Search ───────────────────────────────────────────────────

  /** Keyword search across table names and column names. Returns ranked results. */
  search(query: string, limit = 15): CatalogSearchHit[] {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []

    // Score each table
    const scores = new Map<string, { nameScore: number; colMatches: string[] }>()

    for (const token of tokens) {
      // Name-level matches (table name or schema name contains token)
      const nameHits = this.nameIndex.get(token)
      if (nameHits) {
        for (const key of nameHits) {
          if (!scores.has(key)) scores.set(key, { nameScore: 0, colMatches: [] })
          const entry = scores.get(key)!

          const table = this.tables.get(key)!
          // Exact table-name token match scores highest
          const tableTokens = tokenize(table.name)
          if (tableTokens.includes(token)) {
            entry.nameScore += 100
          }
        }
      }
    }

    // Column-level matches: find tables with columns matching any query token
    for (const token of tokens) {
      for (const [colName, tableKeys] of this.columnIndex) {
        if (colName.includes(token) || tokenize(colName).includes(token)) {
          for (const key of tableKeys) {
            if (!scores.has(key)) scores.set(key, { nameScore: 0, colMatches: [] })
            const entry = scores.get(key)!
            if (!entry.colMatches.includes(colName)) {
              entry.colMatches.push(colName)
            }
          }
        }
      }
    }

    // Concept-level matches: query tokens matching a concept name pull in all tables
    // belonging to that concept, even those with no lexical match in name/columns.
    // e.g. search("revenue") → fact.CommissionAllocation gets conceptBonus=15 even
    // though neither "revenue" nor any variant appears in its name or column list.
    const conceptBonusMap = new Map<string, number>()
    for (const token of tokens) {
      const cNode = this.conceptNodes.get(token)
      if (cNode) {
        // Source view IS the concept — strongest signal
        if (!scores.has(cNode.sourceView)) scores.set(cNode.sourceView, { nameScore: 0, colMatches: [] })
        conceptBonusMap.set(cNode.sourceView, (conceptBonusMap.get(cNode.sourceView) ?? 0) + 30)
        // Contributing sources are semantically related to the concept
        for (const tk of cNode.tables) {
          if (!scores.has(tk)) scores.set(tk, { nameScore: 0, colMatches: [] })
          conceptBonusMap.set(tk, (conceptBonusMap.get(tk) ?? 0) + 15)
        }
      }
    }

    // Build ranked results
    const hits: CatalogSearchHit[] = []
    for (const [key, { nameScore, colMatches }] of scores) {
      const table = this.tables.get(key)!
      const colScore = colMatches.length * 10
      const rowBonus = table.rowCount ? Math.min(Math.log10(table.rowCount + 1) * 2, 20) : 0

      // Schema tier boost: publish/persistedView are the curated BI layer — rank them first
      const schema = table.schema.toLowerCase()
      const schemaBoost =
        schema === "publish" ? 50 :
        schema === "persistedview" ? 45 :
        (schema === "fact" || schema === "dim") ? 20 :
        schema === "list" ? 5 :
        (schema === "archive" || schema === "etl") ? -20 :
        0

      // Structural signals — tables that are MORE connected/richer are more likely correct
      const viewBonus = table.type === "VIEW" ? 10 : 0
      // Centrality: tables referenced by many others are important (dimension tables, key publish views)
      const incomingFkBonus = Math.min(table.fkIncoming.length * 3, 30)
      // Column richness: tables with more columns have more data — more useful for analysis
      const colRichness = Math.min(Math.floor(table.columns.length / 5) * 2, 20)
      // Implicit join connectivity: tables with many implicit joins are well-connected
      const implicitJoins = this.implicitJoinIndex.get(key)?.length ?? 0
      const connectivityBonus = Math.min(implicitJoins * 2, 16)
      // Semantic boost: table belongs to a concept matching the query
      const conceptBonus = conceptBonusMap.get(key) ?? 0

      const score = nameScore + colScore + rowBonus + schemaBoost + viewBonus +
        incomingFkBonus + colRichness + connectivityBonus + conceptBonus

      hits.push({
        table,
        matchType: nameScore > 0 ? "name" : "column",
        matchedColumns: colMatches,
        score,
      })
    }

    // Sort: highest score first, then by row count descending
    hits.sort((a, b) => b.score - a.score || (b.table.rowCount ?? 0) - (a.table.rowCount ?? 0))
    return hits.slice(0, limit)
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

  /** BFS path-finding between two tables via FK edges. */
  findPath(from: string, to: string, maxDepth = 5): CatalogFK[][] {
    if (!this.tables.has(from) || !this.tables.has(to)) return []

    const paths: CatalogFK[][] = []
    const queue: Array<{ node: string; path: CatalogFK[] }> = [{ node: from, path: [] }]
    const visited = new Set<string>()

    while (queue.length > 0 && paths.length < 5) {
      const { node, path } = queue.shift()!
      if (path.length > maxDepth) continue
      if (node === to && path.length > 0) { paths.push(path); continue }

      const depthKey = `${node}@${path.length}`
      if (visited.has(depthKey)) continue
      visited.add(depthKey)

      for (const { target, fk } of (this.adjacency.get(node) ?? [])) {
        if (path.some((e) => tableKey(e.fromSchema, e.fromTable) === target || tableKey(e.toSchema, e.toTable) === target) && target !== to) continue
        queue.push({ node: target, path: [...path, fk] })
      }
    }
    return paths
  }

  /** Get all implicit join edges for a given table. */
  getImplicitJoins(key: string, limit = 20): ImplicitEdge[] {
    return (this.implicitJoinIndex.get(key) ?? []).slice(0, limit)
  }

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

// ── Global catalog store (per connection, with disk cache) ───────

const _catalogs = new Map<string, CatalogGraph>()
let _defaultCachePath: string | undefined

/**
 * Build or load the catalog.  If a cachePath is provided and a fresh-enough
 * cache file exists, loads from disk (milliseconds).  Otherwise introspects
 * MSSQL (seconds) and writes the cache for next time.
 *
 * Accepts a string (connection name, backward compat) or CatalogBuildOptions.
 */
export async function buildCatalog(opts?: string | CatalogBuildOptions): Promise<CatalogGraph> {
  const o: CatalogBuildOptions = typeof opts === "string" ? { connection: opts } : (opts ?? {})
  const conn = o.connection ?? "default"
  const cachePath = o.cachePath ?? _defaultCachePath
  const maxAge = o.maxAgeMs ?? 7 * 24 * 3600_000  // 7 days default
  if (o.cachePath) _defaultCachePath = o.cachePath  // remember for refresh calls

  // Try loading from persistent cache (unless forceFresh)
  if (cachePath && !o.forceFresh) {
    try {
      const fs = await import("node:fs/promises")
      const stat = await fs.stat(cachePath)
      if (Date.now() - stat.mtimeMs < maxAge) {
        const raw = await fs.readFile(cachePath, "utf-8")
        const snap: CatalogSnapshot = JSON.parse(raw)
        if (snap.version === 1 || snap.version === 2) {
          const catalog = CatalogGraph.fromSnapshot(snap)
          _catalogs.set(conn, catalog)
          return catalog
        }
      }
    } catch { /* no cache or invalid — build fresh */ }
  }

  // Build from live database (expensive — 3 SQL queries)
  const catalog = await CatalogGraph.build(conn)
  _catalogs.set(conn, catalog)

  // Persist to cache for next startup
  if (cachePath) {
    try {
      const fs = await import("node:fs/promises")
      const { dirname } = await import("node:path")
      await fs.mkdir(dirname(cachePath), { recursive: true })
      await fs.writeFile(cachePath, JSON.stringify(catalog.toSnapshot(conn)), "utf-8")
    } catch { /* cache write failure is non-fatal */ }
  }

  return catalog
}

/** Get a previously built/loaded catalog. */
export function getCatalog(connection = "default"): CatalogGraph | null {
  return _catalogs.get(connection) ?? null
}

export function hasCatalog(): boolean {
  return _catalogs.size > 0
}

export function getCatalogPromptSummary(connection = "default"): string {
  return _catalogs.get(connection)?.promptSummary() ?? ""
}

/**
 * Load lineage definitions from a JSON file and merge into the catalog.
 * Call this after buildCatalog() — lineage is curated, not auto-discovered.
 */
export async function loadLineage(
  filePath: string,
  connection = "default",
): Promise<number> {
  const catalog = _catalogs.get(connection)
  if (!catalog) throw new Error("Catalog not built yet — call buildCatalog() first")

  const fs = await import("node:fs/promises")
  const { resolve } = await import("node:path")
  const resolved = resolve(filePath)
  const raw = await fs.readFile(resolved, "utf-8")
  const lineages: ViewLineage[] = JSON.parse(raw)
  catalog.mergeLineage(lineages)

  // Re-persist the snapshot so lineage is cached with structural data
  const cachePath = _defaultCachePath
  if (cachePath) {
    try {
      const { dirname } = await import("node:path")
      await fs.mkdir(dirname(cachePath), { recursive: true })
      await fs.writeFile(cachePath, JSON.stringify(catalog.toSnapshot(connection)), "utf-8")
    } catch { /* non-fatal */ }
  }

  return lineages.length
}
