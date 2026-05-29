import { EventType } from "@mia/agent"
import { getDb } from "../sqlite.js"
import { MemoryRole, MemorySource, MemoryTier } from "../../../enums/memory.js"
import { broadcast } from "../../../event-broadcaster.js"
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

export function consolidate(opts?: {
  minAgeHours?: number
  maxBatchSize?: number
  /**
   * Restrict consolidation to one tenant. When omitted, every distinct upn
   * (plus the legacy NULL-upn pool) is processed independently \u2014 candidates
   * from different tenants are NEVER clustered together, so a promoted
   * semantic fact always belongs to exactly one user.
   */
  upn?: string | null
}): { promoted: number; pruned: number } {
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
  const tenantClause = opts?.upn === undefined
    ? ""
    : opts.upn === null
      ? " AND upn IS NULL"
      : " AND upn = ?"
  const tenantParams: unknown[] = opts?.upn === undefined || opts.upn === null ? [] : [opts.upn]

  const candidates = getDb().prepare(`
    SELECT * FROM memory_entries
    WHERE (tier = 'episodic' OR (tier = 'working' AND created_at < ?))
      AND role != 'summary'
      AND created_at < ?${tenantClause}
    ORDER BY created_at ASC
    LIMIT ?
  `).all(cutoff, cutoff, ...tenantParams, maxBatchSize) as Array<Record<string, unknown>>

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
    const r = consolidateTenant(tenantUpn, tenantRows)
    totalPromoted += r.promoted
    totalPruned += r.pruned
  }

  // Prune very low confidence entries (cross-tenant; threshold-only)
  const deleted = getDb().prepare(
    "DELETE FROM memory_entries WHERE confidence < 0.05 AND tier != 'semantic'"
  ).run()
  totalPruned += deleted.changes ?? 0

  if (totalPromoted > 0 || totalPruned > 0) {
    broadcast({
      type: EventType.MemoryConsolidated,
      data: { promoted: totalPromoted, pruned: totalPruned },
    })
  }

  return { promoted: totalPromoted, pruned: totalPruned }
}

function consolidateTenant(
  tenantUpn: string | null,
  candidates: Array<Record<string, unknown>>,
): { promoted: number; pruned: number } {
  if (candidates.length < 2) return { promoted: 0, pruned: 0 }

  // Load existing semantic entries for THIS tenant only \u2014 cross-tier dedup
  // must not consult another user's semantic memory.
  const semanticSql = tenantUpn === null
    ? "SELECT content FROM memory_entries WHERE tier = 'semantic' AND upn IS NULL ORDER BY created_at DESC LIMIT 100"
    : "SELECT content FROM memory_entries WHERE tier = 'semantic' AND upn = ? ORDER BY created_at DESC LIMIT 100"
  const existingSemantic = (tenantUpn === null
    ? getDb().prepare(semanticSql).all()
    : getDb().prepare(semanticSql).all(tenantUpn)) as Array<{ content: string }>
  const semanticTokenSets = existingSemantic.map((s) => tokenize(s.content))

  // Agglomerative clustering by Jaccard \u2265 0.4
  const entries = candidates.map((r) => ({
    row: r,
    tokens: tokenize(r.content as string),
    clustered: false,
  }))

  const clusters: Array<Array<typeof entries[number]>> = []

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
      (st) => jaccardSimilarity(mergedTokens, st) >= DEDUP_JACCARD_THRESHOLD,
    )
    if (isDupOfSemantic) {
      const ids = cluster.map((c) => c.row.id as string)
      const placeholders = ids.map(() => "?").join(", ")
      getDb().prepare(
        `UPDATE memory_entries SET confidence = confidence * 0.3, updated_at = ? WHERE id IN (${placeholders})`
      ).run(new Date().toISOString(), ...ids)
      pruned += ids.length
      continue
    }

    // Boosted confidence: 0.5 + clusterSize × 0.1 (agenc-core formula, cap at 0.95)
    const confidence = Math.min(0.95, 0.5 + cluster.length * 0.1)

    ingestTurn({
      tier: MemoryTier.Semantic,
      role: MemoryRole.Summary,
      content: truncateAtBoundary(merged, 2000, "\n\u2026(consolidated)"),
      metadata: {
        sourceCount: cluster.length,
        provenance: "consolidation:episodic_promotion",
        consolidatedFrom: cluster.map((c) => c.row.id),
      },
      source: MemorySource.System,
      confidence,
      upn: tenantUpn,
    })
    promoted++

    semanticTokenSets.push(mergedTokens)

    const ids = cluster.map((c) => c.row.id as string)
    const placeholders = ids.map(() => "?").join(", ")
    getDb().prepare(
      `UPDATE memory_entries SET confidence = confidence * 0.3, updated_at = ? WHERE id IN (${placeholders})`
    ).run(new Date().toISOString(), ...ids)
    pruned += ids.length
  }

  return { promoted, pruned }
}
