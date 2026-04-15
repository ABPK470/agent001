/**
 * Planner-first routing — the logic that attempts structured planning
 * before falling through to the direct tool loop.
 *
 * Handles: coherent generation, planner path execution, delay commitment,
 * remediation, and verification-driven fallback routing.
 */

import type { AgentLoopState } from "./agent-loop-state.js"
import * as log from "./logger.js"
import {
    buildCoherentGenerationMessages,
    buildCoherentRepairInstructions,
    buildCoherentVerificationPlan,
    materializeCoherentSolutionBundle,
    parseCoherentSolutionBundle,
    summarizeCoherentVerifierDecision,
} from "./planner/coherent.js"
import { assessPlannerDecision } from "./planner/decision.js"
import type { PlannerContext } from "./planner/index.js"
import { executePlannerPath } from "./planner/index.js"
import type { VerifierDecision } from "./planner/types.js"
import type { ToolCallRecord } from "./tool-result.js"
import type { AgentConfig, LLMClient, Message, TokenUsage, Tool } from "./types.js"

/** Result of planner-first routing. */
export interface PlannerRoutingResult {
  /** If set, the planner handled the entire goal — return this as the final answer. */
  finalAnswer?: string
}

export interface PlannerRoutingContext {
  goal: string
  messages: Message[]
  state: AgentLoopState
  llm: LLMClient
  toolList: Tool[]
  tools: Map<string, Tool>
  config: {
    enablePlanner: boolean
    workspaceRoot: string
    plannerDelegateFn: AgentConfig["plannerDelegateFn"]
    signal: AgentConfig["signal"]
    verbose: boolean
    onPlannerTrace: AgentConfig["onPlannerTrace"]
    onLlmCall: AgentConfig["onLlmCall"]
    onNudge: AgentConfig["onNudge"]
  }
  usage: TokenUsage
  allToolCalls: ToolCallRecord[]
  /** Increment llmCalls counter. */
  incrementLlmCalls: () => void
  /** Create a PlannerContext. */
  createPlannerContext: () => PlannerContext
  /** Run coherent verification. */
  runCoherentVerification: (force?: boolean) => Promise<VerifierDecision | null>
}

/**
 * Attempt planner-first routing. Returns a final answer if the planner
 * handles the entire goal, otherwise returns undefined (fall through
 * to the direct tool loop).
 */
export async function attemptPlannerRouting(
  ctx: PlannerRoutingContext,
): Promise<PlannerRoutingResult> {
  const { goal, messages, state, config } = ctx

  if (!config.enablePlanner || !config.plannerDelegateFn) return {}

  config.onPlannerTrace?.({ kind: "planning_preflight", mode: "planner-first" })
  const plannerCtx = ctx.createPlannerContext()

  // ── Execute planner path ──
  const plannerResult = await executePlannerPath(goal, plannerCtx, config.plannerDelegateFn)

  if (plannerResult.handled) {
    const answer = plannerResult.answer ?? "(planner produced no answer)"
    if (config.verbose) log.logFinalAnswer(answer)
    return { finalAnswer: answer }
  }

  // ── LLM routing decision ──
  const routingDecision = await assessPlannerDecision(goal, messages, ctx.llm, config.signal)

  let coherentGenerationFailed = false

  // ── Coherent generation path ──
  if (routingDecision.route === "bounded_coherent_generation") {
    const coherentResult = await attemptCoherentGeneration(ctx, routingDecision.route)
    if (coherentResult.failed) {
      coherentGenerationFailed = true
    }
  }

  // ── Delay commitment: coherent failed → escalate to planner ──
  if (coherentGenerationFailed && config.plannerDelegateFn) {
    config.onPlannerTrace?.({
      kind: "planner-architecture-state",
      lane: "full_planner_decomposition",
      status: "repairing_in_place",
      reason: "coherent_generation_failed_escalating_to_planner",
    })
    const escalatedResult = await executePlannerPath(
      goal, plannerCtx, config.plannerDelegateFn,
      { forceRoute: "full_planner_decomposition" },
    )
    if (escalatedResult.handled) {
      const answer = escalatedResult.answer ?? "(planner produced no answer)"
      if (config.verbose) log.logFinalAnswer(answer)
      return { finalAnswer: answer }
    }
  }

  // ── Planner declined — handle verification failures ──
  if (config.verbose && plannerResult.skipReason) {
    log.logError(`Planner skipped: ${plannerResult.skipReason}`)
  }

  if (plannerResult.verifierDecision && plannerResult.verifierDecision.overall !== "pass") {
    const remediationAnswer = await handleVerificationFailure(
      ctx, plannerResult, plannerCtx,
    )
    if (remediationAnswer) {
      return { finalAnswer: remediationAnswer }
    }
  }

  if (routingDecision.route !== "bounded_coherent_generation") {
    config.onPlannerTrace?.({
      kind: "direct_loop_fallback",
      source: "planner_declined",
      reason: plannerResult.skipReason ?? "Planner declined — continuing in the direct tool loop.",
    })
  }

  return {}
}

