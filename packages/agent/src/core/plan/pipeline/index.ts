import { PipelineStatus } from "../../../domain/index.js"
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
 * Scheduling is slot-based: when any in-flight step settles, newly ready
 * peers start immediately up to maxParallel. Waiting for an entire batch
 * (Promise.allSettled) would strand step N+1 behind a long peer in the
 * first wave — e.g. three fast deterministic tools + one slow subagent
 * would block a fifth ready subagent until that slow peer finished.
 *
 * @module
 */

import type { Tool } from "../../types.js"
import { injectPriorContext } from "../internal/pipeline-context.js"
import {
  applyPostExecutionReconciliation,
  collectAcceptedArtifacts,
  collectRunnableUpstreamArtifacts,
  getRepairTaskForStep,
  getUnresolvedAcceptanceBlockers
} from "../internal/pipeline-repair.js"
import { executeStep } from "../internal/pipeline-steps.js"
import { compilePlannerRuntime } from "../runtime-model.js"
import type {
  DeterministicToolStep,
  PipelineResult,
  PipelineStepResult,
  Plan,
  PlanStep,
  PlannerRuntimeModel,
  RepairPlan,
  SubagentTaskStep
} from "../types.js"
import type { DelegateFn } from "../../../domain/types/planner-delegate.js"
import { buildGraph, buildResult, executeToolForText } from "./graph.js"
import { buildRepairStep } from "./repair-step.js"

// Re-exports for backwards compatibility
export { isGibberishIssue } from "../pipeline-validation/index.js"

// ============================================================================
// Delegation function signature
// ============================================================================

export type { DelegateFn, DelegateResult } from "../../../domain/types/planner-delegate.js"

export type ToolExecFn = (toolName: string, args: Record<string, unknown>) => Promise<string>

// ============================================================================
// Pipeline executor options
// ============================================================================

export interface PipelineExecutorOptions {
  maxParallel?: number
  signal?: AbortSignal
  workspaceRoot?: string
  onStepStart?: (step: PlanStep) => void
  onStepEnd?: (step: PlanStep, result: PipelineStepResult) => void
  priorResults?: ReadonlyMap<string, PipelineStepResult>
  repairPlan?: RepairPlan
  runtimeModel?: PlannerRuntimeModel
}

// ============================================================================
// Ready-set + outcome helpers (flat peers)
// ============================================================================

function collectReadyStepNames(opts: {
  inDegree: Map<string, number>
  completed: ReadonlySet<string>
  failed: ReadonlySet<string>
  stepResults: ReadonlyMap<string, PipelineStepResult>
  inFlight: ReadonlySet<string>
  runtimeModel: PlannerRuntimeModel
  repairPlan: RepairPlan | undefined
  priorResults: ReadonlyMap<string, PipelineStepResult> | undefined
}): string[] {
  const acceptedArtifacts = collectAcceptedArtifacts(
    opts.priorResults,
    opts.stepResults,
    opts.runtimeModel
  )
  const runnableArtifacts = collectRunnableUpstreamArtifacts(
    opts.priorResults,
    opts.stepResults,
    opts.runtimeModel
  )

  const ready: string[] = []
  for (const [name, deg] of opts.inDegree) {
    if (
      deg !== 0 ||
      opts.completed.has(name) ||
      opts.failed.has(name) ||
      opts.stepResults.has(name) ||
      opts.inFlight.has(name)
    ) {
      continue
    }
    const repairTask = getRepairTaskForStep(opts.repairPlan, name)
    const blockers = getUnresolvedAcceptanceBlockers(
      name,
      opts.runtimeModel,
      repairTask,
      acceptedArtifacts,
      runnableArtifacts
    )
    if (blockers.length === 0) ready.push(name)
  }
  return ready
}

function markBlockedRemainders(opts: {
  plan: Plan
  stepResults: Map<string, PipelineStepResult>
  runtimeModel: PlannerRuntimeModel
  repairPlan: RepairPlan | undefined
  priorResults: ReadonlyMap<string, PipelineStepResult> | undefined
}): void {
  const acceptedArtifacts = collectAcceptedArtifacts(
    opts.priorResults,
    opts.stepResults,
    opts.runtimeModel
  )
  const runnableArtifacts = collectRunnableUpstreamArtifacts(
    opts.priorResults,
    opts.stepResults,
    opts.runtimeModel
  )
  for (const step of opts.plan.steps) {
    if (opts.stepResults.has(step.name)) continue
    const repairTask = getRepairTaskForStep(opts.repairPlan, step.name)
    const blockers = getUnresolvedAcceptanceBlockers(
      step.name,
      opts.runtimeModel,
      repairTask,
      acceptedArtifacts,
      runnableArtifacts
    )
    opts.stepResults.set(step.name, {
      name: step.name,
      status: "skipped",
      executionState: "skipped",
      acceptanceState: "blocked",
      error:
        blockers.length > 0
          ? `Waiting on accepted upstream artifacts: ${blockers.join(", ")}`
          : "Upstream dependency failed",
      durationMs: 0
    })
  }
}

