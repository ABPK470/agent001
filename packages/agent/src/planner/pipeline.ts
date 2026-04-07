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
  /** Actual workspace root (overrides LLM-generated workspaceRoot in envelopes). */
  workspaceRoot?: string
  /** Called when a step starts. */
  onStepStart?: (step: PlanStep) => void
  /** Called when a step finishes. */
  onStepEnd?: (step: PlanStep, result: PipelineStepResult) => void
  /** Steps that passed verification — reuse their results instead of re-running. */
  priorResults?: ReadonlyMap<string, PipelineStepResult>
  /** Per-step feedback from verifier to inject into retry attempts. */
  retryFeedback?: ReadonlyMap<string, readonly string[]>
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

  // Seed with prior results (verified-pass steps from a previous attempt)
  const completed = new Set<string>()
  const failed = new Set<string>()
  if (opts?.priorResults) {
    for (const [name, prior] of opts.priorResults) {
      if (prior.status === "completed" && stepMap.has(name)) {
        stepResults.set(name, prior)
        completed.add(name)
        // Decrement in-degree of downstream
        for (const downstream of adj.get(name) ?? []) {
          inDegree.set(downstream, (inDegree.get(downstream) ?? 1) - 1)
        }
      }
    }
  }

  // BFS-style execution: process ready steps (in-degree 0)
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

      // Build context from completed dependency steps so children know
      // what prior steps produced (files, outputs, etc.)
      let effectiveStep = step
      if (step.stepType === "subagent_task") {
        effectiveStep = injectPriorContext(step as SubagentTaskStep, plan, stepResults, opts?.workspaceRoot)
      }

      // Inject verifier feedback into subagent steps on retry
      const feedback = opts?.retryFeedback?.get(name)
      if (feedback && feedback.length > 0 && effectiveStep.stepType === "subagent_task") {
        const sa = effectiveStep as SubagentTaskStep
        effectiveStep = {
          ...sa,
          objective: `${sa.objective}\n\n[RETRY — fix these issues from the previous attempt]:\n${feedback.map(f => `- ${f}`).join("\n")}`,
        }
      }

      const result = await executeStep(effectiveStep, toolExecFn, delegateFn, opts?.signal)
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
// Prior step context injection
// ============================================================================

/**
 * Augment a subagent step with concrete context from completed dependency steps.
 *
 * This solves the "blind child" problem: without this, step N+1 has no idea
 * what step N actually produced. We inject:
 *   1. Output summaries from completed dependency steps
 *   2. Workspace root override (use actual value, not LLM-generated)
 *   3. A "ground truth" preamble about what files/artifacts already exist
 */
function injectPriorContext(
  step: SubagentTaskStep,
  plan: Plan,
  stepResults: ReadonlyMap<string, PipelineStepResult>,
  workspaceRoot?: string,
): SubagentTaskStep {
  const deps = step.dependsOn ?? []
  if (deps.length === 0 && !workspaceRoot) return step

  const priorSections: string[] = []

  // Collect outputs from completed dependency steps
  for (const depName of deps) {
    const depResult = stepResults.get(depName)
    if (!depResult) continue

    const depStep = plan.steps.find(s => s.name === depName)
    const summary = depResult.output
      ? depResult.output.slice(0, 500)
      : `(step ${depResult.status})`

    priorSections.push(
      `### Step "${depName}" (${depResult.status})${depStep?.stepType === "deterministic_tool" ? ` — tool: ${(depStep as DeterministicToolStep).tool}` : ""}\n${summary}`,
    )
  }

  // Build augmented inputContract with prior context
  let augmentedInput = step.inputContract || ""
  if (priorSections.length > 0) {
    augmentedInput = `## Context from completed prior steps\n\n${priorSections.join("\n\n")}\n\n${augmentedInput}`
  }

  // Override workspaceRoot in execution context with actual value
  let executionContext = step.executionContext
  if (workspaceRoot) {
    executionContext = {
      ...executionContext,
      workspaceRoot,
      allowedReadRoots: executionContext.allowedReadRoots.length > 0
        ? executionContext.allowedReadRoots
        : [workspaceRoot],
      allowedWriteRoots: executionContext.allowedWriteRoots.length > 0
        ? executionContext.allowedWriteRoots
        : [workspaceRoot],
    }
  }

  // Augment objective with a filesystem grounding reminder
  let objective = step.objective
  if (priorSections.length > 0) {
    // Collect target artifacts from dependency steps (what they should have created)
    const priorArtifacts: string[] = []
    for (const depName of deps) {
      const depStep = plan.steps.find(s => s.name === depName)
      if (depStep?.stepType === "subagent_task") {
        const sa = depStep as SubagentTaskStep
        priorArtifacts.push(...sa.executionContext.targetArtifacts)
      }
    }
    if (priorArtifacts.length > 0) {
      objective = `${objective}\n\nIMPORTANT: Prior steps should have created these files: ${priorArtifacts.join(", ")}. Start by reading them with read_file to verify they exist and understand their contents before making changes.`
    }
  }

  return {
    ...step,
    objective,
    inputContract: augmentedInput,
    executionContext,
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
