import { getDb } from "../db.js"
import { broadcast } from "../event-broadcaster.js"
import { searchProcedures } from "./procedural.js"
import { rowToEntry } from "./schema.js"
import {
    activationBonus, confidenceDecay,
    DEDUP_JACCARD_THRESHOLD,
    DEFAULT_BUDGET,
    jaccardSimilarity, RECENCY_WEIGHT,
    recencyScore,
    RELEVANCE_THRESHOLD, sanitizeFtsQuery,
    SOURCE_WEIGHT, TIER_BUDGET, tokenize, WORKING_SESSION_WINDOW_H,
} from "./scoring.js"
import type { MemoryBudget, MemoryEntry, MemoryTier, ProceduralMemory, UnifiedSearchResult } from "./types.js"
import { vectorSearch } from "./vectors.js"

// ── Unified Retrieval Pipeline ───────────────────────────────────

/**
 * Retrieve context for a goal — single unified pipeline.
 *
 * Blends working memory (recent turns), episodic (summaries),
 * and semantic (long-lived knowledge) through one ranked list.
 *
 * Scoring: combined = relevance * (1 - w) + recency * w
 * Recent turns always win because recency ~ 1.0.
 */
export async function retrieveContext(
  goal: string,
  opts?: {
    sessionId?: string
    runId?: string
    budget?: MemoryBudget
    /**
     * Owner UPN — scopes ALL tiers (working/episodic/semantic) to this user
     * plus any rows explicitly marked shared=true. Pass null/undefined for
     * unauthenticated callers; those see only legacy/global rows.
     */
    upn?: string | null
  },
): Promise<{
  context: string
  results: UnifiedSearchResult[]
  perTier: { working: string; episodic: string; semantic: string }
}> {
  const budget = opts?.budget ?? DEFAULT_BUDGET
  const now = new Date()
  const allResults: UnifiedSearchResult[] = []

  // Search each tier with its budget weight
  for (const tier of ["working", "episodic", "semantic"] as MemoryTier[]) {
    const tierBudget: MemoryBudget = {
      maxTokens: Math.floor(budget.maxTokens * TIER_BUDGET[tier]),
      maxItems: Math.floor(budget.maxItems * TIER_BUDGET[tier]),
    }

    const results = await searchEntries(goal, {
      tier,
      budget: tierBudget,
      sessionId: tier === "working" ? opts?.sessionId : undefined,
      excludeRunId: opts?.runId,
      upn: opts?.upn ?? null,
    })
    allResults.push(...results)
  }

  // Also search procedural memories (kept for activation tracking, not injected into prompt)
  const procedures = searchProcedures(goal, 3, opts?.upn ?? null, opts?.sessionId)

  // Sort all results by combined score descending
  allResults.sort((a, b) => b.combined - a.combined)

  // Cross-tier deduplication: if the same content got promoted from
  // working → episodic → semantic, only keep the highest-scoring copy.
  const deduped: UnifiedSearchResult[] = []
  const seenContent = new Map<string, number>()
  for (const r of allResults) {
    if (r.combined < RELEVANCE_THRESHOLD) continue

    const tokens = tokenize(r.entry.content)
    let isDup = false
    for (const [hash] of seenContent) {
      if (jaccardSimilarity(tokens, tokenize(hash)) >= DEDUP_JACCARD_THRESHOLD) {
        isDup = true
        break
      }
    }
    if (!isDup) {
      seenContent.set(r.entry.content, deduped.length)
      deduped.push(r)
    }
  }

  // Pack within total token budget
  const packed: UnifiedSearchResult[] = []
  let tokenCount = 0
  for (const r of deduped) {
    const approxTokens = Math.ceil(r.entry.content.length / 4)
    if (tokenCount + approxTokens > budget.maxTokens) break
    if (packed.length >= budget.maxItems) break
    tokenCount += approxTokens
    packed.push(r)
  }

  // Bump access counts
  if (packed.length > 0) {
    const ids = packed.map((r) => r.entry.id)
    const placeholders = ids.map(() => "?").join(", ")
    getDb().prepare(
      `UPDATE memory_entries SET access_count = access_count + 1, updated_at = ? WHERE id IN (${placeholders})`
    ).run(now.toISOString(), ...ids)
  }

  const context = formatMemoryContext(packed, procedures)

  const workingItems = packed.filter((r) => r.entry.tier === "working")
  const episodicItems = packed.filter((r) => r.entry.tier === "episodic")
  const semanticItems = packed.filter((r) => r.entry.tier === "semantic")

  const perTier = {
    working: workingItems.length > 0
      ? workingItems.map((r) => r.entry.content).join("\n")
      : "",
    episodic: episodicItems.length > 0
      ? episodicItems.map((r) => r.entry.content).join("\n")
      : "",
    semantic: semanticItems.length > 0
      ? semanticItems.map((r) => r.entry.content).join("\n")
      : "",
  }

  broadcast({
    type: "memory.retrieved",
    data: {
      total: packed.length,
      working: workingItems.length,
      episodic: episodicItems.length,
      semantic: semanticItems.length,
      procedural: procedures.length,
      runId: opts?.runId ?? null,
    },
  })

  return { context, results: packed, perTier }
}

