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

import { detectInconsistentBranches, detectPlaceholderPatterns } from "../code-quality.js"
import {
  buildContractSpec,
  getCorrectionGuidance,
  specRequiresFileMutationEvidence,
  specRequiresSuccessfulToolEvidence,
  validateDelegatedOutputContract,
  type DelegationOutputValidationCode,
} from "../delegation-validation.js"
import type { ToolCallRecord } from "../recovery.js"
import type { Tool } from "../types.js"
import type {
  DeterministicToolStep,
  ExecutionEnvelope,
  PipelineResult,
  PipelineStepResult,
  Plan,
  PlanStep,
  SubagentTaskStep
} from "./types.js"

// ============================================================================
// Delegation function signature
// ============================================================================

/**
 * Result from a delegation call — structured output + tool evidence.
 */
export interface DelegateResult {
  readonly output: string
  /** All tool calls the child agent made during execution. */
  readonly toolCalls?: readonly ToolCallRecord[]
}

/**
 * Function that spawns a child agent for a subagent_task step.
 * The pipeline executor doesn't know about Agent — it calls this abstraction.
 */
export type DelegateFn = (
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope,
) => Promise<DelegateResult>

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

interface SubagentStepValidationContext {
  readFileTool?: Tool
  workspaceRoot?: string
  knownProjectArtifacts?: readonly string[]
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
  const knownProjectArtifacts = plan.steps
    .filter((s): s is SubagentTaskStep => s.stepType === "subagent_task")
    .flatMap((s) => s.executionContext.targetArtifacts)

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
      const rawFeedback = opts?.retryFeedback?.get(name)
      // Filter out gibberish/degenerated verifier reasons — the LLM verifier
      // sometimes produces word-salad that confuses retry children.
      const feedback = rawFeedback?.filter(f => !isGibberishIssue(f))
      if (feedback && feedback.length > 0 && effectiveStep.stepType === "subagent_task") {
        const sa = effectiveStep as SubagentTaskStep
        const priorStep = opts?.priorResults?.get(name)
        const priorReplaceMisses = (priorStep?.toolCalls ?? []).filter(
          c => c.name === "replace_in_file" && /old_string not found/i.test(c.result),
        ).length
        const avoidReplaceInFile = priorReplaceMisses >= 2
        // Add target artifacts as source files — these files already exist from
        // the previous attempt and MUST be read before modifying.
        const existingSource = new Set(sa.executionContext.requiredSourceArtifacts)
        for (const artifact of sa.executionContext.targetArtifacts) {
          existingSource.add(artifact)
        }

        // Check if issues mention stub functions — build targeted remediation list
        const hasStubIssues = feedback.some(f =>
          /stub|placeholder|empty array|empty object|returns constant|catch-all|trivial return|degeneration/i.test(f),
        )
        const stubRemediationBlock = hasStubIssues
          ? `\n\n⚠️ STUB FUNCTION REMEDIATION — THIS IS YOUR PRIMARY TASK:\nThe verifier detected functions that are stubs or contain degeneration comments (e.g. "// Other code as per existing logic", "// rest of the code here", "// same as above"). These comments mean NO CODE WAS ACTUALLY WRITTEN — the function body is empty/incomplete.\nFor EACH stub/degenerated function you MUST:\n1. Read the file that contains it\n2. Locate the function by name\n3. Replace the stub body with a REAL, COMPLETE algorithm — DO NOT use comments like "existing logic" or "same as above"\n4. The function NAME tells you WHAT it must do — implement the FULL algorithm. Example: "getLegalMoves" must compute legal moves for ALL piece types with proper board bounds checking.\n5. Do NOT change the function signature — only replace the body\n6. After implementing, re-read the file and verify the stub is gone`
          : ""

        const hasReplaceInFile = toolMap.has("replace_in_file")
        const retryRules = hasReplaceInFile
          ? (avoidReplaceInFile
            ? "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. read_file EVERY target file FIRST — do NOT skip this step\n2. replace_in_file appears brittle in this step (repeated old_string misses). Use write_file with FULL-FILE preservation instead.\n3. Build from the latest file content: keep all existing working code and apply only the requested fixes.\n4. write_file REPLACES the entire file — never output partial fragments.\n5. Do not introduce placeholders, stubs, or narrative comments in code."
            : "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. read_file EVERY target file FIRST — do NOT skip this step\n2. Use replace_in_file for SURGICAL fixes to specific functions — this preserves all other code automatically.\n3. NEVER call write_file with a complete file rewrite. Your prior code is 90%+ correct. Find the specific broken part and fix ONLY that.\n4. write_file REPLACES the entire file — if you rewrite from scratch, you WILL lose working functions and create new bugs\n5. If you must use write_file, include ALL existing code plus your fix — do not drop any existing functions")
          : "⚠️ CRITICAL RETRY RULES (violating these = instant rejection):\n1. read_file EVERY target file FIRST — do NOT skip this step\n2. replace_in_file is unavailable in this environment. Use write_file carefully and preserve all existing code.\n3. write_file REPLACES the entire file — include the full current file plus your fix, never partial fragments.\n4. Make the smallest targeted correction needed for the listed issues.\n5. Do not introduce placeholders, stubs, or narrative comments in code."

        effectiveStep = {
          ...sa,
          objective: `${sa.objective}\n\n[RETRY — fix these issues from the previous attempt]:\n${feedback.map(f => `- ${f}`).join("\n")}${stubRemediationBlock}\n\n${retryRules}`,
          executionContext: {
            ...sa.executionContext,
            requiredSourceArtifacts: [...existingSource],
          },
        }
      }