function applyStepOutcome(opts: {
  step: PlanStep
  finalResult: PipelineStepResult
  plan: Plan
  adj: Map<string, string[]>
  inDegree: Map<string, number>
  completed: Set<string>
  failed: Set<string>
  stepResults: Map<string, PipelineStepResult>
}): void {
  const { step, finalResult, plan, adj, inDegree, completed, failed, stepResults } = opts

  if (finalResult.status === PipelineStatus.Completed) {
    completed.add(step.name)
    for (const downstream of adj.get(step.name) ?? []) {
      inDegree.set(downstream, (inDegree.get(downstream) ?? 1) - 1)
    }
    return
  }

  if (finalResult.status !== PipelineStatus.Failed) return

  const onError =
    step.stepType === "deterministic_tool"
      ? ((step as DeterministicToolStep).onError ?? "retry")
      : "abort"

  if (onError === "skip") {
    completed.add(step.name)
    for (const downstream of adj.get(step.name) ?? []) {
      inDegree.set(downstream, (inDegree.get(downstream) ?? 1) - 1)
    }
    return
  }

  if (onError === "abort") {
    failed.add(step.name)
    for (const s of plan.steps) {
      if (!stepResults.has(s.name)) {
        stepResults.set(s.name, {
          name: s.name,
          status: "skipped",
          executionState: "skipped",
          acceptanceState: "blocked",
          error: `Pipeline aborted: step "${step.name}" failed`,
          durationMs: 0
        })
        failed.add(s.name)
      }
    }
    return
  }

  failed.add(step.name)
}

async function executeNamedStep(opts: {
  name: string
  stepMap: Map<string, PlanStep>
  plan: Plan
  toolExecFn: ToolExecFn
  delegateFn: DelegateFn
  toolMap: Map<string, Tool>
  stepResults: Map<string, PipelineStepResult>
  runtimeModel: PlannerRuntimeModel
  knownProjectArtifacts: string[]
  pipelineOpts: PipelineExecutorOptions | undefined
}): Promise<{ step: PlanStep; finalResult: PipelineStepResult }> {
  const step = opts.stepMap.get(opts.name)!
  opts.pipelineOpts?.onStepStart?.(step)

  const acceptedArtifacts = collectAcceptedArtifacts(
    opts.pipelineOpts?.priorResults,
    opts.stepResults,
    opts.runtimeModel
  )
  const runnableArtifacts = collectRunnableUpstreamArtifacts(
    opts.pipelineOpts?.priorResults,
    opts.stepResults,
    opts.runtimeModel
  )

  let effectiveStep = step
  if (step.stepType === "subagent_task") {
    effectiveStep = injectPriorContext(
      step as SubagentTaskStep,
      opts.plan,
      opts.stepResults,
      opts.pipelineOpts?.workspaceRoot
    )
  }

  const repairTask = opts.pipelineOpts?.repairPlan?.tasks.find((task) => task.stepName === opts.name)
  if (repairTask && effectiveStep.stepType === "subagent_task") {
    effectiveStep = buildRepairStep(
      effectiveStep as SubagentTaskStep,
      opts.name,
      repairTask,
      opts.runtimeModel,
      acceptedArtifacts,
      opts.toolMap,
      opts.plan,
      opts.pipelineOpts,
      runnableArtifacts
    )
  }

  const result = await executeStep(
    effectiveStep,
    opts.toolExecFn,
    opts.delegateFn,
    opts.pipelineOpts?.signal,
    {
      plan: opts.plan,
      readFileTool: opts.toolMap.get("read_file"),
      workspaceRoot: opts.pipelineOpts?.workspaceRoot,
      knownProjectArtifacts: opts.knownProjectArtifacts
    }
  )

  const finalResult =
    effectiveStep.stepType === "subagent_task"
      ? applyPostExecutionReconciliation(effectiveStep as SubagentTaskStep, result)
      : result

  return { step, finalResult }
}

type PipelineRunState = {
  plan: Plan
  adj: Map<string, string[]>
  inDegree: Map<string, number>
  stepMap: Map<string, PlanStep>
  toolMap: Map<string, Tool>
  toolExecFn: ToolExecFn
  delegateFn: DelegateFn
  stepResults: Map<string, PipelineStepResult>
  runtimeModel: PlannerRuntimeModel
  knownProjectArtifacts: string[]
  completed: Set<string>
  failed: Set<string>
  inFlight: Map<string, Promise<void>>
  pipelineOpts: PipelineExecutorOptions | undefined
}

