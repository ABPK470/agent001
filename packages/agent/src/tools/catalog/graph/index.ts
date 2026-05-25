import type { TableVerdictsReader } from "../../../host/ports.js"
import { tokenize } from "../helpers.js"
import { findFkPath } from "../paths.js"
import { searchCatalog } from "../search.js"
import type {
    CatalogBuildOptions,
    CatalogColumn,
    CatalogFK,
    CatalogSearchHit,
    CatalogSnapshot,
    CatalogStats,
    CatalogTable,
    ImplicitEdge,
    SysEntry,
} from "../types.js"
import { loadCatalogFromDb } from "./build.js"
import { loadCatalogFromSnapshot } from "./snapshot.js"
import { computeStats, formatPromptSummary } from "./stats.js"
import { buildSysCatalog, buildSysIndex } from "./sys-catalog.js"

// ── CatalogGraph ─────────────────────────────────────────────────

export class CatalogGraph {
  readonly tables: Map<string, CatalogTable>
  readonly implicitEdges: ImplicitEdge[]
  readonly builtAt: Date

  readonly nameIndex: Map<string, Set<string>>
  readonly columnIndex: Map<string, Set<string>>
  readonly adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>
  /** tableKey → implicit edges involving this table */
  readonly implicitJoinIndex: Map<string, ImplicitEdge[]>
  /**
   * Lowercased qualified name → canonical (original-case) key.
   * SQL identifiers are case-insensitive; the LLM and tool callers send
   * `publish.revenue`, `Publish.Revenue`, `PUBLISH.REVENUE` interchangeably.
   * Built once at construction so every `getTable` call is O(1) regardless
   * of casing. Required: was the root cause of the May 2026 production
   * "Table 'publish.revenue' not found" failure when the catalog stored
   * the view as `publish.Revenue`.
   */
  private readonly tablesLower: Map<string, string>
  /**
   * For every publish VIEW: sum of row_counts of the physical tables it directly references.
   * Built at catalog-build time from Q_VIEW_DEPS — zero runtime cost for the agent.
   * Key = "publish.ViewName", value = total source rows.
   */
  readonly viewSourceRows: Map<string, number>

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
    viewSourceRows?: Map<string, number>,
    sysCatalog?: SysEntry[],
  ) {
    this.tables = tables
    this.tablesLower = new Map()
    for (const key of tables.keys()) this.tablesLower.set(key.toLowerCase(), key)
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
    // Sys catalog and its search index
    this.sysCatalog = new Map()
    this.sysIndex = new Map()
    if (sysCatalog) {
      for (const entry of sysCatalog) this.sysCatalog.set(entry.name.toLowerCase(), entry)
      this.sysIndex = buildSysIndex(this.sysCatalog)
    }
  }

  // ── Build ─────────────────────────────────────────────────────

  static async build(host: import("../../../host/index.js").AgentHost, connection?: string): Promise<CatalogGraph> {
    const r = await loadCatalogFromDb(host, connection)
    return new CatalogGraph(
      r.tables, r.nameIndex, r.columnIndex, r.adjacency, r.implicitEdges,
      undefined, r.viewSourceRows, r.sysCatalog,
    )
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
      version: 7,
      builtAt: this.builtAt.toISOString(),
      source,
      tables: [...this.tables.values()],
      implicitEdges: this.implicitEdges,
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
      r.viewSourceRows,
      r.sysCatalog,
    )
  }

  // ── Search & traversal ────────────────────────────────────────

  /** Keyword search across table names and column names. Returns ranked results. */
  search(query: string, limit = 15, tableVerdicts?: TableVerdictsReader | null): CatalogSearchHit[] {
    return searchCatalog(
      this.tables, this.nameIndex, this.columnIndex,
      this.implicitJoinIndex, query, limit,
      this.viewSourceRows,
      tableVerdicts,
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

  /** BFS path-finding between two tables via FK edges. */
  findPath(from: string, to: string, maxDepth = 5): CatalogFK[][] {
    return findFkPath(this.tables, this.adjacency, from, to, maxDepth)
  }

  /**
   * Get a specific table by qualified name ("schema.Table"), case-insensitive.
   *
   * SQL Server identifiers are case-insensitive by default; LLM tool
   * arguments arrive in any case (`publish.revenue` vs `publish.Revenue`).
   * This method tries the exact original-case key first (fast path), then
   * falls back to the lowercased-key index. Returns `null` only when the
   * name truly isn't in the catalog under ANY casing.
   */
  getTable(qualifiedName: string): CatalogTable | null {
    const direct = this.tables.get(qualifiedName)
    if (direct) return direct
    const canonical = this.tablesLower.get(qualifiedName.toLowerCase())
    return canonical ? (this.tables.get(canonical) ?? null) : null
  }

  /**
   * For a VIEW defined as `SELECT … FROM a UNION ALL SELECT … FROM b
   * UNION ALL SELECT … FROM c`, return the list of `FROM`-target
   * qualified names — one per branch, in source order.
   *
   * Replaces the curated `getLineage(qn).sources` path. Pure parse over
   * `viewDefinition`: comments and string literals are stripped first,
   * then the body is split on `\bUNION(\s+ALL)?\b`. Each segment's
   * first `FROM <ident>(.<ident>)?` (square-bracket aware) becomes a
   * branch entry.
   *
   * Returns `[]` when the object isn't a view, has no definition, or
   * has no `UNION` (single-branch views aren't "branched"). Never throws.
   */
  getUnionBranches(qualifiedName: string): string[] {
    const t = this.tables.get(qualifiedName)
    if (!t || t.type !== "VIEW" || !t.viewDefinition) return []
    return parseUnionBranches(t.viewDefinition)
  }

  /**
   * Reverse of `getUnionBranches`: given a base table qualified name,
   * return every VIEW whose UNION branch list contains that table.
   * Used by the branch-coverage doctrine in mssql/validation.ts to
   * detect ranking-universe ≠ reporting-universe gaps. Case-insensitive
   * comparison so `[publish].[Revenue]` and `publish.Revenue` match.
   *
   * Pure scan over all VIEW tables; cost is O(views × branches/view).
   * Bounded; called rarely (only on query validation paths).
   */
  getUnionParents(qualifiedName: string): string[] {
    const target = qualifiedName.toLowerCase()
    const out: string[] = []
    for (const t of this.tables.values()) {
      if (t.type !== "VIEW" || !t.viewDefinition) continue
      const branches = parseUnionBranches(t.viewDefinition)
      if (branches.some((b) => b.toLowerCase() === target)) {
        out.push(t.qualifiedName)
      }
    }
    return out
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

  /**
   * Stable short fingerprint of the schema shape (qualifiedName + column
   * names). Used by the memory provenance layer to demote entries whose
   * stored schema no longer matches the live one. Pure: same set of
   * tables/columns produces the same fingerprint regardless of build
   * order, builtAt, or row counts.
   *
   * Format: `sha1:<hex16>` — 16-char prefix is enough for collision-free
   * comparison across a single workspace's lifetime; never used for
   * cryptographic purposes.
   */
  schemaFingerprint(): string {
    const sorted = [...this.tables.values()]
      .map((t) => {
        const cols = t.columns.map((c) => c.name).sort().join(",")
        return `${t.qualifiedName}(${cols})`
      })
      .sort()
      .join("\n")
    // Lightweight non-crypto hash (FNV-1a 32-bit, doubled into 16 hex chars).
    // Avoids pulling node:crypto into the catalog hot path.
    let h1 = 0x811c9dc5
    let h2 = 0x9dc5811c
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
      h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0
    }
    const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"))
    return `sha1:${hex}`
  }
}

// Re-export CatalogBuildOptions so store.ts doesn't need to import from types directly
export type { CatalogBuildOptions }

/**
 * Parse the `FROM` target qualified names out of each `UNION (ALL)?`
 * branch of a view definition. Returns `[]` when the body has no UNION.
 * Shared by `getUnionBranches` and `getUnionParents`.
 */
function parseUnionBranches(viewDefinition: string): string[] {
  const stripped = viewDefinition
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'[^']*'/g, "''")
  const segments = stripped.split(/\bUNION(?:\s+ALL)?\b/i)
  if (segments.length < 2) return []
  // FROM <schema>.<table> OR FROM <table> — bracket-aware. We only want
  // the FIRST FROM per branch (joined tables in the same branch are
  // intentionally not extracted — they're not the branch source).
  const FROM_RE = /\bFROM\s+(\[?[\w]+\]?(?:\.\[?[\w]+\]?)?)/i
  const out: string[] = []
  for (const seg of segments) {
    const m = FROM_RE.exec(seg)
    if (!m) continue
    out.push(m[1].replace(/\[|\]/g, ""))
  }
  return out
}
