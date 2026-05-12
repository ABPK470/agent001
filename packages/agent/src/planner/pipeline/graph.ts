/**
 * Pipeline graph helpers — adjacency/in-degree DAG construction and
 * result summarisation extracted from pipeline.ts.
 *
 * @module
 */

import { normalizeToolExecutionOutput } from "../../tool-helpers/tool-utils.js"
import type { Tool } from "../../types.js"
import type {
    PipelineResult,
    PipelineStepResult,
    Plan,
    PlanStep,
} from "../types.js"

export interface Graph {
  adj: Map<string, string[]>
  inDegree: Map<string, number>
  stepMap: Map<string, PlanStep>
}

export function buildGraph(plan: Plan): Graph {
  const adj = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  const stepMap = new Map<string, PlanStep>()

  for (const step of plan.steps) {
    adj.set(step.name, [])
    inDegree.set(step.name, 0)
    stepMap.set(step.name, step)
  }

  for (const edge of plan.edges) {
    adj.get(edge.from)?.push(edge.to)
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
  }

  return { adj, inDegree, stepMap }
}

export function buildResult(
  stepResults: Map<string, PipelineStepResult>,
  totalSteps: number,
  status: "running" | "completed" | "failed",
  error?: string,
): PipelineResult {
  const completedSteps = [...stepResults.values()].filter(r => r.status === "completed").length
  return {
    status,
    stepResults,
    completedSteps,
    totalSteps,
    error,
  }
}

export async function executeToolForText(tool: Tool, args: Record<string, unknown>): Promise<string> {
  return normalizeToolExecutionOutput(await tool.execute(args)).result
}
