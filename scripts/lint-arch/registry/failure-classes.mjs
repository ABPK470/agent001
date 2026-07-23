/**
 * Failure classes (doctrine) → lint rule ids.
 * Every class must have a runner; debt lists must stay empty.
 */
export const FAILURE_CLASSES = [
  // ── 1. Identity & Capability Boundaries ────────────────────────
  { id: 1, name: "unowned-identity", rule: "owned-identities" },
  { id: 2, name: "unregistered-capability", rule: "seams" },
  { id: 3, name: "resurrected-capability", rule: "seams" },
  { id: 4, name: "second-dialect", rule: "dialects" },
  { id: 5, name: "cores-resolve-folklore", rule: "resolved-inputs" },

  // ── 2. Layering & Imports ───────────────────────────────────────
  { id: 6, name: "illegal-layer-import", rule: "layers+framework-deny" },
  { id: 7, name: "import-cycles", rule: "cycles" },
  { id: 8, name: "deep-package-imports", rule: "export-surface" },
  { id: 9, name: "forbidden-trees", rule: "forbidden-trees+top-level" },

  // ── 3. State & Control Flow ─────────────────────────────────────
  { id: 10, name: "hidden-ambient-state", rule: "module-state+forbidden-constructors" },
  { id: 11, name: "nested-hot-path-listeners", rule: "flat-control-flow" },
  { id: 12, name: "dangling-fire-and-forget", rule: "scoped-lifecycle" },
  { id: 13, name: "unaborted-subpath", rule: "cancellation-flow" },
  { id: 14, name: "leakable-host-handle", rule: "resource-cleanup" },

  // ── 4. Failure & Resilience ─────────────────────────────────────
  { id: 15, name: "silent-failure", rule: "silent-failure" },
  { id: 16, name: "silent-outcome-fallback", rule: "named-outcome" },
  { id: 17, name: "unindexed-error-code", rule: "error-registry" },

  // ── 5. Domain & Dialect Surface ─────────────────────────────────
  { id: 18, name: "vocabulary-fork", rule: "domain-surface+dialects+catalog-coverage" },
  { id: 19, name: "jargon-leak", rule: "domain-surface" },
  { id: 20, name: "ops-code-forks", rule: "identity-forks+branded-path" },

  // ── 6. Type Safety & Boundary Sinks ─────────────────────────────
  { id: 21, name: "raw-json-parse-sink", rule: "schema-at-boundary" },
  { id: 22, name: "opaque-primitive-smell", rule: "branded-types" },
  { id: 23, name: "leaky-abstraction-leak", rule: "leak-free-ports" },

  // ── 7. Determinism & Observability ──────────────────────────────
  { id: 24, name: "unseeded-entropy", rule: "deterministic-execution" },
  { id: 25, name: "nondeterministic-map-iter", rule: "deterministic-ordering" },
  { id: 26, name: "incomplete-observability", rule: "catalog-coverage" },
  { id: 27, name: "unredacted-secret-sink", rule: "data-sanitization" },

  // ── 8. Trust & Debt Governance ──────────────────────────────────
  { id: 28, name: "trust-escape", rule: "trust" },
  { id: 29, name: "allowlist-creep", rule: "stale-debt" },
  { id: 30, name: "stale-debt-entry", rule: "stale-allowlist" },
]
