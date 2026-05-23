/**
 * `<known_objects>` system-anchor block — surfaces a compact directory of
 * tables/views this org has already profiled, so the LLM can:
 *   (a) avoid re-running expensive `profile_data` calls when fresh data
 *       is in the tool_knowledge cache, and
 *   (b) prefer objects it already understands when answering ambiguous
 *       follow-ups.
 *
 * Selection: extract qualified-name candidates (`schema.table` shape)
 * from the goal + prior-turn text, look each one up, render up to
 * `limit` rows newest-first. Output is hard-capped at MAX_CHARS so a
 * runaway extraction can never blow the system-anchor budget.
 *
 * Cache-only: this never reads MSSQL. If tool_knowledge is empty the
 * block is empty (caller will skip injection).
 */

import type Database from "better-sqlite3"
import { getDb } from "../db/index.js"
import { listTableVerdicts, type TableVerdictRole } from "../memory/index.js"
import type { PriorTurn } from "./prior-turns.js"

export interface LoadKnownObjectsOptions {
  /** Optional db override (tests). Defaults to the shared server db. */
  db?: Database.Database
  goal: string
  priorTurns: readonly PriorTurn[]
  limit?: number
}

export interface KnownObjectRow {
  qname: string
  tool: string
  mode: string
  ageHours: number
  bytes: number
}

const DEFAULT_LIMIT = 8
const MAX_CHARS = 2000

