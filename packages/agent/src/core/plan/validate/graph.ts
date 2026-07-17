import { DiagnosticCategory, DiagnosticSeverity } from "../../../domain/index.js"
/**
 * Plan graph + tool reference validation passes. Extracted from validate.ts.
 *
 * @module
 */

import type { Tool } from "../../types.js"
import type { DeterministicToolStep, PlanDiagnostic, PlanEdge, PlanStep } from "../types.js"

export function validateGraph(steps: readonly PlanStep[], edges: readonly PlanEdge[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const stepNames = new Set(steps.map((s) => s.name))

  const adj = new Map<string, string[]>()
  for (const name of stepNames) adj.set(name, [])
  for (const e of edges) {
    adj.get(e.from)?.push(e.to)
  }

  const WHITE = 0,
    GREY = 1,
    BLACK = 2
  const color = new Map<string, number>()
  for (const name of stepNames) color.set(name, WHITE)

  function dfs(node: string): boolean {
    color.set(node, GREY)
    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GREY) return true
      if (color.get(neighbor) === WHITE && dfs(neighbor)) return true
    }
    color.set(node, BLACK)
    return false
  }

  for (const name of stepNames) {
    if (color.get(name) === WHITE && dfs(name)) {
      diagnostics.push({
        category: DiagnosticCategory.Graph,
        severity: DiagnosticSeverity.Error,
        code: "cycle_detected",
        message: "Plan dependency graph contains a cycle. Remove circular dependencies between steps.",
        stepName: name
      })
      break
    }
  }

  for (const [name, neighbors] of adj) {
    if (neighbors.length > 8) {
      diagnostics.push({
        category: DiagnosticCategory.Graph,
        severity: DiagnosticSeverity.Warning,
        code: "excessive_fanout",
        message: `Step "${name}" has ${neighbors.length} outgoing edges. Reduce fanout to <=8 to keep the plan manageable.`,
        stepName: name
      })
    }
  }

  if (diagnostics.length === 0) {
    const depth = longestPath(stepNames, adj)
    if (depth > 10) {
      diagnostics.push({
        category: DiagnosticCategory.Graph,
        severity: DiagnosticSeverity.Warning,
        code: "excessive_depth",
        message: `Plan has critical path depth ${depth}. Reduce to <=10 by parallelizing independent work.`
      })
    }
  }

  if (steps.length > 15) {
    diagnostics.push({
      category: DiagnosticCategory.Graph,
      code: "too_many_steps",
      severity: DiagnosticSeverity.Warning,
      message: `Plan has ${steps.length} steps. Prefer 2-8 steps. Consolidate related work into fewer subagent tasks.`
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

export function validateToolReferences(
  steps: readonly PlanStep[],
  availableTools: readonly Tool[]
): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []
  const toolNames = new Set(availableTools.map((t) => t.name))

  for (const step of steps) {
    if (step.stepType === "deterministic_tool") {
      const dt = step as DeterministicToolStep
      if (!toolNames.has(dt.tool)) {
        diagnostics.push({
          category: DiagnosticCategory.Contract,
          severity: DiagnosticSeverity.Error,
          code: "unknown_tool",
          message: `Deterministic step "${step.name}" references tool "${dt.tool}" which is not available. Available tools: ${[...toolNames].join(", ")}`,
          stepName: step.name
        })
      }
    }
  }

  return diagnostics
}
