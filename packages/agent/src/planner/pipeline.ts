/**
 * Pipeline executor — execute a plan's steps in DAG-ordered fashion.
 *
 * Inspired by agenc-core's PipelineExecutor / SubAgentManager:
 *   1. Build adjacency from plan edges
 *   2. Topological sort to find execution order
 *   3. Execute ready steps (all dependencies satisfied)
 *   4. Parallel execution of independent steps when possible
 *   5. Retry on failure per step policy (onError)
 *   6. Collect PipelineStepResult per step
 *
 * Deterministic tool steps are executed inline.
 * Subagent task steps are delegated via the provided delegation function.
 *
 * @module
 */

import type { Tool } from "../types.js"
import type {
    DeterministicToolStep,
    ExecutionEnvelope,
    PipelineResult,
    PipelineStepResult,
    Plan,
    PlanStep,
    SubagentTaskStep,
} from "./types.js"

// ============================================================================
// Delegation function signature
// ============================================================================

/**
 * Function that spawns a child agent for a subagent_task step.
 * The pipeline executor doesn't know about Agent — it calls this abstraction.
 */
export type DelegateFn = (
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope,
) => Promise<string>

/**
 * Function that executes a deterministic tool call directly.
 */
export type ToolExecFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>

// ============================================================================
// Pipeline executor
// ============================================================================

export interface PipelineExecutorOptions {
  /** Maximum parallel steps. Default: 4 */
  maxParallel?: number
  /** Abort signal. */
  signal?: AbortSignal
  /** Called when a step starts. */
  onStepStart?: (step: PlanStep) => void
  /** Called when a step finishes. */
  onStepEnd?: (step: PlanStep, result: PipelineStepResult) => void
}

/**
 * Execute a plan's steps in dependency order.
 *
 * Returns a PipelineResult with per-step status.
 */
export async function executePipeline(
  plan: Plan,
  tools: readonly Tool[],
  delegateFn: DelegateFn,
  opts?: PipelineExecutorOptions,
): Promise<PipelineResult> {
  const maxParallel = opts?.maxParallel ?? 4
  const stepResults = new Map<string, PipelineStepResult>()

  // Build tool lookup
  const toolMap = new Map(tools.map(t => [t.name, t]))

  // Create a tool execution function from available tools
  const toolExecFn: ToolExecFn = async (toolName, args) => {
    const tool = toolMap.get(toolName)
    if (!tool) throw new Error(`Tool "${toolName}" not found`)
    return tool.execute(args)
  }

  // Build adjacency and in-degree
  const { adj, inDegree, stepMap } = buildGraph(plan)

  // BFS-style execution: process ready steps (in-degree 0)
  const completed = new Set<string>()
  const failed = new Set<string>()

  while (completed.size + failed.size < plan.steps.length) {
    if (opts?.signal?.aborted) {
      return buildResult(stepResults, plan.steps.length, "failed", "Pipeline aborted")
    }

    // Find ready steps: in-degree 0 and not yet processed
    const ready: string[] = []
    for (const [name, deg] of inDegree) {
      if (deg === 0 && !completed.has(name) && !failed.has(name) && !stepResults.has(name)) {
        ready.push(name)
      }
    }

    if (ready.length === 0) {
      // No progress possible — remaining steps have unsatisfied deps (due to failures upstream)
      // Mark them as skipped
      for (const step of plan.steps) {
        if (!stepResults.has(step.name)) {
          stepResults.set(step.name, {
            name: step.name,
            status: "skipped",
            error: "Upstream dependency failed",
            durationMs: 0,
          })
        }
      }
      break
    }

    // Execute ready steps — respecting parallelism
    const batch = ready.slice(0, maxParallel)
    const batchPromises = batch.map(async (name) => {
      const step = stepMap.get(name)!
      opts?.onStepStart?.(step)

      const result = await executeStep(step, toolExecFn, delegateFn, opts?.signal)
      stepResults.set(name, result)
      opts?.onStepEnd?.(step, result)

      if (result.status === "completed") {
        completed.add(name)
        // Decrement in-degree of downstream steps
        for (const downstream of adj.get(name) ?? []) {
          inDegree.set(downstream, (inDegree.get(downstream) ?? 1) - 1)
        }
      } else if (result.status === "failed") {
        const onError = step.stepType === "deterministic_tool"
          ? (step as DeterministicToolStep).onError ?? "retry"
          : "abort"

        if (onError === "skip") {
          // Treat as completed so downstream can proceed
          completed.add(name)
          for (const downstream of adj.get(name) ?? []) {
            inDegree.set(downstream, (inDegree.get(downstream) ?? 1) - 1)
          }
        } else if (onError === "abort") {
          failed.add(name)
          // Don't decrement downstream — they'll be skipped
        } else {
          // Already retried in executeStep — mark as failed
          failed.add(name)
        }
      }
    })

    await Promise.allSettled(batchPromises)
  }

  const anyFailed = [...stepResults.values()].some(r => r.status === "failed")
  return buildResult(
    stepResults,
    plan.steps.length,
    anyFailed ? "failed" : "completed",
  )
}

// ============================================================================
// Single step execution (with retry)
// ============================================================================

async function executeStep(
  step: PlanStep,
  toolExecFn: ToolExecFn,
  delegateFn: DelegateFn,
  signal?: AbortSignal,
): Promise<PipelineStepResult> {
  const t0 = Date.now()

  if (step.stepType === "deterministic_tool") {
    return executeDeterministicStep(step, toolExecFn, t0, signal)
  } else {
    return executeSubagentStep(step, delegateFn, t0, signal)
  }
}

async function executeDeterministicStep(
  step: DeterministicToolStep,
  toolExecFn: ToolExecFn,
  t0: number,
  signal?: AbortSignal,
): Promise<PipelineStepResult> {
  const maxRetries = step.maxRetries ?? 2
  let lastError: string | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return { name: step.name, status: "failed", error: "Aborted", durationMs: Date.now() - t0 }
    }

    try {
      const output = await toolExecFn(step.tool, step.args)

      // Check if the output indicates an error
      if (output.startsWith("Error:")) {
        lastError = output
        continue
      }

      return {
        name: step.name,
        status: "completed",
        output,
        durationMs: Date.now() - t0,
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  return {
    name: step.name,
    status: "failed",
    error: lastError ?? "Unknown error",
    durationMs: Date.now() - t0,
  }
}

async function executeSubagentStep(
  step: SubagentTaskStep,
  delegateFn: DelegateFn,
  t0: number,
  signal?: AbortSignal,
): Promise<PipelineStepResult> {
  if (signal?.aborted) {
    return { name: step.name, status: "failed", error: "Aborted", durationMs: Date.now() - t0 }
  }

  try {
    const output = await delegateFn(step, step.executionContext)

    // Check for delegation failure markers
    if (output.startsWith("Delegation failed:") || output.includes("DELEGATION INCOMPLETE")) {
      return {
        name: step.name,
        status: "failed",
        error: output,
        durationMs: Date.now() - t0,
      }
    }

    return {
      name: step.name,
      status: "completed",
      output,
      durationMs: Date.now() - t0,
    }
  } catch (err) {
    return {
      name: step.name,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    }
  }
}

// ============================================================================
// Graph helpers
// ============================================================================

interface Graph {
  adj: Map<string, string[]>
  inDegree: Map<string, number>
  stepMap: Map<string, PlanStep>
}

function buildGraph(plan: Plan): Graph {
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

function buildResult(
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
