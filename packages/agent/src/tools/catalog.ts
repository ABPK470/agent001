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

/** Serializable snapshot — persisted to JSON on disk for instant startup. */
export interface CatalogSnapshot {
  version: 1
  builtAt: string                 // ISO 8601
  source: string                  // connection name
  tables: CatalogTable[]
  implicitEdges: ImplicitEdge[]
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

  private nameIndex: Map<string, Set<string>>
  private columnIndex: Map<string, Set<string>>
  private adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>
  /** tableKey → implicit edges involving this table */
  private implicitJoinIndex: Map<string, ImplicitEdge[]>

  private constructor(
    tables: Map<string, CatalogTable>,
    nameIndex: Map<string, Set<string>>,
    columnIndex: Map<string, Set<string>>,
    adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>,
    implicitEdges: ImplicitEdge[],
    builtAt?: Date,
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
      version: 1,
      builtAt: this.builtAt.toISOString(),
      source,
      tables: [...this.tables.values()],
      implicitEdges: this.implicitEdges,
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
    )
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

      const score = nameScore + colScore + rowBonus + schemaBoost + viewBonus +
        incomingFkBonus + colRichness + connectivityBonus

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
    const lines = [
      `Schema Catalog (built ${age}h ago): ${s.schemas} schemas, ${s.tables} tables, ${s.views} views, ${s.columns} columns, ${s.fks} FKs, ${s.implicitEdges} implicit join edges.`,
      `Total rows: ~${(s.totalRows / 1e6).toFixed(0)}M.`,
      "Largest tables:",
    ]
    for (const t of s.largestTables.slice(0, 10)) {
      lines.push(`  ${t.name}: ~${(t.rows / 1e6).toFixed(0)}M rows`)
    }
    lines.push(
      "",
      "The catalog is a persistent knowledge graph. Use search_catalog BEFORE any other DB tool.",
      "search_catalog(joins='schema.Table') shows FK + implicit join edges.",
    )
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
        if (snap.version === 1) {
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
