/**
 * Resolve legacy generator review placeholders into catalog-grounded SQL scopes.
 *
 * Used at artifact import and should stay aligned with
 * deploy/sync/helpers/legacy-entity-derivation.mjs.
 */

export interface ScopeResolveContext {
  rootTable: string
  idColumn: string
  selfJoinColumn: string | null
  tableName: string
  scopeColumn: string | null
}

function hasReviewPlaceholder(predicate: string): boolean {
  return /\/\*[\s\S]*?\*\//.test(predicate) || /\breview\b/i.test(predicate)
}

/** True when a predicate is structurally unusable at preview time. */
export function looksIncompleteScopePredicate(predicate: string): boolean {
  if (typeof predicate !== "string" || predicate.trim().length === 0) return true
  if (hasReviewPlaceholder(predicate)) return true
  if (/\bIN\s*\(\s*\)/i.test(predicate)) return true
  return false
}

const UNRESOLVED_LEGACY_PIPELINE_NOTE =
  /Predicate unresolved from legacy pipeline variable @/i

export function hasUnresolvedLegacyPipelineNote(note: string | null | undefined): boolean {
  return typeof note === "string" && UNRESOLVED_LEGACY_PIPELINE_NOTE.test(note)
}

/**
 * Detects the degraded IN (SELECT DISTINCT …) fallback produced by incomplete
 * legacy imports. Ground-truth predicates from deploy artifacts use EXISTS
 * correlation or sproc-derived SQL — never this pattern for verified tables.
 */
export function isDegradedLegacyFallbackPredicate(predicate: string): boolean {
  if (typeof predicate !== "string" || predicate.trim().length === 0) return false
  if (/\bEXISTS\s*\(/i.test(predicate)) return false
  return /\bIN\s*\(\s*SELECT\s+DISTINCT\b/i.test(predicate)
}

/**
 * Derive a concrete scope from known legacy pipeline-variable patterns.
 * Returns null when the table must be reviewed manually against the entry sproc.
 *
 * First principles: never guess degraded IN-list fallbacks — operators must
 * import reviewed deploy artifacts or run legacy derivation with full sproc body.
 */
export function resolveReviewPlaceholderPredicate(
  predicate: string,
  _ctx: ScopeResolveContext,
): string | null {
  if (!looksIncompleteScopePredicate(predicate)) return predicate.trim()
  return null
}
