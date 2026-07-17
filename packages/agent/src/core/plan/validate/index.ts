import { DiagnosticSeverity } from "../../../domain/index.js"
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

import type { Tool } from "../../types.js"
import {
  validateArtifactDependencyWiring,
  validatePathConsistency,
  validateSharedDataContract,
  validateVisualCompleteness
} from "../internal/validate-checks.js"
import type { Plan, PlanDiagnostic } from "../types.js"
import {
  validateArtifactOwnership,
  validateStepContracts,
  validateVerificationCoverage
} from "./contracts.js"
import { validateGraph, validateToolReferences } from "./graph.js"

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
export function validatePlan(plan: Plan, availableTools: readonly Tool[]): ValidationResult {
  const diagnostics: PlanDiagnostic[] = []

  diagnostics.push(...validateGraph(plan.steps, plan.edges))
  diagnostics.push(...validateToolReferences(plan.steps, availableTools))
  diagnostics.push(...validateStepContracts(plan.steps))
  diagnostics.push(...validateArtifactOwnership(plan.steps))
  diagnostics.push(...validateVerificationCoverage(plan.steps))
  diagnostics.push(...validatePathConsistency(plan.steps))
  diagnostics.push(...validateArtifactDependencyWiring(plan.steps))
  diagnostics.push(...validateVisualCompleteness(plan.steps))
  diagnostics.push(...validateSharedDataContract(plan.steps))

  return {
    valid: diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error).length === 0,
    diagnostics
  }
}

// ============================================================================
// Re-exported passes (extracted to validate/graph.ts and validate/contracts.ts)
// ============================================================================

export {
  validateArtifactOwnership,
  validateStepContracts,
  validateVerificationCoverage
} from "./contracts.js"
export { validateGraph, validateToolReferences } from "./graph.js"
