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

import type { ToolCallRecord } from "../recovery.js"
import type { Tool } from "../types.js"
import { compilePlannerRuntime } from "./runtime-model.js"
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
} from "./types.js"
import { buildChildRepairPayload } from "./verification-model.js"
import {
    applyPostExecutionReconciliation,
    buildAutonomousRepairBlock,
    buildBlueprintRetryGuidance,
    collectAcceptedArtifacts,
    getRepairTaskForStep,
    getUnresolvedAcceptanceBlockers,
    isBlueprintLikeStep,
    summarizeRepairTask,
} from "./pipeline-repair.js"
import { injectPriorContext } from "./pipeline-context.js"
import { executeStep } from "./pipeline-steps.js"
import { isGibberishIssue } from "./pipeline-validation.js"

// Re-exports for backwards compatibility
export { isGibberishIssue } from "./pipeline-validation.js"

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

// ============================================================================
// Tool execution helper
// ============================================================================

import { normalizeToolExecutionOutput } from "../tool-utils.js"

async function executeToolForText(tool: Tool, args: Record<string, unknown>): Promise<string> {
  return normalizeToolExecutionOutput(await tool.execute(args)).result
}

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
      if (prior.status === "completed" && stepMap.has(name)) {
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
      return buildResult(stepResults, plan.steps.length, "failed", "Pipeline aborted")
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

      if (finalResult.status === "completed") {
        completed.add(name)
        for (const downstream of adj.get(name) ?? []) {
          inDegree.set(downstream, (inDegree.get(downstream) ?? 1) - 1)
        }
      } else if (finalResult.status === "failed") {
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

  const anyFailed = [...stepResults.values()].some(r => r.status === "failed")
  return buildResult(
    stepResults,
    plan.steps.length,
    anyFailed ? "failed" : "completed",
  )
}

// ============================================================================
// Repair step builder (retry injection)
// ============================================================================

function buildRepairStep(
  sa: SubagentTaskStep,
  name: string,
  repairTask: NonNullable<RepairPlan["tasks"][number]>,
  runtimeModel: PlannerRuntimeModel,
  acceptedArtifacts: ReadonlySet<string>,
  toolMap: Map<string, Tool>,
  plan: Plan,
  opts?: PipelineExecutorOptions,
): SubagentTaskStep {
  const typedFeedback = summarizeRepairTask(repairTask)
  const primaryFeedback = typedFeedback.primary.filter((issue) => !isGibberishIssue(issue))
  const referenceFeedback = typedFeedback.reference.filter((issue) => !isGibberishIssue(issue))
  const priorStep = opts?.priorResults?.get(name)
  const priorReplaceMisses = (priorStep?.toolCalls ?? []).filter(
    c => c.name === "replace_in_file" && /old_string not found/i.test(c.result),
  ).length
  const avoidReplaceInFile = priorReplaceMisses >= 2

  const existingSource = new Set(sa.executionContext.requiredSourceArtifacts)
  for (const artifact of sa.executionContext.targetArtifacts) {
    existingSource.add(artifact)
  }

  const hasStubIssues = primaryFeedback.some(f =>
    /stub|placeholder|empty array|empty object|returns constant|catch-all|trivial return|degeneration/i.test(f),
  )
  const stubRemediationBlock = hasStubIssues
    ? `\n\n⚠️ STUB FUNCTION REMEDIATION — THIS IS YOUR PRIMARY TASK:\nThe verifier detected functions that are stubs or contain degeneration comments (e.g. "// Other code as per existing logic", "// rest of the code here", "// same as above"). These comments mean NO CODE WAS ACTUALLY WRITTEN — the function body is empty/incomplete.\nFor EACH stub/degenerated function you MUST:\n1. Read the file that contains it\n2. Locate the function by name\n3. Replace the stub body with a REAL, COMPLETE algorithm — DO NOT use comments like "existing logic" or "same as above"\n4. The function NAME tells you WHAT it must do — implement the FULL algorithm. Example: "getLegalMoves" must compute legal moves for ALL piece types with proper board bounds checking.\n5. Do NOT change the function signature — only replace the body\n6. After implementing, re-read the file and verify the stub is gone`
    : ""
  const autonomousRepairBlock = buildAutonomousRepairBlock(sa, primaryFeedback)
  const contextualFeedbackBlock = referenceFeedback.length > 0
    ? `\n\nReference context from verifier (do not treat these as your primary owned fixes unless you confirm they require integration work from your step):\n${referenceFeedback.map(f => `- ${f}`).join("\n")}`
    : ""

  const hasReplaceInFile = toolMap.has("replace_in_file")
  const docsOnlyTargets = sa.executionContext.targetArtifacts.length > 0 &&
    sa.executionContext.targetArtifacts.every((artifact) => /\.(?:md|markdown|txt|rst|adoc)$/i.test(artifact))
  const blueprintRetryGuidance = docsOnlyTargets || /blueprint/i.test(sa.name)
    ? `\n\n⚠️ BLUEPRINT/DOCUMENT RETRY GUIDANCE:\n- Do NOT mutate the document to add fake runtime-verification, test-plan, or execution-history sections.\n- Verification for this step is deterministic artifact inspection: write the document, then use read_file on the written artifact and confirm the required contracts are present.\n- Fix only the missing architectural depth: signatures, shared data, dependencies, algorithmic contracts, and edge cases.\n- Do NOT claim runtime behavior for a documentation-only step.${buildBlueprintRetryGuidance(sa, plan, primaryFeedback)}`
    : ""
  const retryRules = buildRetryRules(docsOnlyTargets, sa, hasReplaceInFile, avoidReplaceInFile)

  const unresolvedDependencyBlockers = getUnresolvedAcceptanceBlockers(name, runtimeModel, repairTask, acceptedArtifacts)
  return {
    ...sa,
    objective: `${sa.objective}\n\n[RETRY — fix these step-owned issues from the previous attempt]:\n${primaryFeedback.map(f => `- ${f}`).join("\n")}${contextualFeedbackBlock}${autonomousRepairBlock}${stubRemediationBlock}${blueprintRetryGuidance}\n\n${retryRules}`,
    executionContext: {
      ...sa.executionContext,
      requiredSourceArtifacts: [...existingSource],
      forbiddenArtifacts: [...new Set([...runtimeModel.ownershipGraph.values()]
        .filter((artifact) => artifact.ownerStepName && artifact.ownerStepName !== sa.name)
        .map((artifact) => artifact.artifactPath))],
      requiredChecks: [sa.executionContext.verificationMode, ...sa.acceptanceCriteria],
      upstreamAcceptedArtifacts: [...acceptedArtifacts],
      unresolvedDependencyBlockers,
      repairContext: buildChildRepairPayload(repairTask),
    },
  }
}

function buildRetryRules(
  docsOnlyTargets: boolean,
  sa: SubagentTaskStep,
  hasReplaceInFile: boolean,
  avoidReplaceInFile: boolean,
): string {
  if (docsOnlyTargets || /blueprint/i.test(sa.name)) {
    return hasReplaceInFile
      ? "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. If the target document already exists, read it first. If it does not exist yet, write the full document from the provided template.\n2. For blueprint/document repair, a full-file rewrite of the single target document is expected; do not force replace_in_file unless you are preserving an already-accepted document.\n3. After writing, immediately read the same document back and compare it against the required contract fields and exact artifact paths.\n4. Keep the content architectural/documentary only; do not add fake runtime verification, test-plan, or execution-history sections.\n5. Fix the listed contract gaps directly in the document before finishing."
      : "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. If the target document already exists, read it first. If it does not exist yet, write the full document from the provided template.\n2. replace_in_file is unavailable in this environment. Write the full document carefully and preserve any already-correct sections.\n3. After writing, immediately read the same document back and compare it against the required contract fields and exact artifact paths.\n4. Keep the content architectural/documentary only; do not add fake runtime verification, test-plan, or execution-history sections.\n5. Fix the listed contract gaps directly in the document before finishing."
  }
  if (hasReplaceInFile) {
    return avoidReplaceInFile
      ? "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. read_file EVERY target file FIRST — do NOT skip this step\n2. replace_in_file appears brittle in this step (repeated old_string misses). Use write_file with FULL-FILE preservation instead.\n3. Build from the latest file content: keep all existing working code and apply only the requested fixes.\n4. write_file REPLACES the entire file — never output partial fragments.\n5. Do not introduce placeholders, stubs, or narrative comments in code."
      : "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. read_file EVERY target file FIRST — do NOT skip this step\n2. Use replace_in_file for SURGICAL fixes to specific functions — this preserves all other code automatically.\n3. NEVER call write_file with a complete file rewrite. Your prior code is 90%+ correct. Find the specific broken part and fix ONLY that.\n4. write_file REPLACES the entire file — if you rewrite from scratch, you WILL lose working functions and create new bugs\n5. If you must use write_file, include ALL existing code plus your fix — do not drop any existing functions"
  }
  return "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. read_file EVERY target file FIRST — do NOT skip this step\n2. replace_in_file is unavailable in this environment. Use write_file carefully and preserve all existing code.\n3. write_file REPLACES the entire file — include the full current file plus your fix, never partial fragments.\n4. Make the smallest targeted correction needed for the listed issues.\n5. Do not introduce placeholders, stubs, or narrative comments in code."
}
