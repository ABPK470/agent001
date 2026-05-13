/**
 * Path normalization primitives shared across the agent package.
 *
 * These atoms appear in 5+ call sites (planner blueprint extraction,
 * delegate path canonicalization, recovery detectors, coherent bundle
 * parsing). Centralizing them removes drift risk during the upcoming
 * module splits.
 *
 * @module
 */

/** Convert backslashes to forward slashes (no other normalization). */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/")
}

/** Strip a single leading "./" prefix if present. */
export function stripLeadingDotSlash(value: string): string {
  return value.replace(/^\.\//, "")
}

/**
 * POSIX-ify and strip a leading "./" — the most common combination,
 * used by blueprint contract parsing and coherent bundle path coercion.
 *
 * Does NOT trim, lowercase, collapse repeated slashes, or strip leading
 * "/" — callers that need those should compose explicitly.
 */
export function canonicalizeRelative(value: string): string {
  return stripLeadingDotSlash(toPosixPath(value))
}
