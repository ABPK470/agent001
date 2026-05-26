import { VerifierOutcome } from "../../../../domain/index.js"
/**
 * Completion guards — sequential checks applied when the LLM returns
 * a response with zero tool calls (i.e. it wants to finish).
 *
 * Each guard returns either `null` (allow completion) or a nudge message
 * (block completion and continue the loop). The guards are evaluated in
 * priority order; the first non-null result wins.
 */


import type { PlannerContext, VerifierDecision } from "../../../core/planner.js"
import { MessageRole } from "../../../../domain/enums/message.js"
import type { AgentConfig, Message, Tool } from "../../../../types.js"
import type { AgentLoopState } from "../state.js"
import { checkAnswerStability } from "./answer-stability-guard.js"
import { checkCoherentVerification } from "./check-coherent.js"

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
    enableAnswerStabilityGuard?: boolean
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
  // Phase 4: answer-stability override. If the model has converged on a
  // structurally-identical final answer twice in a row, accept it without
  // running the rest of the guard chain — downstream guards would otherwise
  // re-nudge for verification/grounding and burn iterations re-rendering
  // the same markdown. The function records the current signature on state.
  if (checkAnswerStability(ctx)) return null

  return (
    (await checkCoherentVerification(ctx))
    ?? checkEarlyExit(ctx)
    ?? checkPostDelegationVerification(ctx)
    ?? checkWriteWithoutVerify(ctx)
    ?? checkCodeReviewRequired(ctx)
    ?? checkVerificationFailed(ctx)
    ?? (await checkCompletionValidator(ctx))
    ?? checkPrematureHandoff(ctx)
    ?? checkAnswerGroundedness(ctx)
  )
}

// ── Individual guards ───────────────────────────────────────────

// ── Individual guards ───────────────────────────────────────────

function checkEarlyExit(ctx: CompletionGuardContext): CompletionGuardResult | null {
  const { state, iteration } = ctx
  if (
    iteration === 0
    && ctx.toolList.length > 0
    && !state.earlyExitNudged
    && !(state.coherentExecution?.lastVerifierDecision?.overall === VerifierOutcome.Pass)
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

  // Read-only / analytical delegations have nothing to verify with run_command
  // or read_file. Let the agent answer directly from the child's text result.
  if (state.lastDelegationWasReadOnly) {
    state.lastRoundHadDelegation = false
    state.lastDelegationWasReadOnly = false
    return null
  }

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

/**
 * Detect a degenerate / ungrounded final answer.
 *
 * Symptoms (real example: "There are 4" when the tool returned `distinct_datasets = 4262`):
 *   - Final answer is very short (< 60 chars).
 *   - Most recent tool result contains a clear scalar value (number).
 *   - The answer does NOT contain that exact value.
 *
 * In that case we nudge once: re-read the last tool result and answer again.
 */
function checkAnswerGroundedness(ctx: CompletionGuardContext): CompletionGuardResult | null {
  const { state, response, messages } = ctx
  if (state.groundednessNudged) return null

  const answer = (response.content ?? "").trim()
  if (!answer || answer.length >= 60) return null

  // Find the most recent tool message
  let lastToolContent: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === MessageRole.Tool && typeof m.content === "string" && m.content.trim()) {
      lastToolContent = m.content
      break
    }
    if (m.role === MessageRole.User) break
  }
  if (!lastToolContent) return null

  // Extract candidate scalar values from the tool output.
  // Patterns we care about:
  //   "column = 4262"           → scalar formatter
  //   bare line containing only a number (legacy table format)
  const scalarValues: string[] = []

  // Pattern 1: `name = value` (new scalar format)
  const eqMatch = /^[\w]+\s*=\s*([^\n]+?)\s*$/m.exec(lastToolContent)
  if (eqMatch) scalarValues.push(eqMatch[1].trim())

  // Pattern 2: legacy table — a line containing only a numeric value
  const numericLine = /^\s*(-?\d[\d,]*(?:\.\d+)?)\s*$/m.exec(lastToolContent)
  if (numericLine) scalarValues.push(numericLine[1].trim())

  if (scalarValues.length === 0) return null

  // Normalise: strip commas/whitespace for comparison
  const norm = (s: string): string => s.replace(/[,\s]/g, "")
  const answerNorm = norm(answer)
  const missing = scalarValues.filter((v) => !answerNorm.includes(norm(v)))
  if (missing.length === 0) return null

  state.groundednessNudged = true
  const preview = missing.slice(0, 3).join(", ")
  return {
    tag: "ungrounded-answer",
    message:
      "UNGROUNDED ANSWER: your reply is short and does not contain the value(s) returned by the most recent tool call. " +
      `Expected the answer to reference: ${preview}. ` +
      "Re-read the last tool result and answer the user's question with the exact value(s) from it. " +
      "Do NOT re-run the query — the result is already in your context.",
  }
}

