/**
 * Post-round processing — logic that runs after each tool execution round.
 *
 * Includes: stuck detection, coherent repair stall detection, budget
 * extension, recovery hint injection, and post-delegation verification.
 */

import type { AgentLoopState } from "./agent-loop-state.js"
import * as log from "./logger.js"
import { buildRecoveryHints } from "./recovery.js"
import type { ToolCallRecord } from "./tool-result.js"
import {
    checkToolLoopStuckDetection,
    evaluateToolRoundBudgetExtension,
    summarizeToolRoundProgress,
} from "./tool-utils.js"
import type { AgentConfig, Message } from "./types.js"

const COHERENT_READ_ONLY_ROUND_LIMIT = 2

/** Result of post-round processing. */
export interface PostRoundResult {
  /** If set, the agent should return this as the final answer. */
  finalAnswer?: string
  /** If true, the loop should `continue` to the next iteration. */
  shouldContinue?: boolean
}

export interface PostRoundContext {
  roundToolCalls: ToolCallRecord[]
  response: { content: string | null; toolCalls: readonly { name: string }[] }
  messages: Message[]
  state: AgentLoopState
  iteration: number
  config: {
    maxIterations: number
    verbose: boolean
    deferRecoveryHintsUntilCompletionAttempt: AgentConfig["deferRecoveryHintsUntilCompletionAttempt"]
    onNudge: AgentConfig["onNudge"]
    onPlannerTrace: AgentConfig["onPlannerTrace"]
    onStep: AgentConfig["onStep"]
  }
  allToolCalls: ToolCallRecord[]
  failuresThisRound: number
  delegationThisRound: boolean
}

/**
 * Run all post-round processing. Returns instructions for the loop controller.
 */
export function processPostRound(ctx: PostRoundContext): PostRoundResult {
  const { roundToolCalls, state, messages, config, iteration } = ctx

  // Accumulate tool calls
  ctx.allToolCalls.push(...roundToolCalls)

  // ── Stuck detection ──
  const stuckResult = checkToolLoopStuckDetection(
    roundToolCalls,
    state.toolLoopState,
    state.roundStuckState,
  )
  if (stuckResult.shouldBreak) {
    const stuckMsg = `STUCK DETECTION: ${stuckResult.reason ?? "Tool loop is stuck."}`
    messages.push({ role: "system", content: stuckMsg, section: "history" })
    config.onNudge?.({ tag: "stuck-detection", message: stuckMsg, iteration })
    if (config.verbose) log.logError(`Stuck: ${stuckResult.reason}`)

    const answer = ctx.response.content ?? "(Agent stuck in a tool loop — terminating.)"
    if (config.verbose) log.logFinalAnswer(answer)
    return { finalAnswer: answer }
  }

  // ── Coherent repair stall detection ──
  processCoherentRepairStall(ctx)

  // ── Round progress + budget extension ──
  processRoundBudgetExtension(ctx)

  // ── Checkpoint ──
  state.lastRoundHadDelegation = ctx.delegationThisRound
  state.lastRoundToolCallsSnapshot = roundToolCalls.map(c => ({ name: c.name, isError: c.isError }))

  // ── Recovery hints ──
  injectRecoveryHints(ctx)

  // ── Post-delegation verification analysis ──
  processPostDelegationVerification(ctx)

  config.onStep?.(messages, iteration)
  return {}
}

// ── Internal helpers ────────────────────────────────────────────

function processCoherentRepairStall(ctx: PostRoundContext): void {
  const { state, roundToolCalls, messages, config, iteration } = ctx
  const ce = state.coherentExecution
  if (!ce) return

  const roundHadWrite = roundToolCalls.some(
    tc => !tc.isError && (tc.name === "write_file" || tc.name === "replace_in_file"),
  )
  if (roundHadWrite) {
    state.coherentRepairReadOnlyRounds = 0
    return
  }

  const roundHadRead = roundToolCalls.some(tc => tc.name === "read_file")
  if (!roundHadRead) return

  state.coherentRepairReadOnlyRounds++
  if (state.coherentRepairReadOnlyRounds < COHERENT_READ_ONLY_ROUND_LIMIT) return

  state.coherentRepairReadOnlyRounds = 0
  const repairFiles = ce.bundle.artifacts.map(a => a.path).join(", ")
  const spinMsg =
    `REPAIR STALL DETECTED: You have read files ${COHERENT_READ_ONLY_ROUND_LIMIT} iterations in a row without writing anything. ` +
    `Stop reading and write the fix NOW.\n` +
    `Files in scope: ${repairFiles}\n` +
    `REQUIRED NEXT ACTION: call write_file (or replace_in_file) to apply the fix. ` +
    `If the write guard is blocking you because a function is missing, include ALL existing functions PLUS the fix in your write. ` +
    `If the issue requires restructuring (e.g. removing an ES module import), restructure now — rewrite the entire affected file.`
  messages.push({ role: "system", content: spinMsg, section: "history" })
  config.onNudge?.({ tag: "coherent-repair-stall", message: spinMsg, iteration })
  if (config.verbose) log.logError(`Coherent repair stall at iteration ${iteration}`)
}

