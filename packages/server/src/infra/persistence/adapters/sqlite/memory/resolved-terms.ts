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

import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runChangesAsync, runExecAsync } from "../../../schema/execute-async.js"
import { upsertRowAsync } from "../../../schema/upsert.js"

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
export async function saveResolvedTerm(input: ResolvedTermInput): Promise<void> {
  const term = input.term.trim().toLowerCase()
  const qname = input.qname.trim()
  if (!term || !qname) return
  const connection = (input.connection ?? "default").trim().toLowerCase() || "default"
  const now = input.now ?? Date.now()

  await upsertRowAsync({
    table: "resolved_terms_cache",
    keys: { term, qname, connection },
    insert: {
      term,
      qname,
      connection,
      created_by_upn: input.upn ?? null,
      created_at: now,
      last_hit_at: null,
      hit_count: 0
    },
    update: { created_by_upn: input.upn ?? null, created_at: now, last_hit_at: null, hit_count: 0 }
  })
}

/**
 * Return the NEWEST mapping per term for the given connection, newest-first.
 * At most one row per term (the latest answer wins). The caller (law-sections)
 * further filters to mappings whose qname resolves in the live catalog, so a
 * mapping whose table has since been dropped never suppresses a clarification.
 */
export async function listResolvedTerms(options: ListResolvedTermsOptions = {}): Promise<ResolvedTerm[]> {
  const connection = (options.connection ?? "default").trim().toLowerCase() || "default"
  const now = options.now ?? Date.now()

  const rows = await runAllAsync<Row>(
    getPlatformDb()
      .selectFrom("resolved_terms_cache")
      .select(["term", "qname", "connection", "created_by_upn", "created_at", "last_hit_at", "hit_count"])
      .where("connection", "=", connection)
      .orderBy("created_at", "desc")
      .compile()
  )

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
    for (const r of out) {
      await runExecAsync(
        getPlatformDb()
          .updateTable("resolved_terms_cache")
          .set({ last_hit_at: now, hit_count: (eb) => eb("hit_count", "+", 1) })
          .where("term", "=", r.term)
          .where("connection", "=", connection)
          .where("created_at", "=", r.createdAt)
          .compile()
      )
    }
  } catch (err: unknown) {
    console.error("[mia]", err)
  }

  return out
}

export interface PruneResolvedTermsOptions {
  /** Drop rows older than this age (ms). */
  maxAgeMs: number
  now?: number
}

/** Drop mappings older than `maxAgeMs`. Returns the number of rows removed. */
export async function pruneResolvedTerms(opts: PruneResolvedTermsOptions): Promise<number> {
  const now = opts.now ?? Date.now()
  const cutoff = now - opts.maxAgeMs
  return await runChangesAsync(
    getPlatformDb().deleteFrom("resolved_terms_cache").where("created_at", "<", cutoff).compile()
  )
}
