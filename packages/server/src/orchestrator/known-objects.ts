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
import { listTableVerdicts, type TableVerdictRole } from "../adapters/persistence/memory.js"
import { getDb } from "../adapters/persistence/sqlite.js"
import { summarizeCachedPayload } from "../memory/tool-knowledge-summarizer.js"
import type { CachedTool } from "../memory/tool-knowledge.js"
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
  /**
   * `"goal"` when the qname was extracted from the goal text or a
   * prior-turn message (we render an inline cached-payload summary
   * for these — they're what the user is actually asking about).
   * `"fallback"` when the row came from the Gap-3 globally-freshest
   * top-up (one-line directory entry only — speculative).
   */
  priority: "goal" | "fallback"
  /**
   * Compact summary of the cached `payload_text` (column list,
   * profile highlights, etc.). Populated only for `priority="goal"`
   * rows — full-summarizing every fallback row could blow the
   * block's char budget. Empty string when summarization wasn't
   * attempted or the payload was empty.
   */
  summary: string
}

const DEFAULT_LIMIT = 8
const MAX_CHARS = 4000

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
  type Row = { qname: string; tool: string; mode: string; bytes: number; created_at: number; payload_text: string }

  let rows: Row[] = []
  if (candidates.size > 0) {
    const placeholders = [...candidates].map(() => "?").join(",")
    rows = db.prepare(`
      SELECT qname, tool, mode, bytes, created_at, payload_text
      FROM tool_knowledge
      WHERE qname IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...candidates, limit) as Row[]
  }

  // Track which rows came from the goal-mention path vs the fallback
  // top-up: only goal rows get the heavy summarizer treatment so the
  // block budget stays bounded.
  const goalQnames = new Set(rows.map(r => r.qname))

  // Gap 3 fallback / top-up: append the globally-freshest rows so the
  // block is non-empty when the goal text doesn't name objects, and so
  // repeatedly-used objects show up even when the goal pivots topic
  // (e.g. revenue → clients still using publish.Revenue under the hood).
  // Cap the top-up so the block stays small. Fallback rows do NOT get
  // payload summaries — they're directory-only.
  const FALLBACK_TOPUP = Math.max(1, Math.min(5, limit - rows.length))
  if (FALLBACK_TOPUP > 0) {
    const seenQnames = new Set(rows.map(r => r.qname))
    const extra = db.prepare(`
      SELECT qname, tool, mode, bytes, created_at, payload_text
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
    const isGoal = goalQnames.has(r.qname)
    const summary = isGoal
      ? summarizeCachedPayload(r.tool as CachedTool, r.mode, r.payload_text)
      : ""
    out.push({
      qname: r.qname,
      tool: r.tool,
      mode: r.mode,
      ageHours: Math.round((now - r.created_at) / 3_600_000),
      bytes: r.bytes,
      priority: isGoal ? "goal" : "fallback",
      summary,
    })
  }
  return out
}

/**
 * Render the `<known_objects>` block. Returns "" when there's nothing to
 * surface so the caller can skip injection cleanly.
 *
 * Layout (priority-aware so the budget always favours the highest-signal
 * content):
 *
 *   <known_objects>
 *     <intro / trust note>
 *
 *     <goal qnames as multi-line entries with inline cached payload
 *      summary \u2014 model treats these as authoritative>
 *
 *     <fallback qnames as one-liner directory entries \u2014 model knows
 *      they exist and can call the tool to get a cached payload>
 *
 *     <verdicts sub-section \u2014 durable role classifications>
 *   </known_objects>
 *
 * Eviction order when MAX_CHARS is hit: verdicts drop first, then
 * fallback rows, then goal-summary tails. Goal-row headers are always
 * preserved \u2014 if they don't fit, we wouldn't be rendering the block at
 * all.
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

  const goalRows     = rows.filter((r) => r.priority === "goal")
  const fallbackRows = rows.filter((r) => r.priority !== "goal")

  const CLOSE = "</known_objects>"
  const lines: string[] = ["<known_objects>"]

  if (rows.length > 0) {
    lines.push(
      "These tables/views have already been profiled or inspected by this org",
      "and the results are cached in tool_knowledge. For qnames listed below",
      "with an inline `cols:` / `fast:` / `definition:` / `rels:` summary,",
      "treat that summary as AUTHORITATIVE \u2014 do NOT re-call `profile_data`,",
      "`inspect_definition`, `explore_mssql_schema`, or `discover_relationships`",
      "on that qname unless the user explicitly needs fresher or deeper data.",
      "Directory-only entries (qname | tool | mode | age | bytes) mean the",
      "cache exists but wasn't summarized here \u2014 calling the tool will return",
      "the cached payload automatically with a `[cached from \u2026]` header.",
    )
  }

  // Helper: try to append a line; returns false if it would overflow.
  let total = lines.join("\n").length
  const tryPush = (line: string): boolean => {
    if (total + line.length + 1 + CLOSE.length + 1 > MAX_CHARS) return false
    lines.push(line)
    total += line.length + 1
    return true
  }

  // 1. Goal rows \u2014 always rendered first. Header always; summary best-effort.
  for (const r of goalRows) {
    tryPush("")
    const header = `${r.qname} [${r.tool}/${r.mode}, ${r.ageHours}h ago, ${r.bytes}B]`
    if (!tryPush(header)) break
    if (r.summary) {
      // Indent the summary so it visually belongs to the header above.
      // Wrap to ~110 chars so a wide column list doesn't make one giant
      // unreadable line.
      for (const segment of wrapForPrompt(r.summary, 110)) {
        if (!tryPush(`  ${segment}`)) break
      }
    }
  }

  // 2. Fallback directory \u2014 only if there's space and we have any.
  if (fallbackRows.length > 0) {
    tryPush("")
    tryPush("Directory (cache exists, summary not inlined):")
    tryPush("qname | tool | mode | ageHours | bytes")
    for (const r of fallbackRows) {
      const line = `${r.qname} | ${r.tool} | ${r.mode} | ${r.ageHours}h | ${r.bytes}B`
      if (!tryPush(line)) break
    }
  }

  // 3. Verdicts sub-section \u2014 evicted first when budget is tight.
  if (verdicts.length > 0) {
    const header = [
      "",
      "DURABLE TABLE VERDICTS \u2014 role classifications learned from prior runs.",
      "Prefer 'canonical' objects; treat 'subset' / 'rules' as scoped derivatives;",
      "avoid 'staging' / 'archive' unless explicitly requested.",
      "",
      "qname | role | evidence",
    ]
    for (const h of header) {
      if (!tryPush(h)) break
    }
    for (const v of verdicts) {
      const ev = v.evidence.length > 0 ? v.evidence.join("; ") : "\u2014"
      const line = `${v.qname} | ${v.role} | ${ev}`
      if (!tryPush(line)) break
    }
  }

  lines.push(CLOSE)
  return lines.join("\n")
}

/**
 * Soft-wrap a comma-separated summary so single-line column lists don't
 * blow past `cols` chars. Splits at ", " boundaries; if a fragment is
 * already longer than `cols` we let it through unbroken (one-off case).
 */
function wrapForPrompt(text: string, cols: number): string[] {
  if (text.length <= cols) return [text]
  const out: string[] = []
  const parts = text.split(", ")
  let current = ""
  for (const part of parts) {
    const next = current ? `${current}, ${part}` : part
    if (next.length > cols && current) {
      out.push(current + ",")
      current = part
    } else {
      current = next
    }
  }
  if (current) out.push(current)
  return out
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

