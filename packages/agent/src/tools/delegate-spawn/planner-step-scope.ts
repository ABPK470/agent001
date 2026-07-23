/**
 * Planner-step affiliation for concurrent subagent tool calls.
 *
 * Parallel children share the parent's governed tool wrappers. A single
 * `openStepId` in chat projection cannot attribute interleaved tool events.
 * This ALS scope is set around each child.run so governTool can stamp the
 * owning planner step on every tool Step / trace entry.
 */

import { AsyncLocalStorage } from "node:async_hooks"

const plannerStepScope = new AsyncLocalStorage<string>()

export function runWithPlannerStep<T>(stepName: string, fn: () => Promise<T>): Promise<T> {
  return plannerStepScope.run(stepName, fn)
}

export function currentPlannerStepName(): string | null {
  return plannerStepScope.getStore() ?? null
}
