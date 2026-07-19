/**
 * resolved_terms_cache — durable, org-wide store of business-term → warehouse-object
 * mappings learned from clarification answers.
 *
 * When a user answers a `schema-match` / `canonical-ambiguity` question with a
 * qualified table name (e.g. "clients" → "dim.Client"), the orchestrator persists
 * the mapping here. At run start `law-sections` loads the mappings for the active
 * connection and feeds them into the clarify context as `learnedTermMappings`,
 * which `entity-canonical` consults to suppress re-asking the same subject.
 *
 * Org-wide by design (not upn-filtered on read): "clients = dim.Client" is an
 * objective property of the shared warehouse, mirroring `tool_knowledge_cache`.
 * `created_by_upn` is provenance only. Connection-scoped so multi-DB tenants
 * don't cross-pollute.
 *
 * @module
 */

import { getDb } from "../sqlite.js"

export interface ResolvedTermInput {
  /** Lowercase business noun the user was asked about ("clients"). */
  term: string
  /** Canonical qualified table the user chose ("dim.Client"). Case preserved. */
  qname: string
  /** Logical MSSQL connection. Defaults to "default". */
  connection?: string
  /** UPN of the user who answered (provenance only). */
  upn?: string | null
  /** Caller's clock (ms). Defaults to Date.now(). Useful for tests. */
  now?: number
}

export interface ResolvedTerm {
  term: string
  qname: string
  connection: string
  createdByUpn: string | null
  createdAt: number
  lastHitAt: number | null
  hitCount: number
}

export interface ListResolvedTermsOptions {
  /** Logical connection to scope to. Defaults to "default". */
  connection?: string
  /** Caller's clock (ms). Defaults to Date.now(). Useful for tests. */
  now?: number
}

interface Row {
  term: string
  qname: string
  connection: string
  created_by_upn: string | null
  created_at: number
  last_hit_at: number | null
  hit_count: number
}

/**
 * Upsert a learned term→table mapping. A later answer for the same
 * (term, qname, connection) refreshes provenance + timestamp; a different
 * qname for the same (term, connection) adds a new row so both coexist
 * (the newest per term wins at read time — see `listResolvedTerms`).
 */
export function saveResolvedTerm(input: ResolvedTermInput): void {
  const term = input.term.trim().toLowerCase()
  const qname = input.qname.trim()
  if (!term || !qname) return
  const connection = (input.connection ?? "default").trim() || "default"
  const now = input.now ?? Date.now()

  getDb()
    .prepare(
      `INSERT INTO resolved_terms_cache (term, qname, connection, created_by_upn, created_at, hit_count)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(term, qname, connection) DO UPDATE SET
         created_by_upn = excluded.created_by_upn,
         created_at     = excluded.created_at,
         hit_count      = 0,
         last_hit_at    = NULL`
    )
    .run(term, qname, connection, input.upn ?? null, now)
}

/**
 * Return the NEWEST mapping per term for the given connection, newest-first.
 * At most one row per term (the latest answer wins). The caller (law-sections)
 * further filters to mappings whose qname resolves in the live catalog, so a
 * mapping whose table has since been dropped never suppresses a clarification.
 */
export function listResolvedTerms(options: ListResolvedTermsOptions = {}): ResolvedTerm[] {
  const connection = (options.connection ?? "default").trim() || "default"
  const now = options.now ?? Date.now()

  const rows = getDb()
    .prepare<unknown[], Row>(
      `SELECT term, qname, connection, created_by_upn, created_at, last_hit_at, hit_count
         FROM resolved_terms_cache
        WHERE lower(connection) = lower(?)
        ORDER BY created_at DESC`
    )
    .all(connection)

  const seen = new Set<string>()
  const out: ResolvedTerm[] = []
  for (const row of rows) {
    const key = row.term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      term: row.term,
      qname: row.qname,
      connection: row.connection,
      createdByUpn: row.created_by_upn,
      createdAt: row.created_at,
      lastHitAt: row.last_hit_at,
      hitCount: row.hit_count
    })
  }

  // Bump hit telemetry for the rows we surfaced. Fire-and-forget; non-fatal.
  try {
    const bump = getDb().prepare(
      `UPDATE resolved_terms_cache
          SET last_hit_at = ?, hit_count = hit_count + 1
        WHERE term = ? AND lower(connection) = lower(?) AND created_at = ?`
    )
    for (const r of out) bump.run(now, r.term, connection, r.createdAt)
  } catch {
    /* non-fatal */
  }

  return out
}

export interface PruneResolvedTermsOptions {
  /** Drop rows older than this age (ms). */
  maxAgeMs: number
  now?: number
}

/** Drop mappings older than `maxAgeMs`. Returns the number of rows removed. */
export function pruneResolvedTerms(opts: PruneResolvedTermsOptions): number {
  const now = opts.now ?? Date.now()
  const cutoff = now - opts.maxAgeMs
  const info = getDb().prepare(`DELETE FROM resolved_terms_cache WHERE created_at < ?`).run(cutoff)
  return typeof info.changes === "number" ? info.changes : 0
}
