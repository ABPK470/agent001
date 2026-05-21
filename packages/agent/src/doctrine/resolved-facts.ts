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
