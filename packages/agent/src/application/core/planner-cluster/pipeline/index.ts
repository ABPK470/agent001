import { PipelineStatus } from "../../domain/index.js"
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

import type { ToolCallRecord } from "../../../../recovery/index.js"
import type { Tool } from "../../types.js"
import { injectPriorContext } from "../internal/pipeline-context.js"
import {
    applyPostExecutionReconciliation,
    collectAcceptedArtifacts,
    getRepairTaskForStep,
    getUnresolvedAcceptanceBlockers,
} from "../internal/pipeline-repair.js"
import { executeStep } from "../internal/pipeline-steps.js"
import { compilePlannerRuntime } from "../runtime-model.js"
import type {
    ChildExecutionResult,
    DeterministicToolStep,
    ExecutionEnvelope,
    PipelineResult,
    PipelineStepResult,
    Plan,
    PlanStep,
    PlannerRuntimeModel,
    RepairPlan,
    SubagentTaskStep,
} from "../types.js"
import { buildGraph, buildResult, executeToolForText } from "./graph.js"
import { buildRepairStep } from "./repair-step.js"

// Re-exports for backwards compatibility
export { isGibberishIssue } from "../pipeline-validation/index.js"

// ============================================================================
// Delegation function signature
// ============================================================================

export interface DelegateResult {
  readonly output: string
  readonly toolCalls?: readonly ToolCallRecord[]
  readonly execution?: ChildExecutionResult
}

export type DelegateFn = (
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope,
) => Promise<DelegateResult>

export type ToolExecFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>

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
// Graph helpers
// ============================================================================

// ============================================================================
// Graph + tool execution helpers live in pipeline/graph.ts
// ============================================================================

// ============================================================================
// Pipeline executor
// ============================================================================

export async function executePipeline(
  plan: Plan,
  tools: readonly Tool[],
  delegateFn: DelegateFn,
  opts?: PipelineExecutorOptions,
): Promise<PipelineResult> {
  const maxParallel = opts?.maxParallel ?? 4
  const stepResults = new Map<string, PipelineStepResult>()
  const runtimeModel = opts?.runtimeModel ?? compilePlannerRuntime(plan)
  const knownProjectArtifacts = plan.steps
    .filter((s): s is SubagentTaskStep => s.stepType === "subagent_task")
    .flatMap((s) => s.executionContext.targetArtifacts)

  const toolMap = new Map(tools.map(t => [t.name, t]))

  const toolExecFn: ToolExecFn = async (toolName, args) => {
    const tool = toolMap.get(toolName)
    if (!tool) throw new Error(`Tool "${toolName}" not found`)
    return executeToolForText(tool, args)
  }

  const { adj, inDegree, stepMap } = buildGraph(plan)

  // Seed with prior results
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

  // BFS-style execution
  while (completed.size + failed.size < plan.steps.length) {
    if (opts?.signal?.aborted) {
      return buildResult(stepResults, plan.steps.length, PipelineStatus.Failed, "Pipeline aborted")
    }

    const acceptedArtifacts = collectAcceptedArtifacts(opts?.priorResults, stepResults)

    const ready: string[] = []
    for (const [name, deg] of inDegree) {
      if (deg === 0 && !completed.has(name) && !failed.has(name) && !stepResults.has(name)) {
        const repairTask = getRepairTaskForStep(opts?.repairPlan, name)
        const blockers = getUnresolvedAcceptanceBlockers(name, runtimeModel, repairTask, acceptedArtifacts)
        if (blockers.length === 0) {
          ready.push(name)
        }
      }
    }

    if (ready.length === 0) {
      for (const step of plan.steps) {
        if (!stepResults.has(step.name)) {
          const repairTask = getRepairTaskForStep(opts?.repairPlan, step.name)
          const blockers = getUnresolvedAcceptanceBlockers(step.name, runtimeModel, repairTask, acceptedArtifacts)
          stepResults.set(step.name, {
            name: step.name,
            status: "skipped",
            executionState: "skipped",
            acceptanceState: "blocked",
            error: blockers.length > 0
              ? `Waiting on accepted upstream artifacts: ${blockers.join(", ")}`
              : "Upstream dependency failed",
            durationMs: 0,
          })
        }
      }
      break
    }

    const batch = ready.slice(0, maxParallel)
    const batchPromises = batch.map(async (name) => {
      const step = stepMap.get(name)!
      opts?.onStepStart?.(step)

      let effectiveStep = step
      if (step.stepType === "subagent_task") {
        effectiveStep = injectPriorContext(step as SubagentTaskStep, plan, stepResults, opts?.workspaceRoot)
      }

      // Inject verifier feedback into subagent steps on retry
      const repairTask = opts?.repairPlan?.tasks.find((task) => task.stepName === name)
      if (repairTask && effectiveStep.stepType === "subagent_task") {
        effectiveStep = buildRepairStep(
          effectiveStep as SubagentTaskStep,
          name,
          repairTask,
          runtimeModel,
          acceptedArtifacts,
          toolMap,
          plan,
          opts,
        )
      }

      const result = await executeStep(
        effectiveStep,
        toolExecFn,
        delegateFn,
        opts?.signal,
        {
          plan,
          readFileTool: toolMap.get("read_file"),
          workspaceRoot: opts?.workspaceRoot,
          knownProjectArtifacts,
        },
      )

      const finalResult = effectiveStep.stepType === "subagent_task"
        ? applyPostExecutionReconciliation(effectiveStep as SubagentTaskStep, result)
        : result

      stepResults.set(name, finalResult)
      opts?.onStepEnd?.(step, finalResult)

      if (finalResult.status === PipelineStatus.Completed) {
        completed.add(name)
        for (const downstream of adj.get(name) ?? []) {
          inDegree.set(downstream, (inDegree.get(downstream) ?? 1) - 1)
        }
      } else if (finalResult.status === PipelineStatus.Failed) {
        const onError = step.stepType === "deterministic_tool"
          ? (step as DeterministicToolStep).onError ?? "retry"
          : "abort"

        if (onError === "skip") {
          completed.add(name)
          for (const downstream of adj.get(name) ?? []) {
            inDegree.set(downstream, (inDegree.get(downstream) ?? 1) - 1)
          }
        } else if (onError === "abort") {
          failed.add(name)
          for (const s of plan.steps) {
            if (!stepResults.has(s.name)) {
              stepResults.set(s.name, {
                name: s.name,
                status: "skipped",
                executionState: "skipped",
                acceptanceState: "blocked",
                error: `Pipeline aborted: step "${name}" failed`,
                durationMs: 0,
              })
              failed.add(s.name)
            }
          }
        } else {
          failed.add(name)
        }
      }
    })

    await Promise.allSettled(batchPromises)
  }

  const anyFailed = [...stepResults.values()].some(r => r.status === PipelineStatus.Failed)
  return buildResult(
    stepResults,
    plan.steps.length,
    anyFailed ? PipelineStatus.Failed : PipelineStatus.Completed,
  )
}

// ============================================================================
// Repair step builder is in pipeline/repair-step.ts
// ============================================================================