/**
 * Search memory entries with hybrid FTS5 + vector relevance scoring.
 * When Ollama embeddings are available, blends keyword (FTS5 BM25) and
 * semantic (cosine similarity) results for true hybrid search.
 */
export async function searchEntries(
  query: string,
  opts: {
    tier?: MemoryTier
    budget: MemoryBudget
    sessionId?: string
    excludeRunId?: string
    /**
     * Owner UPN. Filters ALL tiers (not just working) so user A's distilled
     * knowledge cannot be injected into user B's prompt. Pass null to query
     * the legacy/unowned pool only. Rows with shared=1 are always visible.
     */
    upn?: string | null
  },
): Promise<UnifiedSearchResult[]> {
  const now = new Date()

  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) {
    if (opts.tier === "working") {
      return getRecentEntries(opts.tier, opts.budget.maxItems, opts.sessionId, opts.upn)
    }
    return []
  }

  let sql = `
    SELECT e.*, memory_entries_fts.rank AS fts_rank
    FROM memory_entries e
    JOIN memory_entries_fts ON e.rowid = memory_entries_fts.rowid
    WHERE memory_entries_fts MATCH ?
  `
  const params: unknown[] = [ftsQuery]

  if (opts.tier) {
    sql += " AND e.tier = ?"
    params.push(opts.tier)
  }
  if (opts.excludeRunId) {
    sql += " AND (e.run_id IS NULL OR e.run_id != ?)"
    params.push(opts.excludeRunId)
  }
  if (opts.sessionId && opts.tier === "working") {
    sql += " AND e.session_id = ?"
    params.push(opts.sessionId)
  }
  // Tenant isolation: every tier must be scoped to the calling user, with
  // shared=1 rows visible to everyone (admin-curated knowledge). The legacy
  // pool (upn IS NULL on both sides) stays self-contained for back-compat.
  if (opts.upn !== undefined) {
    if (opts.upn === null) {
      sql += " AND (e.upn IS NULL OR e.shared = 1)"
      // Temporary anonymous isolation: episodic memory is private per sid
      // until the proxy rollout guarantees a real UPN for every session.
      if (opts.tier === "episodic") {
        if (opts.sessionId) {
          sql += " AND (e.shared = 1 OR e.session_id = ?)"
          params.push(opts.sessionId)
        } else {
          sql += " AND e.shared = 1"
        }
      } else if (!opts.tier) {
        if (opts.sessionId) {
          sql += " AND (e.tier != 'episodic' OR e.shared = 1 OR e.session_id = ?)"
          params.push(opts.sessionId)
        } else {
          sql += " AND (e.tier != 'episodic' OR e.shared = 1)"
        }
      }
    } else {
      sql += " AND (e.upn = ? OR e.shared = 1)"
      params.push(opts.upn)
    }
  }
  if (opts.tier === "working") {
    // Hard cutoff: working memory only surfaces entries from the active session window.
    // This prevents stale answers from previous sessions bleeding into a fresh run.
    // The RECENCY_HALF_LIFE decay alone is not sufficient — entries with accessCount > 0
    // get an ACT-R activation bonus that keeps them alive across session boundaries.
    const windowCutoff = new Date(Date.now() - WORKING_SESSION_WINDOW_H * 60 * 60 * 1000).toISOString()
    sql += " AND e.created_at > ?"
    params.push(windowCutoff)
  }

  sql += " ORDER BY fts_rank LIMIT ?"
  params.push(opts.budget.maxItems * 3)

  const rows = getDb().prepare(sql).all(...params) as Array<
    Record<string, unknown> & { fts_rank: number }
  >

  // For working tier, also get recent entries that may not match FTS
  let recentEntries: UnifiedSearchResult[] = []
  if (opts.tier === "working") {
    recentEntries = getRecentEntries("working", 12, opts.sessionId, opts.upn)
  }

  const ftsResults: UnifiedSearchResult[] = rows.map((row) => {
    const entry = rowToEntry(row)
    const rawRank = Math.abs(row.fts_rank)
    // Down-weight failed/incomplete entries so they don't poison future runs.
    const isFailedEntry =
      entry.confidence < 0.5 &&
      (entry.tier === "episodic" || (entry.tier === "working" && entry.role === "assistant"))
    const statusPenalty = isFailedEntry ? 0.4 : 1.0
    const normRelevance = Math.min(1, rawRank * SOURCE_WEIGHT[entry.source] * entry.confidence * statusPenalty)
    const rec = recencyScore(entry.createdAt, now)
    const decay = confidenceDecay(entry.createdAt, now)
    const activation = activationBonus(entry.accessCount, entry.updatedAt, now)
    const relevance = normRelevance * decay * activation
    const combined = relevance * (1 - RECENCY_WEIGHT) + rec * RECENCY_WEIGHT

    return { entry, relevance, recency: rec, combined }
  })

  // ── Vector search: blend semantic matches when embeddings exist ──
  // Push the tenant filter into the SQL JOIN (vectors.ts) so a chatty tenant
  // cannot dominate the cosine top-K and starve other tenants of recall. The
  // post-filter below remains as defence-in-depth in case a vector row's
  // mirrored upn drifted from its memory_entries source of truth.
  const vecResults = await vectorSearch(query, opts.budget.maxItems * 2, opts.tier, opts.upn, opts.sessionId)
  if (vecResults.length > 0) {
    const ftsIds = new Set(ftsResults.map((r) => r.entry.id))
    for (const vr of vecResults) {
      if (ftsIds.has(vr.entryId)) continue
      if (vr.similarity < 0.5) continue

      const row = getDb().prepare("SELECT * FROM memory_entries WHERE id = ?").get(vr.entryId) as Record<string, unknown> | undefined
      if (!row) continue
      if (opts.excludeRunId && row.run_id === opts.excludeRunId) continue
      if (opts.sessionId && opts.tier === "working" && row.session_id !== opts.sessionId) continue
      // Tenant guard — vector hits must obey the same upn filter as FTS hits.
      // The vector index does not store upn (defence-in-depth: rely on the
      // memory_entries join as the single source of truth).
      if (opts.upn !== undefined) {
        const rowUpn = (row.upn as string | null) ?? null
        const rowShared = (row.shared as number | null) === 1
        if (!rowShared) {
          if (opts.upn === null && rowUpn !== null) continue
          if (opts.upn !== null && rowUpn !== opts.upn) continue
        }
      }
      if (opts.upn === null && ((row.tier as string | null) === "episodic")) {
        if (!opts.sessionId && (row.shared as number | null) !== 1) continue
        if (opts.sessionId && (row.shared as number | null) !== 1 && row.session_id !== opts.sessionId) continue
      }

      const entry = rowToEntry(row)
      const rec = recencyScore(entry.createdAt, now)
      const decay = confidenceDecay(entry.createdAt, now)
      const activation = activationBonus(entry.accessCount, entry.updatedAt, now)
      const relevance = vr.similarity * SOURCE_WEIGHT[entry.source] * decay * activation
      const combined = relevance * (1 - RECENCY_WEIGHT) + rec * RECENCY_WEIGHT

      ftsResults.push({ entry, relevance, recency: rec, combined })
      ftsIds.add(vr.entryId)
    }
  }

  // Merge with recent entries, deduplicate by ID
  const seen = new Set(ftsResults.map((r) => r.entry.id))
  for (const r of recentEntries) {
    if (!seen.has(r.entry.id)) {
      ftsResults.push(r)
      seen.add(r.entry.id)
    }
  }

  ftsResults.sort((a, b) => b.combined - a.combined)

  const packed: UnifiedSearchResult[] = []
  let tokenCount = 0
  for (const r of ftsResults) {
    const approxTokens = Math.ceil(r.entry.content.length / 4)
    if (tokenCount + approxTokens > opts.budget.maxTokens) break
    if (packed.length >= opts.budget.maxItems) break
    tokenCount += approxTokens
    packed.push(r)
  }

  return packed
}

