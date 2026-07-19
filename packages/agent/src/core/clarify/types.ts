// Clarification subsystem — shared vocabulary.
//
// The clarify/ subsystem replaces the agent's old reliance on a hand-curated
// lineage taxonomy ("publish.Revenue is in business area X, sources Y, Z…")
// with a generic discipline: when the goal is ambiguous, the agent should
// detect that ambiguity, ask the user one good question, and remember the
// answer for the rest of the run.
//
// Three pieces:
//   • Detector       — a small pluggable module that returns AmbiguityFinding[]
//                      from a ClarifyContext. Modelled on the doctrine pattern.
//   • findings       — structured records the system-message renderer turns
//                      into <must_clarify> / <resolved_clarifications> blocks
//                      injected into the next round's system prompt.
//   • ResolvedClarification — what the orchestrator records when the user
//                      answers a previously-emitted question, keyed by the
//                      finding's stable id so the same subject never re-asks.

import type { Message } from "../../domain/types/agent-types.js"
import type { CatalogGraph } from "../../tools/index.js"
import type { TenantConfig } from "../../domain/tenant/tenant-config.js"

// ── Finding ──────────────────────────────────────────────────────

/**
 * The kinds of ambiguity the agent recognises. Each kind maps to exactly
 * one detector module in detectors/. Adding a new kind requires (a) adding
 * the literal here, (b) adding a detector, (c) registering it in index.ts.
 *
 * Keep this list short and orthogonal — if a new kind overlaps an existing
 * one, extend the existing detector instead of adding a new kind.
 */
export type AmbiguityKind =
  | "schema-match" // noun in goal matches multiple catalog identifiers
  | "canonical-ambiguity" // top-1 vs top-2 catalog scores within a hair on a metric goal
  | "anaphora-ungrounded" // goal refers anaphorically to prior data but no recallable tool payload exists
  | "term-undefined" // capitalised business word with no catalog/tenant match
  | "metric-undefined" // ranking language ("top", "biggest") without a metric
  | "grain-undefined" // period word ("monthly") matches multiple grain cols
  | "time-range" // vague time word ("recent") with no anchor date
  | "output-format" // "summarise/overview" with no format hint
  | "write-confirmation" // non-#temp DML/DDL planned or just executed
  | "empty-result" // last tool call returned no rows on a data goal

/**
 * Severity gate. Prompted-only enforcement (per architectural decision):
 * the orchestrator does NOT hard-block tool calls on `block` findings. It
 * surfaces them in <must_clarify> and the prompt rules instruct the agent
 * to call ask_user first. `warn` findings are surfaced as caveats only.
 */
export type AmbiguitySeverity = "block" | "warn"

/**
 * Source of the finding. Used by trace/lint to distinguish deterministic
 * detector output from the LLM-planner fallback (Phase A.3).
 */
export type AmbiguitySource = "detector" | "llm-planner"

export interface AmbiguityFinding {
  /**
   * Stable across rounds. Format: `<kind>:<subject-slug>` — the orchestrator
   * uses this to dedupe against `ResolvedClarification.findingId` so the
   * same subject does not re-fire after the user has answered.
   */
  readonly id: string
  readonly kind: AmbiguityKind
  readonly severity: AmbiguitySeverity
  /** The token or phrase in the user goal the finding is about. */
  readonly subject: string
  /** One-line explanation of why this is ambiguous. Agent-facing. */
  readonly reasoning: string
  /** Plausible interpretations the agent (or user) can pick from. */
  readonly candidates?: readonly string[]
  /**
   * Optional closed-set choices safe to expose as ask_user options.
   * Omit for open-ended ambiguities where the user should answer freely.
   */
  readonly uiOptions?: readonly string[]
  /**
   * Suggested question text the agent may use verbatim when calling
   * ask_user. Phrased as a direct question to the end user.
   */
  readonly suggestedQuestion: string
  /** Which layer produced this finding. */
  readonly source: AmbiguitySource
}

// ── Resolved clarifications ──────────────────────────────────────

/**
 * Recorded by the orchestrator when ask_user resolves a question that
 * matches a previously-emitted finding's suggestedQuestion. Lives on the
 * per-run state and is rendered into the <resolved_clarifications> block
 * on every subsequent round so the agent does not re-ask.
 */
export interface ResolvedClarification {
  readonly findingId: string
  readonly kind: AmbiguityKind
  readonly subject: string
  readonly question: string
  readonly answer: string
  readonly resolvedAtRound: number
}

// ── Detector contract ────────────────────────────────────────────

/**
 * Inputs available to every detector. Detectors are pure functions of this
 * context — no I/O, no LLM calls, no clock reads (except as injected here).
 */
