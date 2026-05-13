/**
 * JSON / shape-narrowing primitives shared across the agent package.
 *
 * `isRecord` and `asNonEmptyString` are duplicated verbatim in
 * planner/coherent-parse.ts, planner/generate-prompts.ts, and several
 * verifier helpers. Centralizing them eliminates drift.
 *
 * NOTE: We intentionally do NOT unify the two `parseJsonObject`
 * implementations (one is single-strategy, the other has 3-strategy
 * recovery including balanced-brace extraction). They are scheduled for
 * later consolidation in the planner phase, behind explicit naming.
 *
 * @module
 */

/** True when value is a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Returns the value when it is a string with at least one non-whitespace char, else null. */
export function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}
