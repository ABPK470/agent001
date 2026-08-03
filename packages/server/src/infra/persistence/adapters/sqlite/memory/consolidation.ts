import { EventType } from "@mia/agent"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runChangesAsync, runExecAsync } from "../../../schema/execute-async.js"
import { platformNow } from "../../../schema/sql-time.js"
import { MemoryRole, MemorySource, MemoryTier } from "../../../../../internal/enums/memory.js"
import { broadcast } from "../../../../events/broadcaster.js"
import { ingestTurn } from "./ingestion.js"
import { DEDUP_JACCARD_THRESHOLD, jaccardSimilarity, tokenize, truncateAtBoundary } from "./scoring.js"

// ── Consolidation pipeline (agenc-core pattern) ─────────────────
//
// Promotes repeated episodic/working patterns into long-lived semantic facts.
// Runs after each completed run (non-blocking) and as periodic background task.
//
// Pipeline:
//   1. Fetch recent episodic + old working entries past the lookback window
//   2. Agglomerative clustering by Jaccard token similarity (≥ 0.4)
//   3. Clusters with ≥ 2 entries → promotion candidates
//   4. Cross-tier dedup: check against existing semantic entries (Jaccard ≥ 0.86)
//   5. Promote with boosted confidence: 0.5 + clusterSize × 0.1 (capped at 0.95)
//   6. Soft-delete source entries (reduce confidence so they fade)

export async function consolidate(opts?: {
  minAgeHours?: number
  maxBatchSize?: number
  /**
   * Restrict consolidation to one tenant. When omitted, every distinct upn
   * (plus the legacy NULL-upn pool) is processed independently \u2014 candidates
   * from different tenants are NEVER clustered together, so a promoted
   * semantic fact always belongs to exactly one user.
   */
  upn?: string | null
}): Promise<{ promoted: number; pruned: number }> {
  const minAgeHours = opts?.minAgeHours ?? 24
  const maxBatchSize = opts?.maxBatchSize ?? 200
  const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000).toISOString()

  // Fetch candidates: episodic entries older than cutoff + old working entries.
  // Exclude role='summary' \u2014 these are canonical per-goal answer records (from ingestRunTurns).
  // They must NOT be clustered into semantic because:
  //   1. The content includes specific query results (client names, revenue figures)
  //      that change over time \u2014 merging two such entries produces a contradictory
  //      semantic "fact" with wrong answers from multiple different time periods.
  //   2. They are already deduplicated by the episodic upsert (one per goal) \u2014 there
  //      is no value in further consolidation.
  // Only working-tier tool-call/result turns (raw patterns) should be clustered.
  let candidateQuery = getPlatformDb().selectFrom("memory_entries").selectAll()
    .where((eb) => eb.or([
      eb("tier", "=", MemoryTier.Episodic),
      eb.and([eb("tier", "=", MemoryTier.Working), eb("created_at", "<", cutoff)])
    ]))
    .where("role", "!=", MemoryRole.Summary)
    .where("created_at", "<", cutoff)
  if (opts?.upn !== undefined) candidateQuery = candidateQuery.where("upn", opts.upn === null ? "is" : "=", opts.upn)
  const candidates = await runAllAsync<Record<string, unknown>>(candidateQuery.orderBy("created_at", "asc").limit(maxBatchSize).compile())

  if (candidates.length < 3) return { promoted: 0, pruned: 0 }

  // Partition by upn so clustering only happens within a tenant. A null upn
  // is its own partition (legacy/global) and never clusters with named users.
  const byTenant = new Map<string | null, Array<Record<string, unknown>>>()
  for (const row of candidates) {
    const key = (row.upn as string | null) ?? null
    const bucket = byTenant.get(key) ?? []
    bucket.push(row)
    byTenant.set(key, bucket)
  }

  let totalPromoted = 0
  let totalPruned = 0
  for (const [tenantUpn, tenantRows] of byTenant) {
    const r = await consolidateTenant(tenantUpn, tenantRows)
    totalPromoted += r.promoted
    totalPruned += r.pruned
  }

  // Prune very low confidence entries (cross-tenant; threshold-only)
  totalPruned += await runChangesAsync(
    getPlatformDb().deleteFrom("memory_entries").where("confidence", "<", 0.05).where("tier", "!=", MemoryTier.Semantic).compile()
  )

  if (totalPromoted > 0 || totalPruned > 0) {
    broadcast({
      type: EventType.MemoryConsolidated,
      data: { promoted: totalPromoted, pruned: totalPruned }
    })
  }

  return { promoted: totalPromoted, pruned: totalPruned }
}

