/**
 * Completion policy — rules applied when the model returns zero tool calls.
 */

import type { AgentConfig, Message } from "../../../../domain/agent-types.js"
import { MessageRole } from "../../../../domain/enums/message.js"
import { isDirectDialogueGoal } from "../../../core/goal-intent.js"
import { checkAnswerStability } from "./answer-stability.js"
import type { CompletionBlock, CompletionRule, CompletionRuleAsync, LoopPolicyContext } from "./types.js"

function earlyExit(ctx: LoopPolicyContext): CompletionBlock | null {
  const { state, iteration, userGoal, toolList } = ctx
  if (!userGoal || isDirectDialogueGoal(userGoal, { messages: ctx.messages })) return null
  if (iteration !== 0 || toolList.length === 0 || state.earlyExitNudged) return null

  state.earlyExitNudged = true
  return {
    tag: "early-exit-nudge",
    message:
      "You returned a text response without using any tools. " +
      "You MUST use your tools to accomplish the goal — do not just describe a plan. " +
      "Start working now by calling the appropriate tools."
  }
}

function postDelegationVerification(ctx: LoopPolicyContext): CompletionBlock | null {
  const { state } = ctx
  if (!state.lastRoundHadDelegation) return null

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
      "Do NOT provide a final answer until you have independently verified the output."
  }
}

function writeWithoutVerify(ctx: LoopPolicyContext): CompletionBlock | null {
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
      "Do NOT finish until you have confirmed your code is correct."
  }
}

function codeReviewRequired(ctx: LoopPolicyContext): CompletionBlock | null {
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
      "Do NOT finish until you have read and verified every code file."
  }
}

function verificationFailed(ctx: LoopPolicyContext): CompletionBlock | null {
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
      "Do NOT suggest manual workarounds (like 'start an HTTP server'). Fix the actual problem."
  }
}

const completionValidator: CompletionRuleAsync = async (ctx) => {
  const { state, config } = ctx
  if (!config?.completionValidator || state.completionValidated) return null

  state.completionValidated = true
  try {
    const issues = await config.completionValidator()
    if (issues) return { tag: "completion-validator", message: issues }
  } catch {
    /* validator failed — don't block the agent */
  }
  return null
}

function prematureHandoff(ctx: LoopPolicyContext): CompletionBlock | null {
  const { state, response, iteration, config, toolList } = ctx
  if (!response || !config) return null

  const answer = response.content ?? "(no response)"
  const asksToContinue =
    /\b(?:would you like me to|do you want me to|should i (?:continue|proceed|implement|fix))\b/i.test(answer)
  const unresolvedGaps =
    /\b(?:unimplemented|not implemented|missing|placeholder|issues and deficiencies|plan for fixes|further refinements?|full compliance may require|may require additional|not fully (?:implemented|complete)|deep validation|additional delegation)\b/i.test(
      answer
    )

  if (
    toolList.length > 0 &&
    (asksToContinue || unresolvedGaps) &&
    state.prematureHandoffNudges < 3 &&
    iteration < config.maxIterations - 1
  ) {
    state.prematureHandoffNudges += 1
    return {
      tag: "premature-handoff",
      message:
        "PREMATURE HANDOFF DETECTED: Do not ask the user whether to continue and do not stop at partial completion language. " +
        "Use tools now to implement and verify any missing parts, then return a completed result with concrete evidence."
    }
  }
  return null
}

function answerGroundedness(ctx: LoopPolicyContext): CompletionBlock | null {
  const { state, response, messages } = ctx
  if (!response || state.groundednessNudged) return null

  const answer = (response.content ?? "").trim()
  if (!answer || answer.length >= 60) return null

  let lastToolContent: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === MessageRole.Tool && typeof m.content === "string" && m.content.trim()) {
      lastToolContent = m.content
      break
    }
    if (m.role === MessageRole.User) break
  }
  if (!lastToolContent) return null

  const scalarValues: string[] = []
  const eqMatch = /^[\w]+\s*=\s*([^\n]+?)\s*$/m.exec(lastToolContent)
  if (eqMatch) scalarValues.push(eqMatch[1]!.trim())

  const numericLine = /^\s*(-?\d[\d,]*(?:\.\d+)?)\s*$/m.exec(lastToolContent)
  if (numericLine) scalarValues.push(numericLine[1]!.trim())

  if (scalarValues.length === 0) return null

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
      "Do NOT re-run the query — the result is already in your context."
  }
}

const COMPLETION_RULES: readonly CompletionRule[] = [
  earlyExit,
  postDelegationVerification,
  writeWithoutVerify,
  codeReviewRequired,
  verificationFailed,
  prematureHandoff,
  answerGroundedness
]

const ASYNC_COMPLETION_RULES: readonly CompletionRuleAsync[] = [completionValidator]

/**
 * Evaluate completion policy. Returns a block when the run must continue,
 * or null when the model may finish.
 */
export async function guardCompletion(ctx: LoopPolicyContext): Promise<CompletionBlock | null> {
  if (!ctx.response) return null

  if (checkAnswerStability(ctx)) return null

  for (const rule of COMPLETION_RULES) {
    const block = rule(ctx)
    if (block) return block
  }

  for (const rule of ASYNC_COMPLETION_RULES) {
    const block = await rule(ctx)
    if (block) return block
  }

  return null
}

/** Build a completion context from the agent loop. */
export function completionContext(input: {
  response: { content: string | null; toolCalls: readonly unknown[] }
  messages: Message[]
  iteration: number
  userGoal: string
  state: LoopPolicyContext["state"]
  toolList: LoopPolicyContext["toolList"]
  config: AgentConfig
  onPlannerTrace?: AgentConfig["onPlannerTrace"]
}): LoopPolicyContext {
  return {
    iteration: input.iteration,
    userGoal: input.userGoal,
    messages: input.messages,
    state: input.state,
    toolList: input.toolList,
    availableToolNames: input.toolList.map((t) => t.name),
    response: input.response,
    config: {
      maxIterations: input.config.maxIterations ?? 30,
      enablePlanner: input.config.enablePlanner ?? false,
      plannerDelegateFn: input.config.plannerDelegateFn,
      completionValidator: input.config.completionValidator,
      enableAnswerStabilityGuard: input.config.enableAnswerStabilityGuard,
      verbose: input.config.verbose ?? false
    },
    onPlannerTrace: input.onPlannerTrace
  }
}

/** Build a turn-start context from iteration prep. */
export function turnStartContext(input: {
  iteration: number
  userGoal: string
  messages: readonly Message[]
  state: LoopPolicyContext["state"]
  toolList: LoopPolicyContext["toolList"]
}): LoopPolicyContext {
  return {
    iteration: input.iteration,
    userGoal: input.userGoal,
    messages: input.messages,
    state: input.state,
    toolList: input.toolList,
    availableToolNames: input.toolList.map((t) => t.name)
  }
}
