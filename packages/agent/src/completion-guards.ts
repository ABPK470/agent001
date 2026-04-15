/**
 * Completion guards — sequential checks applied when the LLM returns
 * a response with zero tool calls (i.e. it wants to finish).
 *
 * Each guard returns either `null` (allow completion) or a nudge message
 * (block completion and continue the loop). The guards are evaluated in
 * priority order; the first non-null result wins.
 */

import type { AgentLoopState } from "./agent-loop-state.js"
import {
    buildCoherentPlannerEscalationGoal,
    buildCoherentRepairInstructions,
    summarizeCoherentVerifierDecision,
} from "./planner/coherent.js"
import type { PlannerContext } from "./planner/index.js"
import { executePlannerPath } from "./planner/index.js"
import type { VerifierDecision } from "./planner/types.js"
import type { AgentConfig, Message, Tool } from "./types.js"

/** Result from a completion guard check. */
export interface CompletionGuardResult {
  /** If non-null, the tag for the nudge event. */
  tag: string
  /** The message to inject into the conversation. */
  message: string
  /** If set, the agent should return this as the final answer immediately. */
  finalAnswer?: string
}

/** Context passed to completion guards. */
export interface CompletionGuardContext {
  response: { content: string | null; toolCalls: readonly unknown[] }
  messages: Message[]
  iteration: number
  state: AgentLoopState
  toolList: Tool[]
  config: {
    maxIterations: number
    enablePlanner: boolean
    plannerDelegateFn: AgentConfig["plannerDelegateFn"]
    completionValidator: AgentConfig["completionValidator"]
    verbose: boolean
  }
  /** Callback to run coherent verification. */
  runCoherentVerification: (force?: boolean) => Promise<VerifierDecision | null>
  /** Callback to create a planner context. */
  createPlannerContext: () => PlannerContext
  /** Callback to log planner trace events. */
  onPlannerTrace: AgentConfig["onPlannerTrace"]
}

/**
 * Run all completion guards in order. Returns the first guard result
 * that fires, or null if the agent is allowed to complete.
 */
export async function runCompletionGuards(
  ctx: CompletionGuardContext,
): Promise<CompletionGuardResult | null> {
  return (
    (await checkCoherentVerification(ctx))
    ?? checkEarlyExit(ctx)
    ?? checkPostDelegationVerification(ctx)
    ?? checkWriteWithoutVerify(ctx)
    ?? checkCodeReviewRequired(ctx)
    ?? checkVerificationFailed(ctx)
    ?? (await checkCompletionValidator(ctx))
    ?? checkPrematureHandoff(ctx)
  )
}

// ── Individual guards ───────────────────────────────────────────

async function checkCoherentVerification(
  ctx: CompletionGuardContext,
): Promise<CompletionGuardResult | null> {
  const { state, response } = ctx
  const ce = state.coherentExecution
  if (!ce) return null

  const decision = await ctx.runCoherentVerification(false)
  if (!decision) return null

  // Pass → allow immediate completion (bypasses other guards intentionally)
  if (decision.overall === "pass") {
    return {
      tag: "coherent-pass",
      message: "",
      finalAnswer: response.content ?? "(no response)",
    }
  }

  // Fail → attempt repair
  const summary = summarizeCoherentVerifierDecision(decision)
  const nextRepairAttempt = ce.repairAttempts + 1

  ctx.onPlannerTrace?.({
    kind: "coherent-generation-repair-needed",
    repairAttempt: nextRepairAttempt,
    issueCount: summary.issueCount,
    issues: [...summary.issues],
    affectedArtifacts: [...summary.affectedArtifacts],
  })
  ctx.onPlannerTrace?.({
    kind: "planner-architecture-state",
    lane: "bounded_coherent_generation",
    status: "repairing_in_place",
    reason: "coherent_completion_blocked_by_verifier",
    architecture: ce.bundle.architecture,
  })

  // First repair attempt
  if (ce.repairAttempts < 1) {
    ce.repairAttempts = nextRepairAttempt
    const repairMsg = buildCoherentRepairInstructions(ce.bundle, decision, nextRepairAttempt)
    return { tag: "coherent-repair-required", message: repairMsg }
  }

  // Escalation to planner
  if (!ce.escalated && ctx.config.enablePlanner && ctx.config.plannerDelegateFn) {
    ce.escalated = true
    ctx.onPlannerTrace?.({
      kind: "coherent-generation-escalated",
      target: "planner_repair_path",
      issueCount: summary.issueCount,
      reason: "coherent_repair_still_failing",
    })
    ctx.onPlannerTrace?.({
      kind: "planner-architecture-state",
      lane: "bounded_coherent_generation",
      status: "abandoned",
      reason: "coherent_repair_still_failing",
      architecture: ce.bundle.architecture,
    })

    const remediationResult = await executePlannerPath(
      buildCoherentPlannerEscalationGoal(ctx.messages[1]?.content ?? "", ce.bundle, decision),
      ctx.createPlannerContext(),
      ctx.config.plannerDelegateFn,
    )

    if (remediationResult.handled) {
      return {
        tag: "coherent-escalation",
        message: "",
        finalAnswer: remediationResult.answer ?? "(planner remediation produced no answer)",
      }
    }
  }

  // Fallback repair
  ce.repairAttempts = nextRepairAttempt
  const fallbackMsg = buildCoherentRepairInstructions(ce.bundle, decision, nextRepairAttempt)

  // Hard exit after too many repair attempts
  if (nextRepairAttempt > 4) {
    return {
      tag: "coherent-repair-exhausted",
      message: fallbackMsg,
      finalAnswer: response.content ?? "(coherent generation completed — verifier disagreement unresolved)",
    }
  }

  return { tag: "coherent-repair-required", message: fallbackMsg }
}