async function consolidateTenant(
  tenantUpn: string | null,
  candidates: Array<Record<string, unknown>>
): Promise<{ promoted: number; pruned: number }> {
  if (candidates.length < 2) return { promoted: 0, pruned: 0 }

  // Load existing semantic entries for THIS tenant only \u2014 cross-tier dedup
  // must not consult another user's semantic memory.
  const existingSemantic = await runAllAsync<{ content: string }>(
    getPlatformDb().selectFrom("memory_entries").select("content").where("tier", "=", MemoryTier.Semantic)
      .where("upn", tenantUpn === null ? "is" : "=", tenantUpn).orderBy("created_at", "desc").limit(100).compile()
  )
  const semanticTokenSets = existingSemantic.map((s) => tokenize(s.content))

  // Agglomerative clustering by Jaccard \u2265 0.4
  const entries = candidates.map((r) => ({
    row: r,
    tokens: tokenize(r.content as string),
    clustered: false
  }))

  const clusters: Array<Array<(typeof entries)[number]>> = []

  for (const entry of entries) {
    if (entry.clustered) continue
    const cluster = [entry]
    entry.clustered = true

    for (const other of entries) {
      if (other.clustered) continue
      if (jaccardSimilarity(entry.tokens, other.tokens) >= 0.4) {
        cluster.push(other)
        other.clustered = true
      }
    }
    clusters.push(cluster)
  }

  let promoted = 0
  let pruned = 0

  for (const cluster of clusters) {
    if (cluster.length < 2) continue

    const contents = cluster.map((c) => c.row.content as string)
    const merged = contents.join("\n---\n")
    const mergedTokens = tokenize(merged)

    // Cross-tier dedup: skip if this cluster duplicates an existing semantic entry
    const isDupOfSemantic = semanticTokenSets.some(
      (st) => jaccardSimilarity(mergedTokens, st) >= DEDUP_JACCARD_THRESHOLD
    )
    if (isDupOfSemantic) {
      const ids = cluster.map((c) => c.row.id as string)
      await runExecAsync(
        getPlatformDb().updateTable("memory_entries").set({
          confidence: (eb) => eb("confidence", "*", 0.3), updated_at: platformNow()
        }).where("id", "in", ids).compile()
      )
      pruned += ids.length
      continue
    }

    // Boosted confidence: 0.5 + clusterSize × 0.1 (agenc-core formula, cap at 0.95)
    const confidence = Math.min(0.95, 0.5 + cluster.length * 0.1)

    await ingestTurn({
      tier: MemoryTier.Semantic,
      role: MemoryRole.Summary,
      content: truncateAtBoundary(merged, 2000, "\n\u2026(consolidated)"),
      metadata: {
        sourceCount: cluster.length,
        provenance: "consolidation:episodic_promotion",
        consolidatedFrom: cluster.map((c) => c.row.id)
      },
      source: MemorySource.System,
      confidence,
      upn: tenantUpn
    })
    promoted++

    semanticTokenSets.push(mergedTokens)

    const ids = cluster.map((c) => c.row.id as string)
    await runExecAsync(
      getPlatformDb().updateTable("memory_entries").set({
        confidence: (eb) => eb("confidence", "*", 0.3), updated_at: platformNow()
      }).where("id", "in", ids).compile()
    )
    pruned += ids.length
  }

  return { promoted, pruned }
}
