/**
 * Failure classes (doctrine) → lint rule ids.
 * Every class must have a runner; none may be soft-ignored by default.
 */
export const FAILURE_CLASSES = [
  { id: 1, name: "unowned-identity", rule: "owned-identities" },
  { id: 2, name: "unregistered-capability", rule: "seams" },
  { id: 3, name: "resurrected-capability", rule: "seams" },
  { id: 4, name: "second-dialect", rule: "dialects" },
  { id: 5, name: "cores-resolve-folklore", rule: "resolved-inputs" },
  { id: 6, name: "illegal-layer-import", rule: "layers+framework-deny" },
  { id: 7, name: "import-cycles", rule: "cycles" },
  { id: 8, name: "deep-package-imports", rule: "export-surface" },
  { id: 9, name: "forbidden-trees", rule: "forbidden-trees+top-level" },
  { id: 10, name: "hidden-ambient-state", rule: "module-state+forbidden-constructors" },
  { id: 11, name: "nested-hot-path-listeners", rule: "flat-control-flow" },
  { id: 12, name: "silent-failure", rule: "silent-failure" },
  { id: 13, name: "silent-outcome-fallback", rule: "named-outcome" },
  { id: 14, name: "vocabulary-fork", rule: "domain-surface+dialects+catalog-coverage" },
  { id: 15, name: "jargon-leak", rule: "domain-surface" },
  { id: 16, name: "incomplete-observability", rule: "catalog-coverage" },
  { id: 17, name: "trust-escape", rule: "trust" },
  { id: 18, name: "ops-code-forks", rule: "identity-forks+branded-path" },
  { id: 19, name: "allowlist-creep", rule: "stale-debt" }, // fails if any debt list is non-empty
]