function processRoundBudgetExtension(ctx: PostRoundContext): void {
  const { roundToolCalls, state, config } = ctx
  const roundProgress = summarizeToolRoundProgress(
    roundToolCalls,
    0, // roundDurationMs not tracked per-round
    state.seenSuccessfulSemanticKeys,
    state.seenVerificationFailureDiagKeys,
  )
  state.recentRoundSummaries.push(roundProgress)
  if (state.recentRoundSummaries.length > 5) state.recentRoundSummaries.shift()

  if (roundProgress.hadVerificationCall || roundProgress.hadSuccessfulMutation) {
    const budgetExt = evaluateToolRoundBudgetExtension({
      currentLimit: config.maxIterations,
      maxAbsoluteLimit: state.absoluteIterationCap,
      recentRounds: state.recentRoundSummaries,
      remainingToolBudget: config.maxIterations - ctx.iteration,
    })
    if (budgetExt.decision === "extended" && budgetExt.newLimit > config.maxIterations) {
      if (config.verbose) {
        log.logError(`Budget extension: ${config.maxIterations} → ${budgetExt.newLimit} (${budgetExt.extensionReason})`)
      }
      config.maxIterations = budgetExt.newLimit
    }
  }
}

function injectRecoveryHints(ctx: PostRoundContext): void {
  const { roundToolCalls, state, messages, config, iteration } = ctx
  const recoveryHints = buildRecoveryHints(roundToolCalls, state.emittedRecoveryHints)
  for (const hint of recoveryHints) {
    if (config.deferRecoveryHintsUntilCompletionAttempt && !state.completionAttempted) continue
    const hintMsg = `RECOVERY HINT: ${hint.message}`
    messages.push({ role: "system", content: hintMsg, section: "history" })
    config.onNudge?.({ tag: `recovery-hint:${hint.key}`, message: hintMsg, iteration })
    if (config.verbose) {
      log.logError(`Recovery hint [${hint.key}]: ${hint.message.slice(0, 100)}`)
    }
  }
}

function processPostDelegationVerification(ctx: PostRoundContext): void {
  const { state, messages, config, iteration, response, failuresThisRound } = ctx
  if (!state.inPostDelegationVerification) return

  state.inPostDelegationVerification = false

  const roundToolResults = messages
    .slice(-response.toolCalls.length * 2)
    .filter((m) => m.role === "tool")
    .map((m) => m.content ?? "")

  const hasErrors = roundToolResults.some((r) =>
    /error|fail|exception|not found/i.test(r) && !/no errors/i.test(r),
  )

  const toolNamesUsed = response.toolCalls.map((c) => c.name)
  const didCodeReview = toolNamesUsed.includes("read_file")
  const didOnlySurfaceCheck = !didCodeReview && (
    toolNamesUsed.includes("browser_check") || toolNamesUsed.includes("list_directory")
  )

  if (hasErrors || failuresThisRound > 0) {
    state.verificationFoundIssues = true
  } else if (didOnlySurfaceCheck) {
    state.inPostDelegationVerification = true
    const incompleteMsg =
      "INCOMPLETE VERIFICATION: You ran browser_check or list_directory but did NOT review " +
      "the actual code with read_file. A page loading without JS errors does NOT mean the logic is correct. " +
      "You MUST now use read_file on the main code files (JS/TS) to verify that:\n" +
      "- All functions contain REAL logic (not stubs like `return true`)\n" +
      "- All required features exist (not just a skeleton)\n" +
      "- There are no TODO comments or placeholder implementations\n" +
      "If you find issues, fix them directly or re-delegate."
    messages.push({ role: "system", content: incompleteMsg, section: "history" })
    config.onNudge?.({ tag: "incomplete-verification", message: incompleteMsg, iteration })
  }
}
