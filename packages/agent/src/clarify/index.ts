// Clarification subsystem — public surface.
//
// Single point of import for prompt assembly, the orchestrator, and
// lint/integration tests. Mirrors `doctrine/index.ts`: an ordered
// registry of detector modules, plus the runner and the renderer that
// turns findings into the <must_clarify> / <resolved_clarifications>
// system blocks.
//
// Registration order is also rendering order. New detectors should be
// inserted in priority order — block-severity kinds first so the agent
// addresses the most urgent ambiguity first.

import { runDetectors } from "./detector.js"
import { emptyResultDetector } from "./detectors/empty-result.js"
import { grainUndefinedDetector } from "./detectors/grain-undefined.js"
import { metricUndefinedDetector } from "./detectors/metric-undefined.js"
import { outputFormatDetector } from "./detectors/output-format.js"
import { schemaMatchDetector } from "./detectors/schema-match.js"
import { termUndefinedDetector } from "./detectors/term-undefined.js"
import { timeRangeDetector } from "./detectors/time-range.js"
import { writeConfirmationDetector } from "./detectors/write-confirmation.js"
import type {
    AmbiguityFinding,
    ClarifyContext,
    Detector,
    ResolvedClarification,
} from "./types.js"

export {
    CLARIFY_BLOCK_BUDGET_BYTES,
    makeFindingId,
    slugSubject
} from "./types.js"

export { runDetectors }

export { parsePlannerResponse, runLlmPlanner, shouldInvokePlanner } from "./llm-planner.js"
export type { LlmPlannerOptions } from "./llm-planner.js"

export type {
    AmbiguityFinding,
    AmbiguityKind,
    AmbiguitySeverity,
    AmbiguitySource,
    ClarifyContext,
    Detector,
    ResolvedClarification
} from "./types.js"

/**
 * Ordered registry of clarification detectors.
 *
 * Order is rendering order in the <must_clarify> block. Block-severity
 * kinds come first because the prompt instructs the agent to address
 * those before any data tool call.
 */
export const CLARIFY_DETECTORS: readonly Detector[] = [
  // block-severity (must be addressed before next data tool call)
  writeConfirmationDetector,
  schemaMatchDetector,
  termUndefinedDetector,
  // warn-severity (acknowledge in answer, do not necessarily block)
  metricUndefinedDetector,
  grainUndefinedDetector,
  timeRangeDetector,
  outputFormatDetector,
  emptyResultDetector,
]

/**
 * Convenience: run all registered detectors against the context.
 * Used by the system-messages renderer and by tests.
 */
export function detectAmbiguities(ctx: ClarifyContext): AmbiguityFinding[] {
  return runDetectors(ctx, CLARIFY_DETECTORS)
}

/**
 * Snapshot of detector ids → versions in registry order. Used by trace
 * emitters and lint to stamp runs with the active clarification policy
 * version (mirrors doctrineVersionsSnapshot()).
 */
export function clarifyVersionsSnapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const d of CLARIFY_DETECTORS) out[d.id] = d.version
  return out
}

/**
 * Filter findings by severity. Useful for callers that want to know
 * whether any blocking ambiguity is open without re-running detectors.
 */
export function blockingFindings(
  findings: readonly AmbiguityFinding[],
): AmbiguityFinding[] {
  return findings.filter((f) => f.severity === "block")
}

/**
 * Has the same finding id been resolved? Used by the orchestrator's
 * ask_user post-handler when matching answers back to findings.
 */
export function isResolved(
  findingId: string,
  resolved: readonly ResolvedClarification[],
): boolean {
  return resolved.some((r) => r.findingId === findingId)
}
