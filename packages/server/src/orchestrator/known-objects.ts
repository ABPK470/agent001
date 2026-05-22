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
 */
export function loadKnownObjects(opts: LoadKnownObjectsOptions): KnownObjectRow[] {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const candidates = new Set<string>()
  for (const q of extractQnames(opts.goal)) candidates.add(q)
  for (const t of opts.priorTurns) {
    for (const q of extractQnames(t.goal)) candidates.add(q)
    if (t.answer) for (const q of extractQnames(t.answer)) candidates.add(q)
  }
  if (candidates.size === 0) return []

  const placeholders = [...candidates].map(() => "?").join(",")
  const sql = `
    SELECT qname, tool, mode, bytes, created_at
    FROM tool_knowledge
    WHERE qname IN (${placeholders})
    ORDER BY created_at DESC
    LIMIT ?
  `
  const db = opts.db ?? getDb()
  type Row = { qname: string; tool: string; mode: string; bytes: number; created_at: number }
  const rows = db.prepare(sql).all(...candidates, limit) as Row[]
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
 */
export function renderKnownObjectsBlock(rows: readonly KnownObjectRow[]): string {
  if (rows.length === 0) return ""
  const lines: string[] = [
    "<known_objects>",
    "These tables/views have already been profiled or inspected by this org",
    "and the results are cached in tool_knowledge. Before running",
    "`profile_data`, `inspect_definition`, or `discover_relationships` on",
    "any of them, just call the tool normally \u2014 a fresh cached payload",
    "will be returned automatically with a `[cached from \u2026]` header (no",
    "MSSQL round trip). The list is qname-deduped, newest first.",
    "",
    "qname | tool | mode | ageHours | bytes",
  ]
  let total = lines.join("\n").length
  for (const r of rows) {
    const line = `${r.qname} | ${r.tool} | ${r.mode} | ${r.ageHours}h | ${r.bytes}B`
    if (total + line.length + 1 + "</known_objects>".length + 1 > MAX_CHARS) break
    lines.push(line)
    total += line.length + 1
  }
  lines.push("</known_objects>")
  return lines.join("\n")
}