async function settleNamedStep(state: PipelineRunState, name: string): Promise<void> {
  const { step, finalResult } = await executeNamedStep({
    name,
    stepMap: state.stepMap,
    plan: state.plan,
    toolExecFn: state.toolExecFn,
    delegateFn: state.delegateFn,
    toolMap: state.toolMap,
    stepResults: state.stepResults,
    runtimeModel: state.runtimeModel,
    knownProjectArtifacts: state.knownProjectArtifacts,
    pipelineOpts: state.pipelineOpts
  })
  state.stepResults.set(name, finalResult)
  state.pipelineOpts?.onStepEnd?.(step, finalResult)
  applyStepOutcome({
    step,
    finalResult,
    plan: state.plan,
    adj: state.adj,
    inDegree: state.inDegree,
    completed: state.completed,
    failed: state.failed,
    stepResults: state.stepResults
  })
}

function launchReadySteps(state: PipelineRunState, maxParallel: number): void {
  const ready = collectReadyStepNames({
    inDegree: state.inDegree,
    completed: state.completed,
    failed: state.failed,
    stepResults: state.stepResults,
    inFlight: new Set(state.inFlight.keys()),
    runtimeModel: state.runtimeModel,
    repairPlan: state.pipelineOpts?.repairPlan,
    priorResults: state.pipelineOpts?.priorResults
  })

  for (const name of ready) {
    if (state.inFlight.size >= maxParallel) break
    const tracked = settleNamedStep(state, name).finally(() => {
      state.inFlight.delete(name)
    })
    state.inFlight.set(name, tracked)
  }
}

// ============================================================================
// Pipeline executor
// ============================================================================

export async function executePipeline(
  plan: Plan,
  tools: readonly Tool[],
  delegateFn: DelegateFn,
  opts?: PipelineExecutorOptions
): Promise<PipelineResult> {
  const maxParallel = opts?.maxParallel ?? 4
  const stepResults = new Map<string, PipelineStepResult>()
  const runtimeModel = opts?.runtimeModel ?? compilePlannerRuntime(plan)
  const knownProjectArtifacts = plan.steps
    .filter((s): s is SubagentTaskStep => s.stepType === "subagent_task")
    .flatMap((s) => s.executionContext.targetArtifacts)

  const toolMap = new Map(tools.map((t) => [t.name, t]))

  const toolExecFn: ToolExecFn = async (toolName, args) => {
    const tool = toolMap.get(toolName)
    if (!tool) throw new Error(`Tool "${toolName}" not found`)
    return executeToolForText(tool, args)
  }

  const { adj, inDegree, stepMap } = buildGraph(plan)

  const completed = new Set<string>()
  const failed = new Set<string>()
  if (opts?.priorResults) {
    for (const [name, prior] of opts.priorResults) {
      if (prior.status === PipelineStatus.Completed && stepMap.has(name)) {
        stepResults.set(name, prior)
        completed.add(name)
        for (const downstream of adj.get(name) ?? []) {
          inDegree.set(downstream, (inDegree.get(downstream) ?? 1) - 1)
        }
      }
    }
  }

  const state: PipelineRunState = {
    plan,
    adj,
    inDegree,
    stepMap,
    toolMap,
    toolExecFn,
    delegateFn,
    stepResults,
    runtimeModel,
    knownProjectArtifacts,
    completed,
    failed,
    inFlight: new Map(),
    pipelineOpts: opts
  }

  while (completed.size + failed.size < plan.steps.length) {
    if (opts?.signal?.aborted) {
      return buildResult(stepResults, plan.steps.length, PipelineStatus.Failed, "Pipeline aborted")
    }

    launchReadySteps(state, maxParallel)

    if (state.inFlight.size === 0) {
      markBlockedRemainders({
        plan,
        stepResults,
        runtimeModel,
        repairPlan: opts?.repairPlan,
        priorResults: opts?.priorResults
      })
      break
    }

    await Promise.race(state.inFlight.values())
  }

  if (state.inFlight.size > 0) {
    await Promise.allSettled([...state.inFlight.values()])
  }

  const anyFailed = [...stepResults.values()].some((r) => r.status === PipelineStatus.Failed)
  return buildResult(
    stepResults,
    plan.steps.length,
    anyFailed ? PipelineStatus.Failed : PipelineStatus.Completed
  )
}

// ============================================================================
// Repair step builder is in pipeline/repair-step.ts
// ============================================================================
