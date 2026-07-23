/**
 * Pure identifier token split for operational vocabulary.
 * Host-backed builders live in `runtime/operational-vocabulary`.
 */

export function splitIdentifierTokens(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}
