/**
 * Table verdicts — durable judgments about MSSQL objects' roles in a DB.
 *
 * Plan v3 Phase 3.
 *
 * Why: the agent has rich storage surfaces (3-tier memory, tool_knowledge,
 * procedural memory) but no convention for capturing the OUTCOME of a
 * discovery run as a re-usable verdict ("publish.Revenue is the canonical
 * revenue source; publish.RevenueESGRules is one of its branches"). Without
 * verdicts, every conversation re-derives the same conclusions from raw
 * tool outputs — and sometimes derives wrong ones (see May 2026 failing
 * trace where the agent picked the ESG subset over the canonical view).
 *
 * Storage decision: reuse `memory_entries` semantic tier with a
 * `metadata.kind="table_verdict"` convention. NO new SQLite table. The
 * existing FTS5 + vector indexes auto-index our entries; the existing
 * retrieval pipeline can already find them; the existing tenant-isolation
 * logic already protects them.
 *
 * Read path: `listTableVerdicts({ qnames, connection })` returns the
 * newest verdict per qname. Used by `search_catalog` at rank time
 * (Phase 4) to boost canonical candidates and demote known subsets.
 *
 * Write path: `recordTableVerdict({ qname, role, … })` is called by the
 * post-run reflection turn (Phase 5) and is exposed to the agent via the
 * `note` tool as `kind: 'table_verdict'`.
 */

import { randomUUID } from "node:crypto"
import { getDb } from "../db/index.js"
import { MemoryRole, MemorySource, MemoryTier } from "./types.js"

// ── Public types ─────────────────────────────────────────────────

/**
 * Semantic role of a table or view within a database. Drives the
 * `memoryVerdictBonus` in search_catalog ranking.
 */
export type TableVerdictRole =
  | "canonical"   // the wide UNION/aggregator view that answers the metric
  | "subset"      // a branch view of the canonical (smaller scope)
  | "staging"     // ETL intermediate; not for end-user queries
  | "archive"     // historical/frozen snapshot
  | "rules"       // a rules-derivation subset (e.g. *ESGRules, *RWARules)
  | "unknown"     // role observed but no confident classification

export interface TableVerdictInput {
  /** Schema-qualified object name (e.g. "publish.Revenue"). Case is preserved. */
  qname: string
  role: TableVerdictRole
  /**
   * Brief structural evidence (one short string per signal). Examples:
   *   ["fanIn=59", "incomingFK=12", "containsBranch:publish.RevenueESGRules"]
   * Kept as a string[] so each item can FTS-index independently.
   */
  evidence?: string[]
  /** The user goal that motivated this observation. Optional context. */
  observedFromGoal?: string
  /**
   * Logical MSSQL connection the verdict applies to. Verdicts are
   * connection-scoped so cross-DB tenants do not cross-pollute. Defaults
   * to "default".
   */
  connection?: string
  /** 0..1 confidence. Defaults to 0.85 (the agent has made a deliberate call). */
  confidence?: number
  sessionId?: string | null
  runId?: string | null
  upn?: string | null
  /** Shared across users by default — verdicts are objective DB facts. */
  shared?: boolean
}

export interface TableVerdict {
  id: string
  qname: string
  role: TableVerdictRole
  evidence: string[]
  observedFromGoal: string | null
  connection: string
  confidence: number
  createdAt: string
}

// ── Write ────────────────────────────────────────────────────────

/**
 * Persist a table verdict to the semantic memory tier. Always succeeds
 * (no salience floor, no Jaccard dedup) — verdicts are objective DB
 * facts, not chatty notes, so the standard ingestion gates are bypassed.
 *
 * Newer verdicts for the same qname do NOT delete older ones — they are
 * additive. `listTableVerdicts` returns the newest per qname so the
 * latest judgment naturally wins.
 */