// ── Internal helpers ────────────────────────────────────────────

async function attemptCoherentGeneration(
  ctx: PlannerRoutingContext,
  route: string,
): Promise<{ failed: boolean }> {
  const { messages, state, config } = ctx

  config.onPlannerTrace?.({ kind: "coherent-generation-start", route })
  config.onPlannerTrace?.({
    kind: "planner-architecture-state",
    lane: route,
    status: "preserved",
    reason: "coherent_lane_selected",
  })

  const coherentMessages = buildCoherentGenerationMessages(ctx.goal, config.workspaceRoot, messages)
  config.onLlmCall?.({ phase: "request", messages: coherentMessages, tools: [], iteration: 0 })

  const t0 = Date.now()
  const coherentResponse = await ctx.llm.chat(coherentMessages, [], { signal: config.signal, maxTokens: 16384 })
  const durationMs = Date.now() - t0
  ctx.incrementLlmCalls()
  config.onLlmCall?.({ phase: "response", response: coherentResponse, iteration: 0, durationMs })

  if (coherentResponse.usage) {
    ctx.usage.promptTokens += coherentResponse.usage.promptTokens
    ctx.usage.completionTokens += coherentResponse.usage.completionTokens
    ctx.usage.totalTokens += coherentResponse.usage.totalTokens
  }

  const coherentParse = parseCoherentSolutionBundle(coherentResponse.content ?? "")
  if (!coherentParse.bundle) {
    config.onPlannerTrace?.({
      kind: "coherent-generation-failed",
      stage: "bundle_parse",
      diagnostics: [...coherentParse.diagnostics],
    })
    return { failed: true }
  }

  config.onPlannerTrace?.({
    kind: "coherent-generation-bundle",
    artifactCount: coherentParse.bundle.artifacts.length,
    artifacts: coherentParse.bundle.artifacts.map((a) => ({ path: a.path, purpose: a.purpose })),
    sharedContracts: coherentParse.bundle.sharedContracts?.map((c) => c.name) ?? [],
    invariants: coherentParse.bundle.invariants?.map((inv) => inv.id) ?? [],
  })

  const materialized = await materializeCoherentSolutionBundle(coherentParse.bundle, {
    writeFileTool: ctx.tools.get("write_file"),
    readFileTool: ctx.tools.get("read_file"),
  })

  // Record all artifacts as tool calls
  for (const artifact of coherentParse.bundle.artifacts) {
    const written = materialized.writtenArtifacts.includes(artifact.path)
    ctx.allToolCalls.push({
      name: "write_file",
      args: { path: artifact.path, content: artifact.content },
      result: written ? "coherent bundle materialized" : `Error: bundle materialization skipped for ${artifact.path}`,
      isError: !written,
    })
  }
  for (const artifactPath of materialized.readBackArtifacts) {
    ctx.allToolCalls.push({
      name: "read_file",
      args: { path: artifactPath },
      result: "coherent bundle read-back completed",
      isError: false,
    })
  }

  if (materialized.diagnostics.length > 0) {
    config.onPlannerTrace?.({
      kind: "coherent-generation-failed",
      stage: "materialization",
      diagnostics: [...materialized.diagnostics],
    })
    return { failed: true }
  }

  // Success — set up coherent execution state
  state.coherentExecution = {
    bundle: coherentParse.bundle,
    verificationPlan: buildCoherentVerificationPlan(coherentParse.bundle, config.workspaceRoot),
    repairAttempts: 0,
    escalated: false,
    lastVerifiedToolCallCount: -1,
  }

  config.onPlannerTrace?.({
    kind: "coherent-generation-materialized",
    artifactCount: materialized.writtenArtifacts.length,
    artifacts: [...materialized.writtenArtifacts],
    readBackArtifacts: [...materialized.readBackArtifacts],
  })

  messages.push({
    role: "assistant",
    content:
      `Coherent solution bundle materialized with ${materialized.writtenArtifacts.length} files. ` +
      `Architecture: ${coherentParse.bundle.architecture}`,
    section: "history",
  })
  messages.push({
    role: "system",
    content:
      `A coherent multi-file solution bundle has already been written to disk for this goal.\n` +
      `Files: ${materialized.writtenArtifacts.join(", ")}\n` +
      `Phase 2 starts now: the coherent verifier owns acceptance. Preserve the architecture and file interfaces, and make only targeted fixes if evidence shows problems.\n` +
      `Do NOT redesign or decompose the solution unless verification proves the architecture is broken.`,
    section: "history",
  })

  // Initial verification
  const initialDecision = await ctx.runCoherentVerification(true)
  if (initialDecision && initialDecision.overall !== "pass") {
    const summary = summarizeCoherentVerifierDecision(initialDecision)
    config.onPlannerTrace?.({
      kind: "coherent-generation-repair-needed",
      repairAttempt: 1,
      issueCount: summary.issueCount,
      issues: [...summary.issues],
      affectedArtifacts: [...summary.affectedArtifacts],
    })
    config.onPlannerTrace?.({
      kind: "planner-architecture-state",
      lane: route,
      status: "repairing_in_place",
      reason: "coherent_verifier_requested_repair",
      architecture: coherentParse.bundle.architecture,
    })
    messages.push({
      role: "system",
      content: buildCoherentRepairInstructions(coherentParse.bundle, initialDecision, 1),
      section: "history",
    })
  }

  config.onPlannerTrace?.({
    kind: "coherent-generation-handoff",
    artifactCount: materialized.writtenArtifacts.length,
    verificationRoute: "coherent_verifier_then_direct_tool_loop",
  })

  return { failed: false }
}

