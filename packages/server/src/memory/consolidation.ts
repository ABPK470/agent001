import { getDb } from "../db.js"
import { broadcast } from "../ws.js"
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
}): { promoted: number; pruned: number } {
  const minAgeHours = opts?.minAgeHours ?? 24
  const maxBatchSize = opts?.maxBatchSize ?? 200
  const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000).toISOString()

  // Fetch candidates: episodic entries older than cutoff + old working entries.
  // Exclude role='summary' — these are canonical per-goal answer records (from ingestRunTurns).
  // They must NOT be clustered into semantic because:
  //   1. The content includes specific query results (client names, revenue figures)
  //      that change over time — merging two such entries produces a contradictory
  //      semantic "fact" with wrong answers from multiple different time periods.
  //   2. They are already deduplicated by the episodic upsert (one per goal) — there
  //      is no value in further consolidation.
  // Only working-tier tool-call/result turns (raw patterns) should be clustered.
  const candidates = getDb().prepare(`
    SELECT * FROM memory_entries
    WHERE (tier = 'episodic' OR (tier = 'working' AND created_at < ?))
      AND role != 'summary'
      AND created_at < ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(cutoff, cutoff, maxBatchSize) as Array<Record<string, unknown>>

  if (candidates.length < 3) return { promoted: 0, pruned: 0 }

  // Load existing semantic entries for cross-tier dedup
  const existingSemantic = getDb().prepare(`
    SELECT content FROM memory_entries WHERE tier = 'semantic'
    ORDER BY created_at DESC LIMIT 100
  `).all() as Array<{ content: string }>
  const semanticTokenSets = existingSemantic.map((s) => tokenize(s.content))

  // Agglomerative clustering by Jaccard ≥ 0.4
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
      tier: "semantic",
      role: "summary",
      content: truncateAtBoundary(merged, 2000, "\n\u2026(consolidated)"),
      metadata: {
        sourceCount: cluster.length,
        provenance: "consolidation:episodic_promotion",
        consolidatedFrom: cluster.map((c) => c.row.id),
      },
      source: "system",
      confidence,
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

  // Prune very low confidence entries
  const deleted = getDb().prepare(
    "DELETE FROM memory_entries WHERE confidence < 0.05 AND tier != 'semantic'"
  ).run()
  pruned += deleted.changes ?? 0

  if (promoted > 0 || pruned > 0) {
    broadcast({
      type: "memory.consolidated",
      data: { promoted, pruned },
    })
  }

  return { promoted, pruned }
}
