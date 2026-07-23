/**
 * Plan normalization — warning injection, output directory normalization,
 * shared contract injection, dependency wiring, step merging, and remediation.
 *
 * Extracted from planner/index.ts for maintainability.
 *
 * @module
 */

import type { Plan, PlanDiagnostic, SubagentTaskStep } from "../types.js"
import { normalizeOutputDirToken, normalizePlanOutputDirectory } from "./helpers.js"

export { mostFrequent, normalizeOutputDirToken, normalizePlanOutputDirectory, uniqueList } from "./helpers.js"

// ============================================================================
// Warning injection
// ============================================================================

export function injectWarningsIntoSteps(plan: Plan, warnings: readonly PlanDiagnostic[]): void {
  const stepWarnings = new Map<string, string[]>()
  const globalWarnings: string[] = []

  for (const w of warnings) {
    if (w.stepName) {
      const arr = stepWarnings.get(w.stepName) ?? []
      arr.push(w.message)
      stepWarnings.set(w.stepName, arr)
    } else {
      globalWarnings.push(w.message)
    }
  }

  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const msgs = [...(stepWarnings.get(sa.name) ?? []), ...globalWarnings]
    if (msgs.length === 0) continue
    const suffix = `\n\n⚠️ VALIDATION WARNINGS (address these in your implementation):\n${msgs.map((m) => `- ${m}`).join("\n")}`
    ;(sa as { objective: string }).objective = sa.objective + suffix
  }
}

export function applyWarningAutoFixes(plan: Plan, warnings: readonly PlanDiagnostic[]): void {
  const codes = new Set(warnings.map((w) => w.code))

  if (codes.has("inconsistent_output_directory") || codes.has("mixed_root_and_subdir")) {
    normalizePlanOutputDirectory(plan)
  }

  if (codes.has("missing_shared_data_contract")) {
    injectSharedDataContract(plan)
  }

  if (codes.has("missing_dependency_wiring_criteria")) {
    injectDependencyWiringCriteria(plan)
  }

  injectBrowserRuntimeContracts(plan)
  injectHelperDependencyContracts(plan)
  injectVisualStyleContracts(plan)
}

// ============================================================================
// Output directory normalization
// ============================================================================

export function inferForcedOutputDirectoryFromGoal(goal: string): string | null {
  const namedMatch = goal.match(/\btemporary\s+working\s+directory\s+named\s+([a-zA-Z0-9._\/-]+)/i)
  if (namedMatch?.[1]) {
    const dir = normalizeOutputDirToken(namedMatch[1])
    if (dir && !dir.includes("..")) return dir
  }

  const constrainedPathMatch = goal.match(
    /\ball\s+project\s+files\b[\s\S]{0,120}?\b(?:in|under|inside)\s+([a-zA-Z0-9._\/-]+)/i
  )
  if (constrainedPathMatch?.[1]) {
    const dir = normalizeOutputDirToken(constrainedPathMatch[1])
    if (dir && !dir.includes("..")) return dir
  }

  if (/\ball\s+project\s+files\b[\s\S]{0,120}?\btmp\b/i.test(goal)) {
    return "tmp"
  }

  return null
}

// ============================================================================
// Contract injection — extracted to ./contract-injection.ts
// ============================================================================

import {
  injectBrowserRuntimeContracts,
  injectDependencyWiringCriteria,
  injectHelperDependencyContracts,
  injectSharedDataContract,
  injectVisualStyleContracts
} from "./contract-injection.js"

export {
  injectBrowserRuntimeContracts,
  injectDependencyWiringCriteria,
  injectHelperDependencyContracts,
  injectSharedDataContract,
  injectSharedStateOwnershipContract,
  injectVisualStyleContracts
} from "./contract-injection.js"

// Re-export remediation helpers for backwards compatibility
export { inferOutputDir, remediateValidationErrors } from "../internal/index-remediate.js"