async function handleVerificationFailure(
  ctx: PlannerRoutingContext,
  plannerResult: {
    verifierDecision?: VerifierDecision
    plan?: { steps: Array<{ stepType: string; executionContext: { targetArtifacts: string[] } }> }
    answer?: string
  },
  plannerCtx: PlannerContext,
): Promise<string | undefined> {
  const { messages, config } = ctx
  const decision = plannerResult.verifierDecision!

  const unresolvedIssues = decision.steps
    .filter(s => s.outcome !== "pass")
    .flatMap(s => s.issues.filter(i => !i.startsWith("[non-blocking]")))

  const planStepCount = plannerResult.plan?.steps.length ?? 0
  const uniqueTargetArtifacts = new Set(
    (plannerResult.plan?.steps ?? [])
      .flatMap((step) => step.stepType === "subagent_task"
        ? step.executionContext.targetArtifacts
        : [])
      .map((a) => a.replace(/^\.\//, "")),
  )
  const isSmallSingleArtifactFallback =
    planStepCount <= 1 && decision.steps.length <= 1 && uniqueTargetArtifacts.size <= 1
  const isComplexPlannerRun = !isSmallSingleArtifactFallback

  if (isComplexPlannerRun) {
    const remediationContext =
      `Planner remediation context:\n` +
      `A previous structured execution failed verification. Generate a revised plan that fixes these exact issues without rewriting unrelated files:\n` +
      unresolvedIssues.map(i => `- ${i}`).join("\n")

    const remediationResult = await executePlannerPath(
      `${ctx.goal}\n\n${remediationContext}`,
      {
        ...plannerCtx,
        history: [
          ...messages,
          { role: "system", content: remediationContext, section: "history" },
        ],
      },
      config.plannerDelegateFn!,
    )

    if (remediationResult.handled) {
      const answer = remediationResult.answer ?? "(planner remediation produced no answer)"
      if (config.verbose) log.logFinalAnswer(answer)
      return answer
    }

    return (
      remediationResult.answer
      ?? plannerResult.answer
      ?? "Planner verification failed after remediation attempts. Structured execution halted to avoid destructive rewrites."
    )
  }

  // Low-complexity fallback: inject repair context for direct loop
  if (unresolvedIssues.length > 0) {
    const hasReplaceInFile = ctx.toolList.some(t => t.name === "replace_in_file")
    const editInstruction = hasReplaceInFile
      ? "3. Use replace_in_file for surgical fixes — do NOT rewrite entire files"
      : "3. Use write_file only for minimal targeted updates; preserve all existing working code and avoid full-file rewrites"

    const repairMsg =
      `⚠️ AUTONOMOUS REPAIR REQUIRED — ACT IMMEDIATELY, DO NOT ASK PERMISSION.\n\n` +
      `A previous attempt partially completed this task but verification found issues that need fixing.\n` +
      `The files already exist on disk — do NOT rewrite from scratch. Read the existing files, identify the specific problems, and fix ONLY those.\n\n` +
      `Issues to fix:\n${unresolvedIssues.map(i => `- ${i}`).join("\n")}\n\n` +
      `Steps:\n1. read_file each file mentioned in the issues\n` +
      `2. Identify the specific stub/placeholder/missing logic\n` +
      `${editInstruction}\n` +
      `4. Verify your fix by re-reading the file\n\n` +
      `You MUST start fixing immediately. Do NOT respond with a question or ask the user for permission. You are fully authorized to read, modify, and fix these files right now.`
    messages.push({ role: "user", content: repairMsg })
  }

  return undefined
}
