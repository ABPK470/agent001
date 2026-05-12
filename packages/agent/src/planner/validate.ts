/**
 * Plan validation — multi-pass structural and semantic checks on a generated plan.
 *
 * Validates:
 *   1. Parse integrity — all required fields present, types correct
 *   2. Graph validity — no cycles, reasonable depth/fanout
 *   3. Step contracts — subagent tasks have proper acceptance criteria, tool steps reference real tools
 *   4. Artifact ownership — at most one write_owner per artifact
 *   5. Verification requirements — implementors have verification steps
 *
 * Returns diagnostics with refinement hints the planner can use to fix the plan.
 *
 * @module
 */

import type { Tool } from "../types.js"
import type { Plan, PlanDiagnostic, PlanStep, SubagentTaskStep } from "./types.js"
import {
    validateArtifactDependencyWiring,
    validatePathConsistency,
    validateSharedDataContract,
    validateVisualCompleteness,
} from "./validate-checks.js"
import { validateGraph, validateToolReferences } from "./validate/graph.js"
import {
    validateArtifactOwnership,
    validateStepContracts,
    validateVerificationCoverage,
} from "./validate/contracts.js"

const RUNTIME_CODE_ARTIFACT_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|php|java|wasm)$/i

// ============================================================================
// Main validation entry point
// ============================================================================

export interface ValidationResult {
  readonly valid: boolean
  readonly diagnostics: readonly PlanDiagnostic[]
}

/**
 * Run all validation passes on a plan.
 *
 * @param plan - The parsed plan to validate
 * @param availableTools - Available tools (for checking tool references)
 */
export function validatePlan(
  plan: Plan,
  availableTools: readonly Tool[],
): ValidationResult {
  const diagnostics: PlanDiagnostic[] = []

  diagnostics.push(...validateGraph(plan.steps, plan.edges))
  diagnostics.push(...validateToolReferences(plan.steps, availableTools))
  diagnostics.push(...validateStepContracts(plan.steps))
  diagnostics.push(...validateArtifactOwnership(plan.steps))
  diagnostics.push(...validateVerificationCoverage(plan.steps))
  diagnostics.push(...validatePathConsistency(plan.steps))
  diagnostics.push(...validateArtifactDependencyWiring(plan.steps))
  diagnostics.push(...validatePrematureBrowserVerification(plan.steps))
  diagnostics.push(...validateVisualCompleteness(plan.steps))
  diagnostics.push(...validateSharedDataContract(plan.steps))

  return {
    valid: diagnostics.filter(d => d.severity === "error").length === 0,
    diagnostics,
  }
}

function artifactDir(path: string): string {
  const parts = path.split("/")
  if (parts.length <= 1) return ""
  return parts.slice(0, -1).join("/")
}

function isSameOrNestedDir(candidate: string, base: string): boolean {
  if (!base) return candidate.length === 0
  return candidate === base || candidate.startsWith(`${base}/`)
}

// ============================================================================
// Browser verification ordering
// ============================================================================

/**
 * Detect impossible contracts where a browser_check step runs on web entry
 * artifacts before related web runtime artifacts are produced by other steps.
 */
function validatePrematureBrowserVerification(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]

  const runtimeByStep = new Map<string, string[]>()
  for (const step of subagentSteps) {
    const runtimeArtifacts = (step.executionContext?.targetArtifacts ?? [])
      .filter(a => RUNTIME_CODE_ARTIFACT_RE.test(a))
    runtimeByStep.set(step.name, runtimeArtifacts)
  }

  for (const step of subagentSteps) {
    if (step.executionContext?.verificationMode !== "browser_check") continue
    const entryTargets = (step.executionContext?.targetArtifacts ?? []).filter(a => /\.(?:html?|xhtml)$/i.test(a))
    if (entryTargets.length === 0) continue

    const ownRuntime = new Set(runtimeByStep.get(step.name) ?? [])
    const entryDirs = entryTargets.map(artifactDir)

    const ownRuntimeDirs = new Set([...ownRuntime].map(artifactDir))
    const relatedForeignRuntime = subagentSteps
      .filter(s => s.name !== step.name)
      .flatMap(s => runtimeByStep.get(s.name) ?? [])
      .filter((artifactPath) => {
        if (ownRuntime.has(artifactPath)) return false
        const runtimeDir = artifactDir(artifactPath)
        if (ownRuntimeDirs.size > 0) {
          return ownRuntimeDirs.has(runtimeDir)
        }
        return entryDirs.some((dir) => isSameOrNestedDir(runtimeDir, dir) || isSameOrNestedDir(dir, runtimeDir))
      })

    if (relatedForeignRuntime.length > 0) {
      const sample = [...new Set(relatedForeignRuntime)].slice(0, 4).join(", ")
      diagnostics.push({
        category: "verification",
        severity: "error",
        code: "premature_browser_verification",
        message: `Step "${step.name}" runs browser_check on web entry artifacts before related runtime artifacts are owned by this step: ${sample}. ` +
          `Move required runtime artifacts into this step, or defer browser_check to a later integration owner step that includes all referenced assets.`,
        stepName: step.name,
      })
    }
  }

  return diagnostics
}

// ============================================================================
// Re-exported passes (extracted to validate/graph.ts and validate/contracts.ts)
// ============================================================================

export {
  validateGraph,
  validateToolReferences,
} from "./validate/graph.js"
export {
  validateArtifactOwnership,
  validateStepContracts,
  validateVerificationCoverage,
} from "./validate/contracts.js"