export interface ClarifyContext {
  /** The user's current goal text. Lowercase comparisons are detector-local. */
  readonly goal: string
  /** Live catalog graph, or null when the agent is in a non-DB context. */
  readonly catalog: CatalogGraph | null
  /** Active tenant config — supplies domainKeywords etc. */
  readonly tenant: TenantConfig
  /** Conversation history (assistant + user + tool messages). */
  readonly messages: readonly Message[]
  /** Already-answered findings, keyed by finding id — used by detectors to suppress. */
  readonly resolved: readonly ResolvedClarification[]
  /** 1-based round number (matches orchestrator round counter). */
  readonly round: number
  /**
   * Last tool call's textual result, if any. Used by `empty-result` and
   * `write-confirmation` detectors. Absent on round 1.
   */
  readonly lastToolResultText?: string
  /**
   * SQL text the agent has either just executed or is about to execute,
   * if known. Used by `write-confirmation` detector.
   */
  readonly lastSqlText?: string
  /**
   * Number of recallable tool-result payloads available to this turn
   * (entries the orchestrator loaded into the `<prior_results>`
   * system_anchor from the `tool_results` table). Used by the
   * `anaphora-ungrounded` detector to decide whether an anaphoric goal
   * ("it", "those", "that result") has any structured evidence behind it
   * — zero means the agent would have to paraphrase prior prose, which
   * is exactly the no-amnesia trap. Absent in non-server contexts (CLI,
   * tests with no orchestrator); detector then no-ops.
   */
  readonly priorResultsCount?: number
  /**
   * Tokens naming parameters of an active operational workflow (e.g. sync
   * definition ids, environment names from published registries). When a
   * goal token appears here, catalog-table disambiguation is suppressed —
   * the workflow's own tools resolve the reference.
   */
  readonly domainVocabulary?: { readonly reservedTokens: ReadonlySet<string> }
  /**
   * Durable term→table mappings the org has already learned from prior
   * clarification answers (lowercase business noun → qualified table).
   * Hydrated at run start from the `resolved_terms_cache` store by `law-sections`
   * and consulted by `entity-canonical` so a subject the org already
   * resolved does not trigger a fresh `ask_user`. Only mappings whose
   * qname resolves in the live catalog are included (stale ones are
   * dropped at hydrate time). Absent in non-server contexts (CLI, tests).
   */
  readonly learnedTermMappings?: ReadonlyMap<string, string>
  /**
   * Deterministic parse of a natural-language ABI sync preview goal
   * (sync + published entity type + from env to env). When set, catalog
   * disambiguation must not fire on entity instance names.
   */
  readonly syncOperationIntent?: {
    readonly entityType: string
    readonly entityQuery: string | null
    readonly entityId: string | null
    readonly source: string
    readonly target: string
    readonly reservedTokens: ReadonlySet<string>
  }
}

/** Drop catalog-disambiguation findings superseded by a sync operation parse. */
export function filterFindingsForSyncIntent(
  findings: readonly AmbiguityFinding[],
  intent: ClarifyContext["syncOperationIntent"]
): AmbiguityFinding[] {
  if (!intent) return [...findings]
  return findings.filter((f) => {
    if (f.kind !== "schema-match" && f.kind !== "term-undefined") return true
    const subject = f.subject.toLowerCase()
    if (intent.reservedTokens.has(subject)) return false
    return !subject.split(/\s+/).some((t) => intent.reservedTokens.has(t.toLowerCase()))
  })
}

export interface Detector {
  /** Stable id matching the detector's kind (one detector per kind). */
  readonly id: AmbiguityKind
  /** Monotonic version bumped when the detection rule materially changes. */
  readonly version: string
  /** Pure detection — return [] when nothing is ambiguous. */
  detect(ctx: ClarifyContext): AmbiguityFinding[]
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Slug a subject into the id portion of a finding. Stable across rounds:
 * lowercase, non-alphanumerics → hyphen, collapsed runs, trimmed.
 * Used by detectors to build the canonical finding id.
 */
export function slugSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

/** Build a stable finding id from kind + subject. */
export function makeFindingId(kind: AmbiguityKind, subject: string): string {
  return `${kind}:${slugSubject(subject)}`
}

// ── Block-assembly budget ────────────────────────────────────────

/**
 * Per-round byte ceiling for the combined <must_clarify> +
 * <resolved_clarifications> blocks injected into the system prompt.
 * Mirrors the doctrine block budget — prevents a runaway detector or
 * a long-lived run with dozens of resolutions from blowing the prompt.
 */
export const CLARIFY_BLOCK_BUDGET_BYTES = 2048
