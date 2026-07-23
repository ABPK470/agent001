/**
 * External Leverage — closed invariants for user-facing product quality.
 * Parallel to Internal Leverage / seams: general mechanisms, not one-off bans.
 *
 * A. Zero cognitive overhead → domain surface (vocabulary SSOT, no tech jargon leaks)
 * B. Mechanical sympathy → no silent failure (errors must be named / observed)
 * C. Uncompromising trust → no type escapes, no eval, no unchecked dangerous sinks
 */

/** Technical substrings that must not appear in UI widget/state string literals
 *  (leaks platform internals into the domain surface). */
export const SURFACE_JARGON_PATTERNS = [
  { id: "pkg-path", re: /packages\/[a-z]+\/src\//, detail: "internal package path" },
  { id: "als", re: /AsyncLocalStorage/, detail: "DI implementation detail" },
  { id: "node-modules", re: /node_modules\//, detail: "filesystem layout" },
  { id: "stack-frame", re: /\bat\s+\S+\s+\([^)]+\.(?:ts|js):\d+/ , detail: "raw stack frame" },
]

/**
 * Layers where trust escapes are forbidden (correctness non-negotiable).
 * Type escapes here hide bugs in the decision core.
 */
export const TRUST_PURE_LAYERS = new Set(["core", "domain"])

/** Call / JSX sinks that break integrity unless explicitly allowlisted. */
export const TRUST_DANGEROUS_SINKS = [
  { id: "eval", match: (name) => name === "eval" },
  { id: "Function", match: (name) => name === "Function" },
]

/** @typedef {{ file: string, note: string, used?: boolean }} ExtDebt */