function getRecentEntries(
  tier: MemoryTier,
  limit: number,
  sessionId?: string,
  upn?: string | null,
): UnifiedSearchResult[] {
  const now = new Date()
  let sql = "SELECT * FROM memory_entries WHERE tier = ?"
  const params: unknown[] = [tier]

  if (sessionId) {
    sql += " AND session_id = ?"
    params.push(sessionId)
  }
  if (upn !== undefined) {
    if (upn === null) {
      sql += " AND (upn IS NULL OR shared = 1)"
    } else {
      sql += " AND (upn = ? OR shared = 1)"
      params.push(upn)
    }
  }
  if (tier === "working") {
    const windowCutoff = new Date(Date.now() - WORKING_SESSION_WINDOW_H * 60 * 60 * 1000).toISOString()
    sql += " AND created_at > ?"
    params.push(windowCutoff)
  }

  sql += " ORDER BY created_at DESC LIMIT ?"
  params.push(limit)

  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>

  return rows.map((row) => {
    const entry = rowToEntry(row)
    const rec = recencyScore(entry.createdAt, now)
    return {
      entry,
      relevance: entry.confidence * activationBonus(entry.accessCount, entry.updatedAt, now),
      recency: rec,
      combined: entry.confidence * 0.3 + rec * 0.7,
    }
  })
}

