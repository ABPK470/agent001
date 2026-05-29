// resolvedFacts builder — Phase 3 of the systemic refactor plan.
//
// This produces the per-run catalog-resolved block that replaces every
// conditional "if X exists do Y" sentence in MSSQL prompt prose. The
// builder is a pure function so it can be tested in isolation. The
// caller (orchestrator) is responsible for sourcing the inputs from
// the live catalog and lineage at run time.
//
// Output is intentionally compact (≤ RESOLVED_FACTS_BUDGET_BYTES) and
// declarative. It does NOT carry rules; rules live in MSSQL_DOCTRINES.
// It carries CONCRETE FACTS about THIS environment for THIS run.

export const RESOLVED_FACTS_BUDGET_BYTES = 800

export interface LargeObjectFact {
  /** Qualified lowercased name, e.g. "publish.revenue". */
  readonly name: string
  /** True iff a persistedView mirror exists in the live catalog. */
  readonly hasPersistedMirror: boolean
  /** Optional branch count for UNION views (Revenue/Balances etc.). */
  readonly branchCount?: number
  /** Optional one-line note (e.g. "ranked client read"). */
  readonly note?: string
  /**
   * Plan v3 Phase 7 — structural rank of this object among siblings
   * sharing its name prefix in the live catalog (1 = top). Lets the
   * agent see at a glance whether this is the bare canonical or a
   * suffixed subset.
   */
  readonly structuralRank?: number
  /**
   * Plan v3 Phase 7 — total source-row fan-in for a VIEW (sum across
   * branches per `viewSourceRows`). Distinguishes a 270M-row wide UNION
   * from a 12M-row sibling subset at glance time.
   */
  readonly fanInRows?: number
  /**
   * Plan v3 Phase 7 — durable role this object was given by a prior
   * run's reflection turn (`canonical|subset|staging|archive|rules`).
   * Empty when no verdict exists.
   */
  readonly verdictRole?: string
}

export interface ResolvedFactsInput {
  /** Large objects the agent is likely to touch this run. Order is preserved. */
  readonly largeObjects: readonly LargeObjectFact[]
  /** Optional schema fingerprint short-hash for traceability. */
  readonly schemaFingerprint?: string
}

/**
 * Builds the resolvedFacts block. Returns an empty string if there are no
 * facts to report (caller should then omit the section entirely).
 *
 * @throws if assembled output exceeds RESOLVED_FACTS_BUDGET_BYTES.
 */
export function buildResolvedFacts(input: ResolvedFactsInput): string {
  const lines: string[] = []
  if (input.largeObjects.length > 0) {
    lines.push("Resolved facts for this run:")
    for (const o of input.largeObjects) {
      const parts: string[] = [o.name]
      parts.push(o.hasPersistedMirror ? "persistedView mirror EXISTS" : "no persistedView mirror")
      if (typeof o.branchCount === "number") parts.push(`${o.branchCount} union branches`)
      if (typeof o.fanInRows === "number" && o.fanInRows > 0) {
        const m = o.fanInRows / 1_000_000
        parts.push(m >= 1 ? `${m.toFixed(0)}M source rows` : `${o.fanInRows} source rows`)
      }
      if (typeof o.structuralRank === "number") parts.push(`rank #${o.structuralRank} in sibling cluster`)
      if (o.verdictRole) parts.push(`prior verdict: ${o.verdictRole}`)
      if (o.note) parts.push(o.note)
      lines.push(`- ${parts.join("; ")}`)
    }
  }
  if (input.schemaFingerprint) {
    lines.push(`schema fingerprint: ${input.schemaFingerprint}`)
  }
  if (lines.length === 0) return ""
  const out = lines.join("\n")
  const size = Buffer.byteLength(out, "utf8")
  if (size > RESOLVED_FACTS_BUDGET_BYTES) {
    throw new Error(`resolvedFacts is ${size}B, exceeds ${RESOLVED_FACTS_BUDGET_BYTES}B budget.`)
  }
  return out
}