      const result = await executeStep(
        effectiveStep,
        toolExecFn,
        delegateFn,
        opts?.signal,
        {
          readFileTool: toolMap.get("read_file"),
          workspaceRoot: opts?.workspaceRoot,
          knownProjectArtifacts,
        },
      )

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
  validationCtx?: SubagentStepValidationContext,
): Promise<PipelineStepResult> {
  const t0 = Date.now()

  if (step.stepType === "deterministic_tool") {
    return executeDeterministicStep(step, toolExecFn, t0, signal)
  } else {
    return executeSubagentStep(step, delegateFn, t0, signal, validationCtx)
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

      let output = await toolExecFn(step.tool, args)

      // Recovery: some plans use write_file for directory scaffolding.
      // If write_file hits EISDIR and content is empty, treat this as an
      // implicit mkdir request and run mkdir -p through run_command.
      if (
        step.tool === "write_file" &&
        typeof args.path === "string" &&
        /EISDIR|illegal operation on a directory/i.test(output) &&
        String(args.content ?? "").trim().length === 0
      ) {
        const mkdirCmd = `mkdir -p ${JSON.stringify(String(args.path))}`
        const mkdirOutput = await toolExecFn("run_command", { command: mkdirCmd })
        if (!mkdirOutput.startsWith("Error:")) {
          output = `Recovered directory scaffold via run_command: ${mkdirCmd}`
        }
      }

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
  validationCtx?: SubagentStepValidationContext,
): Promise<PipelineStepResult> {
  if (signal?.aborted) {
    return { name: step.name, status: "failed", error: "Aborted", failureClass: "cancelled", durationMs: Date.now() - t0 }
  }

  try {
    const delegateResult = await delegateFn(step, step.executionContext)
    const output = delegateResult.output
    const childToolCalls = delegateResult.toolCalls

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
        toolCalls: childToolCalls,
      }
    }

    if (output.includes("DELEGATION INCOMPLETE")) {
      return {
        name: step.name,
        status: "failed",
        error: output,
        failureClass: "budget_exceeded",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
      }
    }

    if (output.includes("stuck in a tool loop")) {
      return {
        name: step.name,
        status: "failed",
        error: output,
        failureClass: "tool_misuse",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
      }
    }

    if (output.includes("cancelled") || output.includes("aborted")) {
      return {
        name: step.name,
        status: "failed",
        error: output,
        failureClass: "cancelled",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
      }
    }

    const strictFailure = await validateSubagentCompletion(
      step,
      output,
      childToolCalls,
      validationCtx,
    )
    if (strictFailure) {
      // Recovery path: if the child produced no successful file mutations,
      // run one focused retry with explicit write-first instructions.
      if (
        strictFailure.code === "missing_file_mutation_evidence" &&
        step.executionContext.targetArtifacts.length > 0
      ) {
        const retryStep: SubagentTaskStep = {
          ...step,
          objective:
            `${step.objective}\n\n` +
            `[MANDATORY RETRY — WRITE EVIDENCE REQUIRED]\n` +
            `You must create or modify the target artifacts in this attempt.\n` +
            `Use write_file (or replace_in_file after reading the existing file) on the exact target paths.\n` +
            `Do not stop at analysis or narrative summary. Produce real file mutations before finishing.`,
        }

        const retryResult = await delegateFn(retryStep, retryStep.executionContext)
        const retryOutput = retryResult.output
        const retryCalls = retryResult.toolCalls

        if (retryOutput.startsWith("Delegation failed:")) {
          const isSpawnError = retryOutput.includes("not found") || retryOutput.includes("spawn")
          return {
            name: step.name,
            status: "failed",
            error: retryOutput,
            failureClass: isSpawnError ? "spawn_error" : "unknown",
            durationMs: Date.now() - t0,
            toolCalls: retryCalls,
          }
        }
        if (retryOutput.includes("DELEGATION INCOMPLETE")) {
          return {
            name: step.name,
            status: "failed",
            error: retryOutput,
            failureClass: "budget_exceeded",
            durationMs: Date.now() - t0,
            toolCalls: retryCalls,
          }
        }
        if (retryOutput.includes("stuck in a tool loop")) {
          return {
            name: step.name,
            status: "failed",
            error: retryOutput,
            failureClass: "tool_misuse",
            durationMs: Date.now() - t0,
            toolCalls: retryCalls,
          }
        }

        const retryStrictFailure = await validateSubagentCompletion(
          step,
          retryOutput,
          retryCalls,
          validationCtx,
        )
        if (!retryStrictFailure) {
          return {
            name: step.name,
            status: "completed",
            output: retryOutput,
            durationMs: Date.now() - t0,
            toolCalls: retryCalls,
          }
        }

        return {
          name: step.name,
          status: "failed",
          error: retryStrictFailure.message,
          failureClass: "unknown",
          durationMs: Date.now() - t0,
          toolCalls: retryCalls,
          validationCode: retryStrictFailure.code,
        }
      }

      return {
        name: step.name,
        status: "failed",
        error: strictFailure.message,
        failureClass: "unknown",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
        validationCode: strictFailure.code,
      }
    }

    // ── Post-step syntax validation ──
    // Run `node --check` on all .js files this step produced BEFORE marking
    // the step as completed. This catches syntax errors at the source step,
    // preventing broken JS from cascading to downstream steps that depend on it.
    const syntaxErrors = await runPostStepSyntaxValidation(
      step,
      childToolCalls ?? [],
      validationCtx,
    )
    if (syntaxErrors.length > 0) {
      return {
        name: step.name,
        status: "failed",
        error: `Syntax validation failed after step completion:\n${syntaxErrors.join("\n")}`,
        failureClass: "unknown",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
      }
    }

    return {
      name: step.name,
      status: "completed",
      output,
      durationMs: Date.now() - t0,
      toolCalls: childToolCalls,
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

interface SubagentValidationFailure {
  code?: DelegationOutputValidationCode
  message: string
}

function getMutatedArtifactPaths(calls: readonly ToolCallRecord[]): Set<string> {
  const paths = new Set<string>()
  for (const c of calls) {
    if (c.isError) continue
    if (c.name !== "write_file" && c.name !== "replace_in_file") continue
    const path = typeof c.args.path === "string" ? c.args.path : ""
    if (!path) continue
    paths.add(path)
    paths.add(path.replace(/^\.\//, ""))
    const base = path.split("/").pop()
    if (base) paths.add(base)
  }
  return paths
}

async function validateSubagentCompletion(
  step: SubagentTaskStep,
  output: string,
  toolCalls: readonly ToolCallRecord[] | undefined,
  validationCtx?: SubagentStepValidationContext,
): Promise<SubagentValidationFailure | null> {
  const calls = toolCalls ?? []

  // Hard fail if child's FINAL write to a file produced explicit write-integrity warnings.
  // Only check the LAST write to each file path — earlier rejected writes that the child
  // subsequently fixed should not block completion.
  const lastWriteByPath = new Map<string, ToolCallRecord>()
  for (const c of calls) {
    if (c.name !== "write_file" && c.name !== "replace_in_file") continue
    const path = typeof c.args.path === "string" ? c.args.path : ""
    if (path) lastWriteByPath.set(path, c)
  }
  const finalWriteWarning = [...lastWriteByPath.values()].find(c =>
    /WRITE REJECTED|WRITTEN WITH ERRORS|WRITTEN WITH ISSUES|STUB\/PLACEHOLDER|CORRUPTED/i.test(c.result),
  )
  if (finalWriteWarning) {
    const path = typeof finalWriteWarning.args.path === "string" ? finalWriteWarning.args.path : "(unknown)"
    return {
      message:
        `Step "${step.name}" final write to "${path}" has integrity violations via ${finalWriteWarning.name}. ` +
        `The step is rejected until file writes are clean and free of placeholder/corruption warnings.`,
    }
  }

  // Deterministic child-output contract gate.
  const enrichedSpec = buildContractSpec(
    step,
    step.executionContext,
    undefined,
    validationCtx?.knownProjectArtifacts,
  )
  if (specRequiresSuccessfulToolEvidence(enrichedSpec) && calls.length === 0) {
    return {
      code: "missing_successful_tool_evidence",
      message:
        `Step "${step.name}" produced zero tool-call evidence. ` +
        `Completion is rejected until at least one successful tool execution is recorded.`,
    }
  }
  if (specRequiresFileMutationEvidence(enrichedSpec) && calls.length === 0) {
    return {
      code: "missing_file_mutation_evidence",
      message:
        `Step "${step.name}" requires file mutation evidence but recorded no tool calls. ` +
        `Completion is rejected until file creation/modification is proven.`,
    }
  }

  const contract = validateDelegatedOutputContract({
    spec: enrichedSpec,
    output,
    toolCalls: calls,
  })
  if (!contract.ok) {
    const guidance = contract.code ? getCorrectionGuidance(contract.code) : "Child output violated delegation contract."
    return {
      code: contract.code,
      message:
        `Step "${step.name}" violated delegation contract` +
        `${contract.code ? ` [${contract.code}]` : ""}: ${contract.message ?? "unknown contract failure"}. ` +
        `Required correction: ${guidance}`,
    }
  }

  const readFileTool = validationCtx?.readFileTool
  if (!readFileTool) return null

  // Adaptive artifact-quality gate:
  // - strict scope for verification-critical or reviewer/validator roles
  // - progressive scope for large writer steps (check mutated code targets first)
  const codeTargets = step.executionContext.targetArtifacts.filter((a) => /\.(js|jsx|ts|tsx|py)$/i.test(a))
  const strictQualityScope =
    step.executionContext.verificationMode !== "none"
    || step.executionContext.role === "validator"
    || step.executionContext.role === "reviewer"

  const mutatedPaths = getMutatedArtifactPaths(calls)
  const qualityTargets = strictQualityScope
    ? codeTargets
    : codeTargets.filter((artifact) => {
        const normalized = artifact.replace(/^\.\//, "")
        const base = normalized.split("/").pop() ?? normalized
        return mutatedPaths.has(artifact) || mutatedPaths.has(normalized) || mutatedPaths.has(base)
      })

  for (const artifact of qualityTargets) {
    const content = await tryReadArtifact(readFileTool, artifact, validationCtx?.workspaceRoot)
    if (!content) {
      if (strictQualityScope) {
        return {
          code: "missing_target_artifact_coverage",
          message: `Step "${step.name}" did not produce readable target artifact: ${artifact}`,
        }
      }
      continue
    }

    const placeholders = detectPlaceholderPatterns(content)
    const branchInconsistencies = detectInconsistentBranches(content)
    const findings = [...placeholders, ...branchInconsistencies]
    if (findings.length > 0) {
      return {
        code: "acceptance_evidence_missing",
        message:
          `Step "${step.name}" produced non-executable or incomplete code in ${artifact}: ` +
          `${findings.slice(0, 5).join("; ")}`,
      }
    }
  }

  return null
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
  // critical because tool output often says "Successfully wrote to tmp/app/main.js"
  for (const m of output.matchAll(/(?:creat|writ|wrote|modif|generat|saved)\w*\s+(?:to\s+)?(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi)) {
    if (m[1] && m[1].length < 200) paths.push(m[1])
  }
  return [...new Set(paths)]
}

function extractMutatedPathsFromToolCalls(calls: readonly ToolCallRecord[] | undefined): string[] {
  if (!calls || calls.length === 0) return []
  const paths = new Set<string>()

  for (const c of calls) {
    if (c.isError) continue
    if (c.name !== "write_file" && c.name !== "replace_in_file" && c.name !== "create_file") continue

    const fromArgs = typeof c.args.path === "string"
      ? c.args.path
      : typeof c.args.filePath === "string"
        ? c.args.filePath
        : typeof c.args.file === "string"
          ? c.args.file
          : ""
    if (fromArgs.trim().length > 0) {
      paths.add(fromArgs)
      continue
    }

    for (const m of c.result.matchAll(/(?:wrote|created|updated|saved)\s+(?:to\s+)?(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi)) {
      if (m[1] && m[1].length < 200) paths.add(m[1])
    }
  }

  return [...paths]
}

/** Summarize a dependency step's output for downstream consumption. */
function summarizeDependencyOutput(output: string, maxChars: number, toolCalls?: readonly ToolCallRecord[]): string {
  const mentionedPaths = extractMutatedPathsFromToolCalls(toolCalls)
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
      ? summarizeDependencyOutput(depResult.output, 800, depResult.toolCalls)
      : `(step ${depResult.status})`

    priorSections.push(
      `### Step "${depName}" (${depResult.status})${depStep?.stepType === "deterministic_tool" ? ` — tool: ${(depStep as DeterministicToolStep).tool}` : ""}\n${summary}`,
    )
  }

  // Build augmented inputContract with prior context
  let augmentedInput = step.inputContract || ""
  if (priorSections.length > 0) {
    augmentedInput = `## Context from completed prior steps\nThese steps have ALREADY RUN and their output files EXIST on disk. You are continuing their work — do NOT redo what they did.\n\n${priorSections.join("\n\n")}\n\n${augmentedInput}`
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

      // First: use concrete tool-call mutation paths from the dependency step.
      if (depResult) {
        const actualPaths = extractMutatedPathsFromToolCalls(depResult.toolCalls)
        if (actualPaths.length > 0) {
          // Cross-reference: if extracted path is a bare name (no "/") but
          // the plan's targetArtifact has the full path (with directory prefix),
          // prefer the target artifact version. Children often report
          // "`logic.js`" in their summary but the actual file is at
          // "tmp/project/logic.js".
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

      // Fallback: parse textual output paths only if tool-call evidence is absent.
      if (depResult?.output) {
        const outputPaths = extractMentionedPaths(depResult.output)
        if (outputPaths.length > 0) {
          priorArtifacts.push(...outputPaths)
          continue
        }
      }

      // Fallback: use plan-declared targetArtifacts
      priorArtifacts.push(...depTargetArtifacts)
    }
    if (priorArtifacts.length > 0) {
      // Deduplicate
      const uniqueArtifacts = [...new Set(priorArtifacts)]
      objective = `${objective}\n\n⚠️ PRIOR WORK EXISTS — DO NOT START FROM SCRATCH:\nPrior steps have ALREADY created these files: ${uniqueArtifacts.join(", ")}.\nYou MUST:\n1. Use read_file with these EXACT paths to read each file\n2. Understand what they contain and what functions/variables they export\n3. Build ON TOP of this existing code — reference their functions, use their data structures\n4. Do NOT recreate, overwrite, or duplicate any file that is not in YOUR target files`

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
// ── Post-step syntax validation ──────────────────────────────────

/**
 * Run `node --check` on all .js files produced by a completed subagent step.
 *
 * This catches syntax errors immediately after the step completes, BEFORE
 * downstream steps that depend on these files are executed. Without this,
 * a syntax error in step A's output would only be caught during the final
 * verification pass, by which point step B may have already tried and failed
 * to work with the broken file.
 *
 * Returns an array of syntax error descriptions (empty = all files OK).
 */
async function runPostStepSyntaxValidation(
  step: SubagentTaskStep,
  toolCalls: readonly ToolCallRecord[],
  validationCtx?: SubagentStepValidationContext,
): Promise<string[]> {
  const errors: string[] = []
  const wsRoot = validationCtx?.workspaceRoot

  // Collect .js files from targetArtifacts AND actually mutated paths
  const jsTargets = step.executionContext.targetArtifacts.filter(a => /\.js$/i.test(a))
  const mutatedJsPaths = new Set<string>()

  for (const c of toolCalls) {
    if (c.isError) continue
    if (c.name !== "write_file" && c.name !== "replace_in_file") continue
    const path = typeof c.args.path === "string" ? c.args.path : ""
    if (/\.js$/i.test(path)) mutatedJsPaths.add(path)
  }

  // Combine: check targetArtifacts + actually written paths
  const pathsToCheck = new Set<string>([...jsTargets, ...mutatedJsPaths])
  if (pathsToCheck.size === 0) return errors

  // We need run_command — if not available through validationCtx, try to
  // use a lightweight approach. For now, use the same pattern as the verifier.
  // Since we don't have direct access to run_command here, use the simpler
  // approach of checking via child_process if we're in a Node environment.
  const { execSync } = await import("node:child_process")

  for (const artifact of pathsToCheck) {
    let checkPath = artifact
    if (wsRoot && !checkPath.startsWith("/")) {
      checkPath = wsRoot.endsWith("/") ? `${wsRoot}${checkPath}` : `${wsRoot}/${checkPath}`
    }

    try {
      // Check if file exists first
      const { accessSync } = await import("node:fs")
      accessSync(checkPath)

      // Run node --check
      execSync(`node --check ${JSON.stringify(checkPath)}`, {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? (err as { stderr?: string }).stderr ?? err.message : String(err)
      // Only flag genuine syntax errors, not file-not-found
      if (/SyntaxError|Unexpected token|Unexpected identifier/i.test(errMsg)) {
        const errorLines = errMsg.trim().split("\n").slice(0, 5).join(" | ")
        errors.push(`Syntax error in "${artifact}": ${errorLines}`)
      }
      // File not found is OK — the file might be at a different resolved path
      // and the verifier will catch it later
    }
  }

  return errors
}

// ── Gibberish issue detection ────────────────────────────────────

/**
 * Detect if a verifier issue string is gibberish/word-salad.
 * The LLM verifier sometimes degenerates and produces nonsense like:
 *   "Edge-action resets fail appropriate bound-scoping interpolated mouse-rerun
 *    initialization layers, creating block scenario loop redundancies"
 * These confuse retry children. Filter them out.
 */
export function isGibberishIssue(issue: string): boolean {
  const words = issue.split(/\s+/).filter(w => w.length > 0)
  if (words.length < 8) return false

  // Compound-hyphenated jargon: "bound-scoping", "frame-hydro-exclusive"
  const tripleCompound = (issue.match(/[a-z]+-[a-z]+-[a-z]+/gi) ?? []).length
  if (tripleCompound >= 3) return true

  const doubleCompound = (issue.match(/[a-z]{3,}-[a-z]{3,}/gi) ?? []).length

  // Very few common English function words relative to total
  const functionWords = (issue.match(/\b(the|is|a|an|and|to|of|in|for|with|that|was|it|this|are|not|but|be|has|have|can|does|should|must)\b/gi) ?? []).length
  const ratio = functionWords / words.length
  if (ratio < 0.04 && words.length >= 15) return true

  // Contains no code-relevant indicators (file paths, function names, tool names)
  const hasCodeRefs = /[/\\]|\.(?:js|ts|html|css|py)\b|`[^`]+`|\bfunction\b|\bclass\b|\bconst\b|\bread_file\b|\bwrite_file\b|\breplace_in_file\b/i.test(issue)
  // Many compound words + few function words + no code refs = gibberish
  if (!hasCodeRefs && doubleCompound >= 4 && ratio < 0.08) return true

  return false
}
