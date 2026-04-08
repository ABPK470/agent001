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
    PipelineStepStatus,
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

      // Inject verifier feedback into subagent steps on retry.
      // Critical: also promote target artifacts to source files so the child
      // reads its own prior work instead of rewriting from scratch.
      const feedback = opts?.retryFeedback?.get(name)
      if (feedback && feedback.length > 0 && effectiveStep.stepType === "subagent_task") {
        const sa = effectiveStep as SubagentTaskStep
        // Add target artifacts as source files — these files already exist from
        // the previous attempt and MUST be read before modifying.
        const existingSource = new Set(sa.executionContext.requiredSourceArtifacts)
        for (const artifact of sa.executionContext.targetArtifacts) {
          existingSource.add(artifact)
        }

        // Check if issues mention stub functions — build targeted remediation list
        const hasStubIssues = feedback.some(f =>
          /stub|placeholder|empty array|empty object|returns constant|catch-all|trivial return/i.test(f),
        )
        const stubRemediationBlock = hasStubIssues
          ? `\n\n⚠️ STUB FUNCTION REMEDIATION — THIS IS YOUR PRIMARY TASK:\nThe verifier detected functions that are stubs (returning [], {}, true, false, or having only a comment + trivial return). The function names and line numbers are listed in the issues above.\nFor EACH stub function you MUST:\n1. Read the file that contains it\n2. Locate the function by name\n3. Replace the stub body with a REAL, COMPLETE algorithm\n4. A function called "calculateRookMoves" must compute rook movement along ranks and files. A function called "isCheckmate" must check if the king has no legal escape. The function NAME tells you WHAT it must do — implement it.\n5. Do NOT change the function signature — only replace the body\n6. After implementing, re-read the file and verify the stub is gone`
          : ""

        effectiveStep = {
          ...sa,
          objective: `${sa.objective}\n\n[RETRY — fix these issues from the previous attempt]:\n${feedback.map(f => `- ${f}`).join("\n")}${stubRemediationBlock}\n\n⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. read_file EVERY target file FIRST — do NOT skip this step\n2. NEVER call write_file with a complete file rewrite. Your prior code is 90%+ correct. Find the specific broken part and fix ONLY that.\n3. write_file REPLACES the entire file — if you rewrite from scratch, you WILL lose working functions and create new bugs\n4. If you must use write_file, include ALL existing code plus your fix — do not drop any existing functions\n5. Your fix should be SURGICAL: read → identify the gap → write the file with the gap filled, keeping everything else identical`,
          executionContext: {
            ...sa.executionContext,
            requiredSourceArtifacts: [...existingSource],
          },
        }
      }

      // ── Pre-retry snapshot: save target artifact contents ──
      // If this is a retry step (has feedback), snapshot all target artifacts
      // BEFORE the child runs. After execution, check if the retry made things
      // WORSE (syntax errors, lost functions). If so, rollback to the snapshot
      // and fail the step — never allow retries to degrade working code.
      let preRetrySnapshots: Map<string, string> | undefined
      if (feedback && feedback.length > 0 && effectiveStep.stepType === "subagent_task") {
        const sa = effectiveStep as SubagentTaskStep
        const rfTool = toolMap.get("read_file")
        if (rfTool) {
          preRetrySnapshots = new Map()
          for (const artifact of sa.executionContext.targetArtifacts) {
            const content = await tryReadArtifact(rfTool, artifact, opts?.workspaceRoot)
            if (content !== null) {
              preRetrySnapshots.set(artifact, content)
            }
          }
        }
      }

      const result = await executeStep(effectiveStep, toolExecFn, delegateFn, opts?.signal)

      // ── Post-retry regression check ──
      // If we have snapshots and the step "completed", verify the retry
      // didn't introduce regressions (syntax errors, lost functions, corruption).
      if (preRetrySnapshots && preRetrySnapshots.size > 0 && result.status === "completed" && effectiveStep.stepType === "subagent_task") {
        const sa = effectiveStep as SubagentTaskStep
        const rfTool = toolMap.get("read_file")
        const wfTool = toolMap.get("write_file")
        if (rfTool && wfTool) {
          const regressions = await detectRetryRegressions(preRetrySnapshots, sa, rfTool, opts?.workspaceRoot)
          if (regressions.length > 0) {
            // ROLLBACK: restore pre-retry file contents
            for (const [artifact, oldContent] of preRetrySnapshots) {
              const artifactPath = resolveArtifactPath(artifact, opts?.workspaceRoot)
              try { await wfTool.execute({ path: artifactPath, content: oldContent }) } catch { /* best effort */ }
            }
            // Override result to failed with regression details
            ;(result as { status: PipelineStepStatus }).status = "failed"
            ;(result as { error?: string }).error = `Retry caused regression — reverted to pre-retry state: ${regressions.join("; ")}`
            ;(result as { failureClass?: string }).failureClass = "unknown"
          }
        }
      }

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
          // Halt entire pipeline: mark ALL remaining steps as skipped
          for (const s of plan.steps) {
            if (!stepResults.has(s.name)) {
              stepResults.set(s.name, {
                name: s.name,
                status: "skipped",
                error: `Pipeline aborted: step "${name}" failed`,
                durationMs: 0,
              })
              failed.add(s.name)
            }
          }
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
      // Normalize args: LLM sometimes uses wrong parameter names.
      // browser_check expects "path" but planner may generate "key" or "url".
      let args = step.args
      if (step.tool === "browser_check" && !args.path && (args.key || args.url)) {
        args = { ...args, path: String(args.key ?? args.url) }
        delete (args as Record<string, unknown>).key
        delete (args as Record<string, unknown>).url
      }

      const output = await toolExecFn(step.tool, args)

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
    return { name: step.name, status: "failed", error: "Aborted", failureClass: "cancelled", durationMs: Date.now() - t0 }
  }

  try {
    const output = await delegateFn(step, step.executionContext)

    // agenc-core pattern: typed failure classification.
    // Classify delegation output to determine retry policy.
    if (output.startsWith("Delegation failed:")) {
      const isSpawnError = output.includes("not found") || output.includes("spawn")
      return {
        name: step.name,
        status: "failed",
        error: output,
        failureClass: isSpawnError ? "spawn_error" : "unknown",
        durationMs: Date.now() - t0,
      }
    }

    if (output.includes("DELEGATION INCOMPLETE")) {
      return {
        name: step.name,
        status: "failed",
        error: output,
        failureClass: "budget_exceeded",
        durationMs: Date.now() - t0,
      }
    }

    if (output.includes("stuck in a tool loop")) {
      return {
        name: step.name,
        status: "failed",
        error: output,
        failureClass: "tool_misuse",
        durationMs: Date.now() - t0,
      }
    }

    if (output.includes("cancelled") || output.includes("aborted")) {
      return {
        name: step.name,
        status: "failed",
        error: output,
        failureClass: "cancelled",
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
    const errMsg = err instanceof Error ? err.message : String(err)
    const isTransient = /ECONNRESET|ETIMEDOUT|rate.?limit|429|503|overloaded/i.test(errMsg)
    return {
      name: step.name,
      status: "failed",
      error: errMsg,
      failureClass: isTransient ? "transient_provider_error" : "unknown",
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
 *
 * agenc-core pattern: dependency summarization extracts modified files,
 * verified commands, and key output lines rather than raw truncation.
 */

/** Extract file paths mentioned in child output (created/modified). */
function extractMentionedPaths(output: string): string[] {
  const paths: string[] = []
  // Backtick-quoted paths: `path/file.ext`
  for (const m of output.matchAll(/`([^`\s]+\.[a-zA-Z0-9]+)`/g)) {
    if (m[1] && m[1].length < 200) paths.push(m[1])
  }
  // "created/wrote/modified [to] <path>" patterns — the optional "to" is
  // critical because tool output says "Successfully wrote to tmp/chess/game.js"
  for (const m of output.matchAll(/(?:creat|writ|wrote|modif|generat|saved)\w*\s+(?:to\s+)?(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi)) {
    if (m[1] && m[1].length < 200) paths.push(m[1])
  }
  return [...new Set(paths)]
}

/** Summarize a dependency step's output for downstream consumption. */
function summarizeDependencyOutput(output: string, maxChars: number): string {
  const mentionedPaths = extractMentionedPaths(output)
  const parts: string[] = []

  if (mentionedPaths.length > 0) {
    parts.push(`Files created/modified: ${mentionedPaths.join(", ")}`)
  }

  // Extract the first few meaningful lines (skip blanks, markdown headers)
  const lines = output.split("\n").filter(l => l.trim().length > 0)
  const meaningfulLines = lines.slice(0, 5).join("\n")

  if (meaningfulLines.length > 0) {
    const remaining = maxChars - parts.join("\n").length - 20
    if (remaining > 100) {
      parts.push(meaningfulLines.slice(0, remaining))
    }
  }

  return parts.join("\n") || output.slice(0, maxChars)
}

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

    // agenc-core pattern: summarize rather than raw truncate
    const summary = depResult.output
      ? summarizeDependencyOutput(depResult.output, 800)
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
    // Collect ACTUAL file paths from completed dependency outputs.
    // This is critical: the plan may declare targetArtifacts as "game/index.html"
    // but the child may have actually written "tmp/game/index.html". Using the
    // actual paths from the child's output prevents downstream children from
    // looking for files in the wrong directory.
    const priorArtifacts: string[] = []
    for (const depName of deps) {
      const depResult = stepResults.get(depName)
      const depStep = plan.steps.find(s => s.name === depName)

      // Collect target artifacts for cross-referencing bare paths
      const depTargetArtifacts = depStep?.stepType === "subagent_task"
        ? (depStep as SubagentTaskStep).executionContext.targetArtifacts
        : []

      // First: try to extract actual paths from the child's output
      if (depResult?.output) {
        const actualPaths = extractMentionedPaths(depResult.output)
        if (actualPaths.length > 0) {
          // Cross-reference: if extracted path is a bare name (no "/") but
          // the plan's targetArtifact has the full path (with directory prefix),
          // prefer the target artifact version.  Children often report
          // "`gameLogic.js`" in their summary but the actual file is at
          // "tmp/chess/gameLogic.js".
          const resolvedPaths = actualPaths.map(extracted => {
            if (!extracted.includes("/") && depTargetArtifacts.length > 0) {
              const match = depTargetArtifacts.find(
                t => t.endsWith(`/${extracted}`) || t === extracted,
              )
              return match ?? extracted
            }
            return extracted
          })
          priorArtifacts.push(...resolvedPaths)
          continue
        }
      }

      // Fallback: use plan-declared targetArtifacts
      priorArtifacts.push(...depTargetArtifacts)
    }
    if (priorArtifacts.length > 0) {
      // Deduplicate
      const uniqueArtifacts = [...new Set(priorArtifacts)]
      objective = `${objective}\n\nIMPORTANT: Prior steps should have created these files: ${uniqueArtifacts.join(", ")}. Start by reading them with read_file using these EXACT paths to verify they exist and understand their contents before making changes.`

      // Also update requiredSourceArtifacts in the execution context so that
      // spawnChildForPlan's "Source Files" section uses the ACTUAL paths
      const existingSource = new Set(executionContext.requiredSourceArtifacts)
      for (const artifact of uniqueArtifacts) {
        existingSource.add(artifact)
      }
      executionContext = {
        ...executionContext,
        requiredSourceArtifacts: [...existingSource],
      }
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

// ============================================================================
// Pre-retry snapshot + regression detection
// ============================================================================

/** Resolve an artifact path for file I/O, prepending workspace root if needed. */
function resolveArtifactPath(artifact: string, wsRoot?: string): string {
  if (!wsRoot || artifact.startsWith("/") || artifact.startsWith(wsRoot)) return artifact
  return wsRoot.endsWith("/") ? `${wsRoot}${artifact}` : `${wsRoot}/${artifact}`
}

/** Try to read an artifact, attempting workspace-rooted path then bare path. */
async function tryReadArtifact(readFileTool: Tool, artifact: string, wsRoot?: string): Promise<string | null> {
  if (wsRoot) {
    const wsPath = resolveArtifactPath(artifact, wsRoot)
    try {
      const content = await readFileTool.execute({ path: wsPath })
      if (typeof content === "string" && !content.startsWith("Error:")) return content
    } catch { /* fall through */ }
  }
  try {
    const content = await readFileTool.execute({ path: artifact })
    if (typeof content === "string" && !content.startsWith("Error:")) return content
  } catch { /* fall through */ }
  return null
}

/** Extract function/class/const definition names from source code (lightweight regex). */
function extractNames(code: string): Set<string> {
  const names = new Set<string>()
  for (const m of code.matchAll(/\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g)) if (m[1]) names.add(m[1])
  for (const m of code.matchAll(/\bclass\s+([a-zA-Z_$][\w$]*)/g)) if (m[1]) names.add(m[1])
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:function|\(|[a-zA-Z_$][\w$]*\s*=>)/g)) if (m[1]) names.add(m[1])
  return names
}

/**
 * Detect regressions introduced by a retry — compare pre-retry snapshots with
 * the current file state. Returns a list of regression descriptions (empty = OK).
 *
 * Checks:
 *   1. Function/class loss — if the retry removed definitions that existed before
 *   2. Brace imbalance — if the old file had balanced braces but the new one doesn't
 *   3. Content destruction — if the new file is dramatically shorter (< 40% of old)
 */
async function detectRetryRegressions(
  snapshots: ReadonlyMap<string, string>,
  step: SubagentTaskStep,
  readFileTool: Tool,
  wsRoot?: string,
): Promise<string[]> {
  const regressions: string[] = []

  for (const artifact of step.executionContext.targetArtifacts) {
    const oldContent = snapshots.get(artifact)
    if (!oldContent) continue

    const newContent = await tryReadArtifact(readFileTool, artifact, wsRoot)
    if (!newContent) {
      regressions.push(`"${artifact}" was DELETED by retry`)
      continue
    }

    // 1. Function/class loss
    const oldNames = extractNames(oldContent)
    const newNames = extractNames(newContent)
    const lost = [...oldNames].filter(n => !newNames.has(n))
    if (lost.length > 0) {
      regressions.push(`"${artifact}": lost ${lost.length} definition(s): ${lost.slice(0, 5).join(", ")}`)
    }

    // 2. Brace imbalance: old file was balanced, new file isn't
    const oldBalance = (oldContent.match(/{/g)?.length ?? 0) - (oldContent.match(/}/g)?.length ?? 0)
    const newBalance = (newContent.match(/{/g)?.length ?? 0) - (newContent.match(/}/g)?.length ?? 0)
    if (Math.abs(oldBalance) <= 1 && Math.abs(newBalance) > 2) {
      regressions.push(`"${artifact}": brace imbalance introduced (${newBalance > 0 ? newBalance + " unclosed" : Math.abs(newBalance) + " extra closing"})`)
    }

    // 3. Content destruction: new file is dramatically shorter
    const oldLines = oldContent.split("\n").length
    const newLines = newContent.split("\n").length
    if (oldLines > 20 && newLines < oldLines * 0.4) {
      regressions.push(`"${artifact}": content shrunk from ${oldLines} to ${newLines} lines (${Math.round(newLines / oldLines * 100)}% of original)`)
    }
  }

  return regressions
}
