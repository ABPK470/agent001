import { EventType, getCatalogSchemaFingerprint } from "@mia/agent"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { platformNow } from "../../../schema/sql-time.js"
import { getMemorySearchPort } from "../../../memory/search-port.js"
import { MemoryRole, MemoryTier } from "../../../../../internal/enums/memory.js"
import { broadcast } from "../../../../events/broadcaster.js"
import { pickEpisodicChoreographyHint } from "./episodic-choreography.js"
import { augmentGoalQueryForFts, episodicShortcutMatchesGoal } from "./goal-class.js"
import { currentPolicyVersion, provenanceMultiplier } from "./provenance.js"
import { rowToEntry } from "./schema.js"
import {
  activationBonus,
  confidenceDecay,
  DEDUP_JACCARD_THRESHOLD,
  DEFAULT_BUDGET,
  jaccardSimilarity,
  RECENCY_WEIGHT,
  recencyScore,
  RELEVANCE_THRESHOLD,
  sanitizeFtsQuery,
  SOURCE_WEIGHT,
  TIER_BUDGET,
  tokenize,
  vectorAugmentationMatchesQuery,
  WORKING_SESSION_WINDOW_H
} from "./scoring.js"
import type { MemoryBudget, MemoryEntry, UnifiedSearchResult } from "./types.js"
import { EMPTY_MEMORY_PER_TIER, type MemoryPerTier } from "./tier-context.js"
import { readEpisodicShortcutEligible } from "./episodic-quality.js"
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
    /** Working-tier scope — must match the run's thread (see continuity.ts). */
    threadId?: string
    runId?: string
    budget?: MemoryBudget
    /** Owner UPN — required for agent runs; scopes all tiers to this user (+ shared rows). */
    upn?: string
    /** Optional host — used to read the live catalog schema fingerprint. */
    host?: import("@mia/agent").AgentHost
  }
): Promise<{
  context: string
  results: UnifiedSearchResult[]
  perTier: MemoryPerTier
}> {
  const ownerUpn = opts?.upn?.trim()
  if (!ownerUpn) {
    return {
      context: "",
      results: [],
      perTier: { ...EMPTY_MEMORY_PER_TIER }
    }
  }

  const budget = opts?.budget ?? DEFAULT_BUDGET
  const now = new Date()
  const allResults: UnifiedSearchResult[] = []

  // Search each tier with its budget weight
  for (const tier of [MemoryTier.Working, "episodic", "semantic"] as MemoryTier[]) {
    const tierBudget: MemoryBudget = {
      maxTokens: Math.floor(budget.maxTokens * TIER_BUDGET[tier]),
      maxItems: Math.floor(budget.maxItems * TIER_BUDGET[tier])
    }

    const searchQuery = tier === "episodic" ? augmentGoalQueryForFts(goal) : goal
    const results = await searchEntries(searchQuery, {
      tier,
      budget: tierBudget,
      threadId: tier === MemoryTier.Working ? opts?.threadId : undefined,
      excludeRunId: opts?.runId,
      upn: ownerUpn
    })
    allResults.push(...results)
  }

  // Phase 5: demote (don't delete) entries whose provenance no longer
  // matches the current environment. A row stamped with a stale
  // doctrine policy version, an out-of-date schema fingerprint, or
  // simply too old, must not crowd out fresh, in-policy knowledge. The
  // multiplier is bounded above 0 so audit history is preserved.
  const policyVersion = currentPolicyVersion()
  const currentSchema =
    (opts as { schemaFingerprint?: string | null } | undefined)?.schemaFingerprint ??
    (opts?.host ? getCatalogSchemaFingerprint(opts.host) : null) ??
    null
  let demotedCount = 0
  for (const r of allResults) {
    const { multiplier, reasons } = provenanceMultiplier(
      r.entry.metadata,
      r.entry.createdAt,
      policyVersion,
      currentSchema,
      now
    )
    if (multiplier < 1) {
      r.combined *= multiplier
      demotedCount++
      // Tag the reason on the result so downstream tooling can surface it.
      ;(r as UnifiedSearchResult & { demoted?: { multiplier: number; reasons: string[] } }).demoted = {
        multiplier,
        reasons
      }
    }
  }
  if (demotedCount > 0) {
    broadcast({
      type: EventType.MemoryFiltered,
      data: {
        reason: "provenance_demoted",
        demotedCount,
        total: allResults.length,
        runId: opts?.runId ?? null
      } as Record<string, unknown>
    })
  }

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
    await runExecAsync(
      getPlatformDb()
        .updateTable("memory_entries")
        .set({
          access_count: (eb) => eb("access_count", "+", 1),
          updated_at: platformNow()
        })
        .where("id", "in", ids)
        .compile()
    )
  }

  const context = formatMemoryContext(packed)

  const workingItems = packed.filter((r) => r.entry.tier === MemoryTier.Working)
  const episodicItems = packed.filter((r) => r.entry.tier === "episodic")
  const semanticItems = packed.filter((r) => r.entry.tier === "semantic")

  const episodicShortcutEligible =
    episodicItems.some((r) => readEpisodicShortcutEligible(r.entry.metadata)) &&
    episodicShortcutMatchesGoal(
      goal,
      episodicItems.map((r) => ({ content: r.entry.content, metadata: r.entry.metadata }))
    )

  const perTier: MemoryPerTier = {
    working: workingItems.length > 0 ? workingItems.map((r) => r.entry.content).join("\n") : "",
    episodic: episodicItems.length > 0 ? episodicItems.map((r) => r.entry.content).join("\n") : "",
    semantic: semanticItems.length > 0 ? semanticItems.map((r) => r.entry.content).join("\n") : "",
    episodicShortcutEligible,
    episodicChoreography: episodicShortcutEligible
      ? pickEpisodicChoreographyHint(episodicItems)
      : undefined
  }

  broadcast({
    type: EventType.MemoryRetrieved,
    data: {
      total: packed.length,
      working: workingItems.length,
      episodic: episodicItems.length,
      semantic: semanticItems.length,
      runId: opts?.runId ?? null
    }
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
    threadId?: string
    excludeRunId?: string
    /**
     * Owner UPN. Filters ALL tiers (not just working) so user A's distilled
     * knowledge cannot be injected into user B's prompt. Pass null to query
     * the legacy/unowned pool only. Rows with shared=1 are always visible.
     */
    upn?: string | null
  }
): Promise<UnifiedSearchResult[]> {
  const now = new Date()

  if (opts.tier === MemoryTier.Working && (!opts.threadId || !opts.upn)) {
    return []
  }

  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) {
    if (opts.tier === MemoryTier.Working) {
      return await getRecentEntries(opts.tier, opts.budget.maxItems, opts.threadId, opts.upn, opts.excludeRunId)
    }
    return []
  }

  // Pass the raw query — each MemorySearchPort sanitizes for its dialect
  // (FTS5 quoting vs degraded token filter). Never feed pre-quoted FTS text
  // into the mssql degraded tokenizer.
  const hits = await getMemorySearchPort().searchKeyword(query, {
    tier: opts.tier,
    limit: opts.budget.maxItems * 3,
    threadId: opts.threadId,
    excludeRunId: opts.excludeRunId,
    upn: opts.upn,
    createdAfter:
      opts.tier === MemoryTier.Working
        ? new Date(Date.now() - WORKING_SESSION_WINDOW_H * 60 * 60 * 1000).toISOString()
        : undefined
  })

  // For working tier, also get recent entries that may not match FTS
  let recentEntries: UnifiedSearchResult[] = []
  if (opts.tier === MemoryTier.Working) {
    recentEntries = await getRecentEntries(MemoryTier.Working, 12, opts.threadId, opts.upn, opts.excludeRunId)
  }

  const ftsResults: UnifiedSearchResult[] = hits.map(({ entry, rank }) => {
    const rawRank = Math.abs(rank)
    // Down-weight failed/incomplete entries so they don't poison future runs.
    const isFailedEntry =
      entry.confidence < 0.5 &&
      (entry.tier === "episodic" ||
        (entry.tier === MemoryTier.Working && entry.role === MemoryRole.Assistant))
    const statusPenalty = isFailedEntry ? 0.4 : 1.0
    const normRelevance = Math.min(
      1,
      rawRank * SOURCE_WEIGHT[entry.source] * entry.confidence * statusPenalty
    )
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
  const vecResults = await vectorSearch(query, opts.budget.maxItems * 2, opts.tier, opts.upn, opts.threadId)
  if (vecResults.length > 0) {
    const ftsIds = new Set(ftsResults.map((r) => r.entry.id))
    for (const vr of vecResults) {
      if (ftsIds.has(vr.entryId)) continue
      if (vr.similarity < 0.5) continue

      const row = await runGetAsync<Record<string, unknown>>(
        getPlatformDb().selectFrom("memory_entries").selectAll().where("id", "=", vr.entryId).compile()
      )
      if (!row) continue
      if (opts.excludeRunId && row.run_id === opts.excludeRunId) continue
      if (
        opts.tier === MemoryTier.Working &&
        opts.threadId &&
        opts.upn &&
        row.run_id
      ) {
        const inThread = await runGetAsync<{ id: string }>(
          getPlatformDb()
            .selectFrom("runs")
            .select("id")
            .where("id", "=", row.run_id as string)
            .where("thread_id", "=", opts.threadId)
            .where("upn", "=", opts.upn)
            .limit(1)
            .compile()
        )
        if (!inThread) continue
      }
      if (opts.upn !== undefined) {
        const rowUpn = (row.upn as string | null) ?? null
        const rowShared = (row.shared as number | null) === 1
        if (!rowShared) {
          if (opts.upn === null && rowUpn !== null) continue
          if (opts.upn !== null && rowUpn !== opts.upn) continue
        }
      }

      const entry = rowToEntry(row)
      if (!vectorAugmentationMatchesQuery(query, entry.content)) continue
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

async function getRecentEntries(
  tier: MemoryTier,
  limit: number,
  threadId?: string,
  upn?: string | null,
  excludeRunId?: string
): Promise<UnifiedSearchResult[]> {
  const now = new Date()
  if (tier === MemoryTier.Working && (!threadId || !upn)) return []

  let query = getPlatformDb().selectFrom("memory_entries").selectAll().where("tier", "=", tier)
  if (tier === MemoryTier.Working && threadId && upn) {
    query = query.where(
      "run_id",
      "in",
      getPlatformDb().selectFrom("runs").select("id").where("thread_id", "=", threadId).where("upn", "=", upn)
    )
  }
  // Exclude the in-flight run's own rows so an agent cannot echo its own
  // mid-run state back at itself. Mirrors the FTS path predicate at
  // searchEntries() so excludeRunId is honoured uniformly across both
  // retrieval paths (FTS hit OR recency fallback / working-tier merge).
  // Without this, retrieval.ts:247 (working merge) and the empty-FTS
  // fallback at retrieval.ts:174 silently re-injected current-run rows
  // even when the caller asked them to be excluded — see Layer A A5b.
  if (excludeRunId) {
    query = query.where((eb) => eb.or([eb("run_id", "is", null), eb("run_id", "!=", excludeRunId)]))
  }
  if (upn !== undefined) {
    if (upn === null) {
      query = query.where((eb) => eb.or([eb("upn", "is", null), eb("shared", "=", 1)]))
    } else {
      query = query.where((eb) => eb.or([eb("upn", "=", upn), eb("shared", "=", 1)]))
    }
  }
  if (tier === MemoryTier.Working) {
    const windowCutoff = new Date(Date.now() - WORKING_SESSION_WINDOW_H * 60 * 60 * 1000).toISOString()
    query = query.where("created_at", ">", windowCutoff)
  }

  const rows = await runAllAsync<Record<string, unknown>>(
    query.orderBy("created_at", "desc").limit(limit).compile()
  )

  return rows.map((row) => {
    const entry = rowToEntry(row)
    const rec = recencyScore(entry.createdAt, now)
    return {
      entry,
      relevance: entry.confidence * activationBonus(entry.accessCount, entry.updatedAt, now),
      recency: rec,
      combined: entry.confidence * 0.3 + rec * 0.7
    }
  })
}

// ── Output formatting ────────────────────────────────────────────

function formatMemoryContext(results: UnifiedSearchResult[]): string {
  if (results.length === 0) return ""

  // Dedup identical or near-identical entry content across tiers (Gap 4).
  // The same run can be promoted into multiple tiers (working ← episodic ← semantic),
  // duplicating ~1-3KB of identical prose for every retrieval. Hash the
  // first 256 chars of normalized content as a cheap fingerprint.
  const seen = new Set<string>()
  const dedup = (rs: UnifiedSearchResult[]): UnifiedSearchResult[] => {
    const out: UnifiedSearchResult[] = []
    for (const r of rs) {
      const fp = (r.entry.content ?? "").trim().replace(/\s+/g, " ").slice(0, 256)
      if (fp.length === 0 || seen.has(fp)) continue
      seen.add(fp)
      out.push(r)
    }
    return out
  }

  const blocks: string[] = []

  const working = dedup(results.filter((r) => r.entry.tier === MemoryTier.Working))
  const episodic = dedup(results.filter((r) => r.entry.tier === "episodic"))
  const semantic = dedup(results.filter((r) => r.entry.tier === "semantic"))

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

  return ["", "<memory_context>", ...blocks, "</memory_context>", ""].join("\n")
}

// Re-export MemoryEntry so consumers of retrieval don't need a separate import
export type { MemoryEntry }