// `[a-z][\w]*\.[a-zA-Z][\w]*` — schema.table shape, requiring leading
// lowercase on the schema (most warehouse schemas: dim, fact, publish,
// abi, dbo). Catches `publish.Balances`, `dim.Date`, `dbo.RevenueByMonth`.
// Won't catch fully-qualified `db.dbo.Table` but those are rare in goals.
const QNAME_RE = /\b([a-z][a-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g

function extractQnames(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(QNAME_RE)) {
    out.add(`${m[1]}.${m[2]}`.toLowerCase())
  }
  return [...out]
}

/**
 * Returns the freshest tool_knowledge row per qname for the candidate
 * set, newest first. Stale-by-TTL detection lives in
 * lookupToolKnowledge; here we just show what's on disk and let the LLM
 * decide whether to re-run.
 *
 * Gap 3: when the goal + prior turns mention no schema-qualified names
 * (very common — "top 50 clients opportunities" has none), we fall back
 * to a small global tail of the freshest cached qnames so the LLM still
 * sees the org's recently-touched objects and can shortcut on them. The
 * fallback is hard-capped so the block stays small.
 */
export function loadKnownObjects(opts: LoadKnownObjectsOptions): KnownObjectRow[] {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const candidates = new Set<string>()
  for (const q of extractQnames(opts.goal)) candidates.add(q)
  for (const t of opts.priorTurns) {
    for (const q of extractQnames(t.goal)) candidates.add(q)
    if (t.answer) for (const q of extractQnames(t.answer)) candidates.add(q)
  }

  const db = opts.db ?? getDb()
  type Row = { qname: string; tool: string; mode: string; bytes: number; created_at: number }

  let rows: Row[] = []
  if (candidates.size > 0) {
    const placeholders = [...candidates].map(() => "?").join(",")
    rows = db.prepare(`
      SELECT qname, tool, mode, bytes, created_at
      FROM tool_knowledge
      WHERE qname IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...candidates, limit) as Row[]
  }

  // Gap 3 fallback / top-up: append the globally-freshest rows so the
  // block is non-empty when the goal text doesn't name objects, and so
  // repeatedly-used objects show up even when the goal pivots topic
  // (e.g. revenue → clients still using publish.Revenue under the hood).
  // Cap the top-up so the block stays small.
  const FALLBACK_TOPUP = Math.max(1, Math.min(5, limit - rows.length))
  if (FALLBACK_TOPUP > 0) {
    const seenQnames = new Set(rows.map(r => r.qname))
    const extra = db.prepare(`
      SELECT qname, tool, mode, bytes, created_at
      FROM tool_knowledge
      ORDER BY created_at DESC
      LIMIT ?
    `).all(FALLBACK_TOPUP * 2) as Row[]
    for (const r of extra) {
      if (seenQnames.has(r.qname)) continue
      rows.push(r)
      seenQnames.add(r.qname)
      if (rows.length >= limit) break
    }
  }

  if (rows.length === 0) return []

  const now = Date.now()
  // Dedupe by qname (newest wins because of ORDER BY).
  const seen = new Set<string>()
  const out: KnownObjectRow[] = []
  for (const r of rows) {
    if (seen.has(r.qname)) continue
    seen.add(r.qname)
    out.push({
      qname: r.qname,
      tool: r.tool,
      mode: r.mode,
      ageHours: Math.round((now - r.created_at) / 3_600_000),
      bytes: r.bytes,
    })
  }
  return out
}

/**
 * Render the `<known_objects>` block. Returns "" when there's nothing to
 * surface so the caller can skip injection cleanly.
 *
 * Optional `verdicts` (Plan v3 Phase 4) appends a "DURABLE TABLE
 * VERDICTS" sub-section listing role classifications recorded by prior
 * runs (canonical / subset / staging / archive / rules / unknown). This
 * primes the LLM with structural knowledge it would otherwise have to
 * re-discover, and complements the search_catalog rank-time bonus.
 */
export function renderKnownObjectsBlock(
  rows: readonly KnownObjectRow[],
  verdicts: readonly CandidateVerdictRow[] = [],
): string {
  if (rows.length === 0 && verdicts.length === 0) return ""
  const lines: string[] = ["<known_objects>"]
  if (rows.length > 0) {
    lines.push(
      "These tables/views have already been profiled or inspected by this org",
      "and the results are cached in tool_knowledge. Before running",
      "`profile_data`, `inspect_definition`, or `discover_relationships` on",
      "any of them, just call the tool normally \u2014 a fresh cached payload",
      "will be returned automatically with a `[cached from \u2026]` header (no",
      "MSSQL round trip). The list is qname-deduped, newest first.",
      "",
      "qname | tool | mode | ageHours | bytes",
    )
  }
  let total = lines.join("\n").length
  for (const r of rows) {
    const line = `${r.qname} | ${r.tool} | ${r.mode} | ${r.ageHours}h | ${r.bytes}B`
    if (total + line.length + 1 + "</known_objects>".length + 1 > MAX_CHARS) break
    lines.push(line)
    total += line.length + 1
  }
  if (verdicts.length > 0) {
    const header = [
      ...(rows.length > 0 ? [""] : []),
      "DURABLE TABLE VERDICTS \u2014 role classifications learned from prior runs.",
      "Prefer 'canonical' objects; treat 'subset' / 'rules' as scoped derivatives;",
      "avoid 'staging' / 'archive' unless explicitly requested.",
      "",
      "qname | role | evidence",
    ]
    for (const h of header) {
      if (total + h.length + 1 + "</known_objects>".length + 1 > MAX_CHARS) break
      lines.push(h)
      total += h.length + 1
    }
    for (const v of verdicts) {
      const ev = v.evidence.length > 0 ? v.evidence.join("; ") : "\u2014"
      const line = `${v.qname} | ${v.role} | ${ev}`
      if (total + line.length + 1 + "</known_objects>".length + 1 > MAX_CHARS) break
      lines.push(line)
      total += line.length + 1
    }
  }
  lines.push("</known_objects>")
  return lines.join("\n")
}

// ── Candidate verdicts (Plan v3 Phase 4) ────────────────────────

export interface CandidateVerdictRow {
  qname: string
  role: TableVerdictRole
  evidence: string[]
}

export interface LoadCandidateVerdictsOptions {
  /** Goal text — passed to `catalog.search(goal, k)` to find candidates. */
  goal: string
  /** Top-K catalog candidates to consider. Default 8. */
  k?: number
  /** Logical MSSQL connection to scope verdicts to. Default "default". */
  connection?: string
  /** UPN owner of the active run (for shared/private memory scoping). */
  upn?: string | null
  /**
   * Catalog instance to search. Server passes
   * `getCatalog(connectionName)`. When null, returns []; the block then
   * shows only goal-mentioned qnames (legacy behaviour).
   */
  catalog?: { search: (q: string, limit?: number) => Array<{ table: { qualifiedName: string } }> } | null
}

/**
 * Run a synthetic `search_catalog(goal)` and look up verdicts for the
 * top-K candidates. Returns at most K rows, newest verdict per qname.
 *
 * Cheap because:
 *   - catalog.search is in-memory token scoring
 *   - listTableVerdicts is a single indexed SQL query
 *
 * Silent fallback: empty array on any failure or missing catalog.
 */
export function loadCandidateVerdicts(opts: LoadCandidateVerdictsOptions): CandidateVerdictRow[] {
  const k = opts.k ?? 8
  if (!opts.catalog) return []
  let hits: Array<{ table: { qualifiedName: string } }> = []
  try {
    hits = opts.catalog.search(opts.goal, k)
  } catch {
    return []
  }
  if (hits.length === 0) return []
  const qnames = hits.map(h => h.table.qualifiedName)
  let verdicts: ReturnType<typeof listTableVerdicts> = []
  try {
    verdicts = listTableVerdicts({
      qnames,
      connection: opts.connection,
      upn: opts.upn ?? null,
    })
  } catch {
    return []
  }
  // Preserve catalog rank order.
  const byQname = new Map<string, typeof verdicts[number]>()
  for (const v of verdicts) byQname.set(v.qname.toLowerCase(), v)
  const out: CandidateVerdictRow[] = []
  for (const q of qnames) {
    const v = byQname.get(q.toLowerCase())
    if (!v) continue
    out.push({ qname: v.qname, role: v.role, evidence: v.evidence })
  }
  return out
}

