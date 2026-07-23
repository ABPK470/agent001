/**
 * External leverage policy — patterns only (general).
 * Product-specific catalogs/seams live elsewhere in registry/.
 */

export { PURE_LAYERS as TRUST_PURE_LAYERS } from "./registry/policy.mjs"

/** Technical substrings banned in domain-surface string literals. */
export const SURFACE_JARGON_PATTERNS = [
  { id: "pkg-path", re: /packages\/[a-z]+\/src\//, detail: "internal package path" },
  { id: "als", re: /AsyncLocalStorage/, detail: "DI implementation detail" },
  { id: "node-modules", re: /node_modules\//, detail: "filesystem layout" },
  { id: "stack-frame", re: /\bat\s+\S+\s+\([^)]+\.(?:ts|js):\d+/, detail: "raw stack frame" },
]

export const TRUST_DANGEROUS_SINKS = [
  { id: "eval", match: (name) => name === "eval" },
  { id: "Function", match: (name) => name === "Function" },
]