export function recordTableVerdict(input: TableVerdictInput): TableVerdict {
  const qname = input.qname.trim()
  if (!qname) throw new Error("recordTableVerdict: qname is required")
  const role: TableVerdictRole = input.role
  const evidence = (input.evidence ?? []).map((s) => s.trim()).filter(Boolean)
  const connection = (input.connection ?? "default").trim() || "default"
  const confidence = input.confidence ?? 0.85
  const observedFromGoal = input.observedFromGoal?.trim() || null

  // Compose human-readable + FTS-indexable content. Format chosen so a
  // grep / FTS query for `table_verdict publish.Revenue` finds the row,
  // and so retrieveContext renders a useful snippet for the LLM.
  const evidenceTail = evidence.length > 0 ? ` ev: ${evidence.join("; ")}` : ""
  const content = `[table_verdict:${role}] ${qname} (conn=${connection})${evidenceTail}`

  const metadata = {
    kind: "table_verdict",
    qname,
    role,
    evidence,
    observedFromGoal,
    connection,
  }

  const now = new Date().toISOString()
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO memory_entries (
      id, tier, role, content, metadata, source, confidence, salience,
      access_count, session_id, run_id, parent_id, upn, shared,
      created_at, updated_at
    ) VALUES (
      @id, @tier, @role, @content, @metadata, @source, @confidence, @salience,
      0, @session_id, @run_id, NULL, @upn, @shared,
      @created_at, @updated_at
    )
  `).run({
    id,
    tier: MemoryTier.Semantic,
    role: MemoryRole.Summary,
    content,
    metadata: JSON.stringify(metadata),
    source: MemorySource.Agent,
    confidence,
    // Verdicts are inherently high-value: a deliberate role classification
    // is worth more than the prose-length salience heuristic would award.
    salience: 0.9,
    session_id: input.sessionId ?? null,
    run_id: input.runId ?? null,
    upn: input.upn ?? null,
    shared: (input.shared ?? true) ? 1 : 0,
    created_at: now,
    updated_at: now,
  })

  return {
    id,
    qname,
    role,
    evidence,
    observedFromGoal,
    connection,
    confidence,
    createdAt: now,
  }
}

// ── Read ─────────────────────────────────────────────────────────

export interface ListTableVerdictsOptions {
  /** Restrict to these qualified names (case-insensitive). Empty/omitted = all. */
  qnames?: string[]
  /** Logical connection to scope to. Defaults to "default". */
  connection?: string
  /** Optional UPN restriction for tenant isolation. Null means no filter. */
  upn?: string | null
  /** Cap on rows returned. Defaults to 50 (covers a generous search_catalog top-K). */
  limit?: number
}

/**
 * Return the NEWEST verdict per qname matching the filter. Sorted by
 * `created_at DESC`. Returns at most one row per qname (the latest wins).
 *
 * Performance: a single SQL pass with a window-function dedup. The query
 * scans semantic-tier rows whose JSON metadata declares kind=table_verdict;
 * this is a tiny slice of the memory table on any realistic workload.
 */
export function listTableVerdicts(options: ListTableVerdictsOptions = {}): TableVerdict[] {
  const connection = (options.connection ?? "default").trim() || "default"
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500))
  const qnamesLower = options.qnames?.map((q) => q.trim().toLowerCase()).filter(Boolean) ?? []

  // We can't easily JSON-extract in a portable way that uses an index,
  // but the semantic tier is small. Filter in SQL by tier + JSON LIKE,
  // then refine in JS.
  const rows = getDb().prepare(`
    SELECT id, content, metadata, confidence, created_at, upn
    FROM memory_entries
    WHERE tier = 'semantic'
      AND metadata LIKE '%"kind":"table_verdict"%'
      AND ((upn IS NULL AND ? IS NULL) OR upn = ? OR shared = 1)
    ORDER BY created_at DESC
  `).all(options.upn ?? null, options.upn ?? null) as Array<{
    id: string
    content: string
    metadata: string
    confidence: number
    created_at: string
    upn: string | null
  }>

  const seen = new Set<string>() // lowercased qname
  const out: TableVerdict[] = []
  for (const row of rows) {
    let meta: { qname?: string; role?: TableVerdictRole; evidence?: string[]; observedFromGoal?: string | null; connection?: string }
    try {
      meta = JSON.parse(row.metadata)
    } catch {
      continue
    }
    if (!meta.qname || !meta.role) continue
    const metaConn = (meta.connection ?? "default").trim() || "default"
    if (metaConn !== connection) continue
    const key = meta.qname.toLowerCase()
    if (seen.has(key)) continue
    if (qnamesLower.length > 0 && !qnamesLower.includes(key)) continue
    seen.add(key)
    out.push({
      id: row.id,
      qname: meta.qname,
      role: meta.role,
      evidence: meta.evidence ?? [],
      observedFromGoal: meta.observedFromGoal ?? null,
      connection: metaConn,
      confidence: row.confidence,
      createdAt: row.created_at,
    })
    if (out.length >= limit) break
  }
  return out
}
