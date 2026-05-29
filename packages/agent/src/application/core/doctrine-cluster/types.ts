// Doctrine module interface — the SSoT contract.
//
// Each MSSQL doctrine concern (temp-naming, big-view budget, aggregate
// semantics, Revenue/Balances branch policy) lives in exactly one TS
// module that exports:
//   • id:      stable string identifier — appears in traces and lint tests
//   • version: monotonically bumped string when the rule changes
//   • summary: short human-readable text safe to inject in the prompt.
//              Must stay under SUMMARY_BUDGET_BYTES; build fails otherwise.
//   • enforce: optional structural check that returns diagnostics for a
//              given query string. Wraps existing validator helpers; the
//              validator remains the authoritative gate.
//
// The point of the registry is to ensure each rule is documented in code,
// versioned, byte-bounded, and citable — not duplicated across prompts.

export interface DoctrineDiagnostic {
  /** Stable code that callers (validator, telemetry) can route on. */
  readonly code: string
  /** Short, agent-facing message describing what was wrong. */
  readonly message: string
  /** "warn" surfaces in traces; "block" should be promoted by the validator. */
  readonly severity: "warn" | "block"
  /**
   * Canonical, doctrine-owned refactor hint shown to the agent on block.
   * Centralised here (not in the validator) so the rule, the prompt text,
   * and the failure-time advice all live in one module.
   */
  readonly fixHint?: string
}

export interface DoctrineModule {
  readonly id: string
  readonly version: string
  /** Maximum bytes the summary() output is allowed to occupy. */
  readonly summaryBudgetBytes: number
  /** Compact, citation-style summary for prompt assembly. No code fences. */
  summary(): string
  /** Optional structural check; returns [] when the query is doctrine-clean. */
  enforce?(query: string): DoctrineDiagnostic[]
}

/** Total byte budget for the assembled doctrine block in the system prompt. */
export const DOCTRINE_BLOCK_BUDGET_BYTES = 2816