function checkEarlyExit(ctx: CompletionGuardContext): CompletionGuardResult | null {
  const { state, iteration } = ctx
  if (
    iteration === 0
    && ctx.toolList.length > 0
    && !state.earlyExitNudged
    && !(state.coherentExecution?.lastVerifierDecision?.overall === "pass")
  ) {
    state.earlyExitNudged = true
    return {
      tag: "early-exit-nudge",
      message:
        "You returned a text response without using any tools. " +
        "You MUST use your tools to accomplish the goal — do not just describe a plan. " +
        "Start working now by calling the appropriate tools.",
    }
  }
  return null
}

function checkPostDelegationVerification(ctx: CompletionGuardContext): CompletionGuardResult | null {
  const { state } = ctx
  if (!state.lastRoundHadDelegation) return null

  state.lastRoundHadDelegation = false
  state.inPostDelegationVerification = true
  return {
    tag: "verification-required",
    message:
      "VERIFICATION REQUIRED: You just received a delegation result but attempted to " +
      "finish without verifying. You MUST verify with MULTIPLE tools now:\n" +
      "- For web projects → BOTH browser_check on the main HTML file AND read_file on the key JS/code files to check for stubs, TODO comments, or placeholder logic\n" +
      "- For code → run_command to compile/test AND read_file to review implementation quality\n" +
      "- For files → list_directory AND read_file to confirm content and completeness\n" +
      "A page loading without errors does NOT mean it works correctly. You must review the actual code.\n" +
      "Do NOT provide a final answer until you have independently verified the output.",
  }
}

function checkWriteWithoutVerify(ctx: CompletionGuardContext): CompletionGuardResult | null {
  const { state } = ctx
  if (!state.wroteUnverifiedFiles || state.writeVerifyNudged) return null

  state.wroteUnverifiedFiles = false
  state.writeVerifyNudged = true
  return {
    tag: "write-without-verify",
    message:
      "WRITE-WITHOUT-VERIFY: You wrote code files but attempted to finish without " +
      "reviewing them. You MUST use read_file to review every file you wrote — look for " +
      "corrupted code, gibberish, incomplete functions, or syntax errors. Then use " +
      "browser_check or run_command to verify the output actually works. " +
      "Do NOT finish until you have confirmed your code is correct.",
  }
}

function checkCodeReviewRequired(ctx: CompletionGuardContext): CompletionGuardResult | null {
  const { state } = ctx
  if (state.writtenButNotReread.size === 0 || state.writeReviewNudged) return null

  state.writeReviewNudged = true
  const fileList = [...state.writtenButNotReread].slice(0, 5).join(", ")
  return {
    tag: "code-review-required",
    message:
      "CODE REVIEW REQUIRED: You wrote code files but only ran browser_check, which " +
      "only catches JavaScript load errors — it cannot verify logical correctness. " +
      `You MUST use read_file to review your code in: ${fileList}\n` +
      "For each file, check:\n" +
      "1. Every helper function does what its name implies (trace through an example)\n" +
      "2. ALL acceptance criteria have corresponding real logic (not just function names)\n" +
      "3. No comparison or logic errors (e.g. case-insensitive compare where case matters)\n" +
      "Do NOT finish until you have read and verified every code file.",
  }
}

function checkVerificationFailed(ctx: CompletionGuardContext): CompletionGuardResult | null {
  const { state } = ctx
  if (!state.verificationFoundIssues) return null

  state.verificationFoundIssues = false
  return {
    tag: "verification-failed",
    message:
      "VERIFICATION FAILED: Your verification step revealed errors, but you attempted " +
      "to finish without fixing them. You MUST either:\n" +
      "1. Fix the issues directly (edit files, run commands)\n" +
      "2. Re-delegate the task with specific error details\n" +
      "Do NOT suggest manual workarounds (like 'start an HTTP server'). Fix the actual problem.",
  }
}

async function checkCompletionValidator(
  ctx: CompletionGuardContext,
): Promise<CompletionGuardResult | null> {
  const { state, config } = ctx
  if (!config.completionValidator || state.completionValidated) return null

  state.completionValidated = true
  try {
    const issues = await config.completionValidator()
    if (issues) {
      return { tag: "completion-validator", message: issues }
    }
  } catch {
    /* validator failed — don't block the agent */
  }
  return null
}

function checkPrematureHandoff(ctx: CompletionGuardContext): CompletionGuardResult | null {
  const { state, response, iteration, config, toolList } = ctx
  const answer = response.content ?? "(no response)"

  const asksToContinue = /\b(?:would you like me to|do you want me to|should i (?:continue|proceed|implement|fix))\b/i.test(answer)
  const unresolvedGaps = /\b(?:unimplemented|not implemented|missing|placeholder|issues and deficiencies|plan for fixes|further refinements?|full compliance may require|may require additional|not fully (?:implemented|complete)|deep validation|additional delegation)\b/i.test(answer)

  if (
    toolList.length > 0
    && (asksToContinue || unresolvedGaps)
    && state.prematureHandoffNudges < 3
    && iteration < config.maxIterations - 1
  ) {
    state.prematureHandoffNudges += 1
    return {
      tag: "premature-handoff",
      message:
        "PREMATURE HANDOFF DETECTED: Do not ask the user whether to continue and do not stop at partial completion language. " +
        "Use tools now to implement and verify any missing parts, then return a completed result with concrete evidence.",
    }
  }
  return null
}
