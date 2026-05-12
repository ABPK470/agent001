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

const COHERENT_READ_ONLY_ROUND_LIMIT = 1

/** Result of post-round processing. */
export interface PostRoundResult {
  /** If set, the agent should return this as the final answer. */
  finalAnswer?: string
  /** If true, the loop should `continue` to the next iteration. */
  shouldContinue?: boolean
  /**
   * If true, the loop controller must make one final no-tool LLM call to
   * synthesize a proper answer from everything gathered so far.
   * The synthesis instruction has already been appended to `messages`.
   */
  needsSynthesis?: boolean
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
  /** True when the only delegation this round was restricted to read-only tools. */
  delegationThisRoundWasReadOnly: boolean
}

/**
 * Run all post-round processing. Returns instructions for the loop controller.
 */
export function processPostRound(ctx: PostRoundContext): PostRoundResult {
  const { roundToolCalls, state, messages, config, iteration } = ctx

  // Accumulate tool calls
  ctx.allToolCalls.push(...roundToolCalls)

  // ── Sync preview stop — MANDATORY ──
  // After sync_preview completes, the agent MUST stop and return the preview
  // to the user for a human decision. The agent must NEVER autonomously
  // continue to sync_execute. This is a hard safety boundary.
  const didPreview = roundToolCalls.some(
    tc => tc.name === "sync_preview" && !tc.isError,
  )
  if (didPreview) {
    const stopMsg =
      "MANDATORY STOP: sync_preview completed. You MUST present the preview results to the user NOW and STOP. " +
      "Do NOT call sync_execute. Do NOT continue with any further tool calls. " +
      "The user must explicitly decide whether to execute the sync plan. " +
      "Write your final answer with the preview summary, dashboard, and the sync_execute command the user can reply with."
    messages.push({ role: "system", content: stopMsg, section: "history" })
    config.onNudge?.({ tag: "sync-preview-stop", message: stopMsg, iteration })
    return { needsSynthesis: true }
  }

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

    // Do NOT return the raw last LLM response or a hardcoded error string.
    // Instead, ask the loop controller to make one final no-tool synthesis call
    // so the model can write a proper answer from everything it gathered.
    const synthesisInstruction =
      "You have reached a tool-loop limit. STOP calling tools immediately. " +
      "Write your final answer now using only the information you have already gathered. " +
      "If you could not complete the task, clearly explain what you found so far and what is still unknown."
    messages.push({ role: "system", content: synthesisInstruction, section: "history" })
    return { needsSynthesis: true }
  }

  // ── Coherent repair stall detection ──
  processCoherentRepairStall(ctx)

  // ── Excessive read_file detection ──
  processExcessiveReadFiles(ctx)

  // ── Round progress + budget extension ──
  processRoundBudgetExtension(ctx)

  // ── Checkpoint ──
  state.lastRoundHadDelegation = ctx.delegationThisRound
  state.lastDelegationWasReadOnly = ctx.delegationThisRound && ctx.delegationThisRoundWasReadOnly
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
    `REPAIR STALL DETECTED: You read files without writing anything in the previous iteration. ` +
    `Stop reading and write the fix NOW.\n` +
    `Files in scope: ${repairFiles}\n` +
    `REQUIRED NEXT ACTION: call write_file (or replace_in_file) to apply the fix. ` +
    `If the write guard is blocking you because a function is missing, include ALL existing functions PLUS the fix in your write. ` +
    `If the issue requires restructuring (e.g. removing an ES module import), restructure now — rewrite the entire affected file.`
  messages.push({ role: "system", content: spinMsg, section: "history" })
  config.onNudge?.({ tag: "coherent-repair-stall", message: spinMsg, iteration })
  if (config.verbose) log.logError(`Coherent repair stall at iteration ${iteration}`)
}

/**
 * Fires a nudge when the agent reads files excessively — either within a
 * single round (>4 reads) OR cumulatively across rounds without writing
 * (sandwich-read pattern: same file re-read via both relative and absolute
 * sandbox path many times while no writes happen).
 *
 * Two thresholds:
 *  - Per-round: > 4 reads in one round → immediate nudge
 *  - Cumulative: any single file (by basename) read > 5 times total → nudge
 *    (resets on any successful write_file / replace_in_file)
 */
function processExcessiveReadFiles(ctx: PostRoundContext): void {
  const { roundToolCalls, state, messages, config, iteration } = ctx

  const reads = roundToolCalls.filter(tc => tc.name === "read_file" && !tc.isError)
  if (reads.length === 0) return

  // Accumulate cumulative read counts per basename.
  // Reset on write so the counter tracks reads *without writes*.
  const roundHadWrite = roundToolCalls.some(
    tc => !tc.isError && (tc.name === "write_file" || tc.name === "replace_in_file"),
  )
  if (roundHadWrite) {
    // Writing is progress — clear the slate
    state.cumulativeReadFileHistory.clear()
  }

  const pathsRead = reads.map(tc => {
    const p = String(tc.args["path"] ?? "")
    return p.split(/[\\/]/).pop() ?? p
  })

  for (const basename of pathsRead) {
    state.cumulativeReadFileHistory.set(
      basename,
      (state.cumulativeReadFileHistory.get(basename) ?? 0) + 1,
    )
  }

  // Per-round threshold: > 4 reads in this single round
  if (reads.length > 4) {
    const uniqueFiles = new Set(pathsRead)
    const msg =
      `OVER-READING: You called read_file ${reads.length} times this iteration` +
      (uniqueFiles.size < reads.length
        ? ` (reading ${reads.length - uniqueFiles.size} duplicate file(s): ${
            pathsRead.filter((p, i) => pathsRead.indexOf(p) !== i).join(", ")})`
        : "") +
      `. Stop re-reading files — you already have the content you need. ` +
      `Do NOT read absolute sandbox/temp paths; use relative project paths only. ` +
      `Proceed to write your next change.`
    messages.push({ role: "system", content: msg, section: "history" })
    config.onNudge?.({ tag: "excessive-reads", message: msg, iteration })
    if (config.verbose) log.logError(`Excessive reads: ${reads.length} read_file calls at iteration ${iteration}`)
    return
  }

  // Cumulative threshold: any file read > 5 times without a write in between
  const overReadFiles = [...state.cumulativeReadFileHistory.entries()]
    .filter(([, count]) => count > 5)
    .map(([basename]) => basename)

  if (overReadFiles.length > 0) {
    const msg =
      `REPEATED READS WITHOUT PROGRESS: You have read ${overReadFiles.map(f => `"${f}"`).join(", ")} ` +
      `more than 5 times across iterations without writing anything. ` +
      `Reading the same file repeatedly via different paths (relative vs absolute /var/folders/...) ` +
      `gives you the same truncated view every time. ` +
      `You already have all the file content available. Stop reading and write your fix now.`
    messages.push({ role: "system", content: msg, section: "history" })
    config.onNudge?.({ tag: "excessive-reads-cumulative", message: msg, iteration })
    if (config.verbose) log.logError(`Cumulative excessive reads: ${overReadFiles.join(", ")} at iteration ${iteration}`)
    // Reset so the nudge doesn't fire every iteration after this
    for (const f of overReadFiles) state.cumulativeReadFileHistory.delete(f)
  }
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