// ── Output formatting ────────────────────────────────────────────

function formatMemoryContext(
  results: UnifiedSearchResult[],
  _procedures: ProceduralMemory[],
): string {
  if (results.length === 0) return ""

  const blocks: string[] = []

  const working = results.filter((r) => r.entry.tier === "working")
  const episodic = results.filter((r) => r.entry.tier === "episodic")
  const semantic = results.filter((r) => r.entry.tier === "semantic")

  if (working.length > 0) {
    blocks.push("<working_memory>")
    for (const r of working) blocks.push(r.entry.content)
    blocks.push("</working_memory>")
  }

  if (episodic.length > 0) {
    blocks.push("<episodic_memory>")
    for (const r of episodic) blocks.push(r.entry.content)
    blocks.push("</episodic_memory>")
  }

  if (semantic.length > 0) {
    blocks.push("<semantic_memory>")
    for (const r of semantic) blocks.push(r.entry.content)
    blocks.push("</semantic_memory>")
  }

  // Note: procedural memories (tool sequences) are intentionally excluded.
  // They consume tokens without improving LLM tool selection.

  return [
    "",
    "<memory_context>",
    ...blocks,
    "</memory_context>",
    "",
  ].join("\n")
}

// Re-export MemoryEntry so consumers of retrieval don't need a separate import
export type { MemoryEntry }
