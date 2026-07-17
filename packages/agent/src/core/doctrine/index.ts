// Doctrine registry — single point of import for prompt assembly,
// validator delegation, and lint tests.

import { aggregateNamingDoctrine } from "./aggregate-naming.js"
import { aliasBracketingDoctrine } from "./alias-bracketing.js"
import { bigViewBudgetDoctrine } from "./big-view-budget.js"
import { tempNamingDoctrine } from "./temp-naming.js"
import { tempScalarSubqueryDoctrine } from "./temp-scalar-subquery.js"
import { DOCTRINE_BLOCK_BUDGET_BYTES, type DoctrineDiagnostic, type DoctrineModule } from "./types.js"
import { wideUnionViewPolicyDoctrine } from "./wide-union-view-policy.js"

export {
  buildResolvedFacts,
  RESOLVED_FACTS_BUDGET_BYTES,
  type LargeObjectFact,
  type ResolvedFactsInput
} from "./resolved-facts.js"
export { DOCTRINE_BLOCK_BUDGET_BYTES }
export type { DoctrineDiagnostic, DoctrineModule }

/** Ordered list of MSSQL doctrines. Order is the prompt-assembly order. */
export const MSSQL_DOCTRINES: readonly DoctrineModule[] = [
  aliasBracketingDoctrine,
  tempNamingDoctrine,
  tempScalarSubqueryDoctrine,
  bigViewBudgetDoctrine,
  aggregateNamingDoctrine,
  wideUnionViewPolicyDoctrine
]

/** Assembles the doctrine block for prompt injection. Throws if over budget. */
export function assembleDoctrineBlock(): string {
  const parts: string[] = []
  for (const d of MSSQL_DOCTRINES) {
    const text = d.summary()
    const size = Buffer.byteLength(text, "utf8")
    if (size > d.summaryBudgetBytes) {
      throw new Error(
        `Doctrine ${d.id}@${d.version} summary is ${size}B, exceeds ${d.summaryBudgetBytes}B budget.`
      )
    }
    parts.push(text)
  }
  const block = parts.join("\n\n")
  const totalSize = Buffer.byteLength(block, "utf8")
  if (totalSize > DOCTRINE_BLOCK_BUDGET_BYTES) {
    throw new Error(
      `Assembled doctrine block is ${totalSize}B, exceeds total ${DOCTRINE_BLOCK_BUDGET_BYTES}B budget.`
    )
  }
  return block
}

/** Runs every doctrine's enforce() over the query and flattens diagnostics. */
export function enforceDoctrines(query: string): DoctrineDiagnostic[] {
  const out: DoctrineDiagnostic[] = []
  for (const d of MSSQL_DOCTRINES) {
    if (!d.enforce) continue
    out.push(...d.enforce(query))
  }
  return out
}

export { DOCTRINE_FIX_HINTS, getDoctrineFixHint } from "./fix-hints.js"

/**
 * Snapshot of all doctrine ids → versions in registry order. Used by
 * trace emitters and by the memory layer's policy-version stamp. Stable
 * wire format so downstream consumers can diff across runs.
 */
export function doctrineVersionsSnapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const d of MSSQL_DOCTRINES) out[d.id] = d.version
  return out
}

/**
 * Deterministic short string identifying the current doctrine set.
 * Format: `id1@v1|id2@v2|...` in registry order. Memory entries stamped
 * with this value can be matched/demoted on policy drift without any
 * cryptographic dependency.
 */
export function mssqlPolicyVersion(): string {
  return MSSQL_DOCTRINES.map((d) => `${d.id}@${d.version}`).join("|")
}
