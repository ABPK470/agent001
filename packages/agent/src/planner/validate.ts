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
import type { DeterministicToolStep, Plan, PlanDiagnostic, PlanEdge, PlanStep, SubagentTaskStep } from "./types.js"

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

  return {
    valid: diagnostics.length === 0,
    diagnostics,
  }
}

// ============================================================================
// Graph validation — cycles, fanout, depth
// ============================================================================

function validateGraph(steps: readonly PlanStep[], edges: readonly PlanEdge[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const stepNames = new Set(steps.map(s => s.name))

  // Build adjacency
  const adj = new Map<string, string[]>()
  for (const name of stepNames) adj.set(name, [])
  for (const e of edges) {
    adj.get(e.from)?.push(e.to)
  }

  // Cycle detection via DFS coloring
  const WHITE = 0, GREY = 1, BLACK = 2
  const color = new Map<string, number>()
  for (const name of stepNames) color.set(name, WHITE)

  function dfs(node: string): boolean {
    color.set(node, GREY)
    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GREY) return true // back edge = cycle
      if (color.get(neighbor) === WHITE && dfs(neighbor)) return true
    }
    color.set(node, BLACK)
    return false
  }

  for (const name of stepNames) {
    if (color.get(name) === WHITE && dfs(name)) {
      diagnostics.push({
        category: "graph",
        code: "cycle_detected",
        message: "Plan dependency graph contains a cycle. Remove circular dependencies between steps.",
        stepName: name,
      })
      break // one cycle error is enough
    }
  }

  // Fanout — max outgoing edges from any node
  for (const [name, neighbors] of adj) {
    if (neighbors.length > 8) {
      diagnostics.push({
        category: "graph",
        code: "excessive_fanout",
        message: `Step "${name}" has ${neighbors.length} outgoing edges. Reduce fanout to <=8 to keep the plan manageable.`,
        stepName: name,
      })
    }
  }

  // Depth — longest path through the graph
  if (diagnostics.length === 0) { // skip if cycles exist
    const depth = longestPath(stepNames, adj)
    if (depth > 10) {
      diagnostics.push({
        category: "graph",
        code: "excessive_depth",
        message: `Plan has critical path depth ${depth}. Reduce to <=10 by parallelizing independent work.`,
      })
    }
  }

  // Step count warning
  if (steps.length > 15) {
    diagnostics.push({
      category: "graph",
      code: "too_many_steps",
      message: `Plan has ${steps.length} steps. Prefer 2-8 steps. Consolidate related work into fewer subagent tasks.`,
    })
  }

  return diagnostics
}

function longestPath(nodes: Set<string>, adj: Map<string, string[]>): number {
  const memo = new Map<string, number>()

  function dp(node: string): number {
    if (memo.has(node)) return memo.get(node)!
    let maxChild = 0
    for (const n of adj.get(node) ?? []) {
      maxChild = Math.max(maxChild, dp(n))
    }
    const result = 1 + maxChild
    memo.set(node, result)
    return result
  }

  let max = 0
  for (const n of nodes) max = Math.max(max, dp(n))
  return max
}

// ============================================================================
// Tool reference validation
// ============================================================================

function validateToolReferences(
  steps: readonly PlanStep[],
  availableTools: readonly Tool[],
): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const toolNames = new Set(availableTools.map(t => t.name))

  for (const step of steps) {
    if (step.stepType === "deterministic_tool") {
      const dt = step as DeterministicToolStep
      if (!toolNames.has(dt.tool)) {
        diagnostics.push({
          category: "contract",
          code: "unknown_tool",
          message: `Deterministic step "${step.name}" references tool "${dt.tool}" which is not available. Available tools: ${[...toolNames].join(", ")}`,
          stepName: step.name,
        })
      }
    }
  }

  return diagnostics
}

// ============================================================================
// Step contract validation
// ============================================================================

function validateStepContracts(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  for (const step of steps) {
    if (step.stepType === "subagent_task") {
      const sa = step as SubagentTaskStep

      if (!sa.objective || sa.objective.trim().length < 10) {
        diagnostics.push({
          category: "contract",
          code: "vague_objective",
          message: `Subagent step "${step.name}" has a vague or missing objective. Provide a specific, measurable objective (min 10 chars).`,
          stepName: step.name,
        })
      }

      if (sa.acceptanceCriteria.length === 0) {
        diagnostics.push({
          category: "contract",
          code: "missing_acceptance_criteria",
          message: `Subagent step "${step.name}" has no acceptance criteria. Add at least one measurable success condition.`,
          stepName: step.name,
        })
      }

      // Check for vague criteria
      for (const crit of sa.acceptanceCriteria) {
        if (crit.length < 10 || /^(done|works?|good|complete|ok)$/i.test(crit.trim())) {
          diagnostics.push({
            category: "contract",
            code: "vague_criteria",
            message: `Subagent step "${step.name}" has vague acceptance criterion: "${crit}". Be specific and measurable.`,
            stepName: step.name,
          })
        }
      }

      if (sa.requiredToolCapabilities.length === 0) {
        diagnostics.push({
          category: "contract",
          code: "no_tool_capabilities",
          message: `Subagent step "${step.name}" declares no required tool capabilities. Specify which tools the child needs.`,
          stepName: step.name,
        })
      }
    }
  }

  return diagnostics
}

