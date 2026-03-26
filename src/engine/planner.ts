/**
 * Planner — converts a WorkflowDefinition into runtime Steps.
 *
 * Performs topological sort on `dependsOn` to compute execution order.
 * This is a generic graph planner — it works with any workflow definition.
 */

import { randomUUID } from "node:crypto"
import { StepStatus } from "../domain/enums.js"
import { DomainError } from "../domain/errors.js"
import type { Step, Workflow } from "../domain/models.js"
import type { StepDefinition } from "../domain/workflow-schema.js"

export function planSteps(
  workflow: Workflow,
  _input: Record<string, unknown>,
): Step[] {
  const defs = workflow.definition.steps
  const sorted = topologicalSort(defs)

  return sorted.map((def, idx) => ({
    id: randomUUID(),
    definitionId: def.id,
    name: def.name,
    action: def.action,
    input: { ...def.input }, // shallow copy; expressions resolved at runtime
    condition: def.condition ?? null,
    onError: def.onError ?? ("fail" as const),
    status: StepStatus.Pending,
    order: idx,
    output: {},
    error: null,
    startedAt: null,
    completedAt: null,
  }))
}

/** Kahn's algorithm. Throws on cycles. */
function topologicalSort(steps: StepDefinition[]): StepDefinition[] {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()

  for (const s of steps) {
    inDegree.set(s.id, 0)
    adj.set(s.id, [])
  }

  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new DomainError(`Step '${s.id}' depends on unknown step '${dep}'`)
      }
      adj.get(dep)!.push(s.id)
      inDegree.set(s.id, (inDegree.get(s.id) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  const result: StepDefinition[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    result.push(byId.get(id)!)
    for (const next of adj.get(id) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1
      inDegree.set(next, newDeg)
      if (newDeg === 0) queue.push(next)
    }
  }

  if (result.length !== steps.length) {
    throw new DomainError("Workflow has circular step dependencies")
  }

  return result
}