// ============================================================================
// Artifact ownership validation
// ============================================================================

function validateArtifactOwnership(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  // Collect write_owner claims per artifact
  const writeOwners = new Map<string, string[]>()

  for (const step of steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const relations = [
      ...(sa.executionContext?.artifactRelations ?? []),
      ...(sa.workflowStep?.artifactRelations ?? []),
    ]
    for (const rel of relations) {
      if (rel.relationType === "write_owner") {
        const owners = writeOwners.get(rel.artifactPath) ?? []
        if (!owners.includes(step.name)) {
          owners.push(step.name)
        }
        writeOwners.set(rel.artifactPath, owners)
      }
    }
  }

  for (const [artifact, owners] of writeOwners) {
    if (owners.length > 1) {
      diagnostics.push({
        category: "ownership",
        code: "multiple_write_owners",
        message: `Artifact "${artifact}" has ${owners.length} write owners: [${owners.join(", ")}]. Only ONE step may be write_owner for a given artifact.`,
      })
    }
  }

  return diagnostics
}

// ============================================================================
// Verification coverage
// ============================================================================

function validateVerificationCoverage(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]

  // If there are write steps but no step with verification mode set, warn
  const hasWriters = subagentSteps.some(
    s => s.executionContext?.effectClass !== "readonly",
  )
  const hasVerification = subagentSteps.some(
    s => s.executionContext?.verificationMode !== "none",
  )

  if (hasWriters && !hasVerification && subagentSteps.length > 1) {
    diagnostics.push({
      category: "verification",
      code: "no_verification_steps",
      message: "Plan has write steps but no verification step. Add at least one step with verificationMode != 'none', or include a deterministic verification step.",
    })
  }

  return diagnostics
}

// ============================================================================
// Path consistency — all steps must use the same output directory
// ============================================================================

function validatePathConsistency(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]

  // Collect all target artifact directories
  const artifactDirs = new Map<string, string>() // dir → step name (first seen)
  const allDirs: string[] = []

  for (const step of subagentSteps) {
    for (const artifact of step.executionContext?.targetArtifacts ?? []) {
      const parts = artifact.split("/")
      if (parts.length > 1) {
        const dir = parts.slice(0, -1).join("/")
        allDirs.push(dir)
        if (!artifactDirs.has(dir)) {
          artifactDirs.set(dir, step.name)
        }
      }
    }
  }

  if (allDirs.length === 0) return diagnostics

  // Check if the same filename appears under different directories
  // e.g. "game/index.html" and "tmp/game/index.html" — this is a clear error
  const filesByName = new Map<string, string[]>()
  for (const step of subagentSteps) {
    for (const artifact of step.executionContext?.targetArtifacts ?? []) {
      const filename = artifact.split("/").pop()!
      if (!filesByName.has(filename)) filesByName.set(filename, [])
      filesByName.get(filename)!.push(artifact)
    }
  }

  for (const [filename, paths] of filesByName) {
    const uniquePaths = [...new Set(paths)]
    if (uniquePaths.length > 1) {
      // Same filename in different directories — likely a path inconsistency
      const dirs = uniquePaths.map(p => p.split("/").slice(0, -1).join("/") || "(root)")
      diagnostics.push({
        category: "graph",
        code: "inconsistent_output_directory",
        message: `File "${filename}" appears under different directories: ${dirs.join(", ")}. All steps MUST use the same output directory. Pick one directory and use it consistently for ALL targetArtifacts across all steps.`,
      })
    }
  }

  // Also check: if some artifacts have a directory prefix and others don't
  const hasDir = allDirs.length > 0
  const rootFiles = subagentSteps.flatMap(s =>
    (s.executionContext?.targetArtifacts ?? []).filter(a => !a.includes("/"))
  )
  if (hasDir && rootFiles.length > 0) {
    const commonDir = allDirs[0]
    diagnostics.push({
      category: "graph",
      code: "mixed_root_and_subdir",
      message: `Some artifacts are in subdirectory "${commonDir}/" but others (${rootFiles.join(", ")}) are at the root. Move all artifacts into the same directory.`,
    })
  }

  return diagnostics
}
