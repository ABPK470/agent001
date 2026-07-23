/**
 * Tool round progress summarization and budget extension decisions.
 *
 * Tracks verification calls, mutations, new semantic keys, and failure diagnostics
 * across tool rounds to make informed budget extension decisions.
 *
 * @module
 */

import type { ToolRoundProgressSummary } from "../../domain/types/tool-loop-state.js"
import type { ToolCallRecord } from "./result.js"
import { buildSemanticToolCallKey, didToolCallFail, extractToolFailureText } from "./result.js"

export type { ToolRoundProgressSummary } from "../../domain/types/tool-loop-state.js"

// ============================================================================
// Constants
// ============================================================================

/** Strip ANSI escapes for diagnostic key normalization. */
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

/** Tokens that indicate a verification/check command. */
const VERIFICATION_TOKENS = new Set([
  "build",
  "check",
  "compile",
  "coverage",
  "lint",
  "test",
  "typecheck",
  "verify"
])

/** Commands that, when leading, indicate a verification invocation. */
const VERIFICATION_COMMANDS = new Set([
  "cargo",
  "deno",
  "go",
  "gradle",
  "jest",
  "mvn",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python",
  "python3",
  "pytest",
  "ruff",
  "tsc",
  "uv",
  "vitest",
  "yarn",
  "bun"
])

/** Commands that indicate workspace mutations. */
const MUTATING_COMMANDS = new Set(["cp", "git", "install", "mkdir", "mv", "perl", "rm", "sed", "touch"])

// ============================================================================
// Progress summary
// ============================================================================

/**
 * Summarize a tool round's progress for budget extension decisions.
 *
 * Detects:
 *   - Verification calls (test/build/lint commands)
 *   - Mutation calls (file writes, git, npm install, etc.)
 *   - New unique semantic keys (calls not seen before)
 *   - New unique failure diagnostic keys
 */
export function summarizeToolRoundProgress(
  roundCalls: readonly ToolCallRecord[],
  durationMs: number,
  seenSuccessfulSemanticKeys: Set<string>,
  seenVerificationFailureDiagnosticKeys: Set<string>
): ToolRoundProgressSummary {
  let successfulCalls = 0
  let newSuccessfulSemanticKeys = 0
  let newVerificationFailureDiagnosticKeys = 0
  let hadSuccessfulMutation = false
  let hadVerificationCall = false
  let hadReadCall = false

  for (const call of roundCalls) {
    if (isVerificationToolCall(call)) {
      hadVerificationCall = true
      if (didToolCallFail(call.isError, call.result)) {
        const diagKey = buildFailureDiagnosticKey(call)
        if (diagKey && !seenVerificationFailureDiagnosticKeys.has(diagKey)) {
          seenVerificationFailureDiagnosticKeys.add(diagKey)
          newVerificationFailureDiagnosticKeys++
        }
      }
    }
    if (call.name === "read_file" && !didToolCallFail(call.isError, call.result)) {
      hadReadCall = true
    }
    if (isSuccessfulMutationToolCall(call)) {
      hadSuccessfulMutation = true
    }
    if (didToolCallFail(call.isError, call.result)) continue
    successfulCalls++
    const semanticKey = buildSemanticToolCallKey(call.name, call.args)
    if (!seenSuccessfulSemanticKeys.has(semanticKey)) {
      seenSuccessfulSemanticKeys.add(semanticKey)
      newSuccessfulSemanticKeys++
    }
  }

  return {
    durationMs,
    totalCalls: roundCalls.length,
    successfulCalls,
    newSuccessfulSemanticKeys,
    newVerificationFailureDiagnosticKeys,
    hadSuccessfulMutation,
    hadVerificationCall,
    hadReadCall,
    hadMaterialProgress: newSuccessfulSemanticKeys > 0 || newVerificationFailureDiagnosticKeys > 0
  }
}

// ============================================================================
// Budget extension
// ============================================================================

export interface ToolRoundBudgetExtensionResult {
  readonly decision: "extended" | "capped" | "not_needed"
  readonly extensionRounds: number
  readonly newLimit: number
  readonly extensionReason?: string
  readonly recentProgressRate: number
  readonly latestRoundHadMaterialProgress: boolean
  readonly repairCycleDetected: boolean
}

/** Geometric decay weight applied to older rounds. */
const PROGRESS_RATE_DECAY = 0.7

/**
 * Evaluate whether the tool round budget should be extended based on
 * recent progress metrics.
 *
 * Enhancement over baseline (agenc-core patterns):
 *  - Weighted progress rate: recent rounds count more (geometric decay).
 *  - Cross-round repair cycle detection: (read) → (verify) → (mutation) across up to 3 rounds.
 *  - Wall clock gate: optional hard deadline — don't extend when time is almost up.
 *  - Extension size: repair_episode → 3 rounds, sustained_progress → 2 rounds.
 */
export function evaluateToolRoundBudgetExtension(params: {
  readonly currentLimit: number
  readonly maxAbsoluteLimit: number
  readonly recentRounds: readonly ToolRoundProgressSummary[]
  readonly remainingToolBudget: number
  readonly startTimeMs?: number
  readonly maxWallClockMs?: number
}): ToolRoundBudgetExtensionResult {
  const { currentLimit, maxAbsoluteLimit, recentRounds, remainingToolBudget } = params

  if (currentLimit >= maxAbsoluteLimit) {
    return {
      decision: "capped",
      extensionRounds: 0,
      newLimit: currentLimit,
      recentProgressRate: 0,
      latestRoundHadMaterialProgress: false,
      repairCycleDetected: false
    }
  }
  if (recentRounds.length === 0) {
    return {
      decision: "not_needed",
      extensionRounds: 0,
      newLimit: currentLimit,
      recentProgressRate: 0,
      latestRoundHadMaterialProgress: false,
      repairCycleDetected: false
    }
  }

  if (params.startTimeMs != null && params.maxWallClockMs != null) {
    const elapsedMs = Date.now() - params.startTimeMs
    if (elapsedMs > params.maxWallClockMs * 0.85) {
      return {
        decision: "not_needed",
        extensionRounds: 0,
        newLimit: currentLimit,
        recentProgressRate: 0,
        latestRoundHadMaterialProgress: false,
        repairCycleDetected: false
      }
    }
  }

  const latestRound = recentRounds[recentRounds.length - 1]

  let weightedProgressSum = 0
  let weightTotal = 0
  for (let j = 0; j < recentRounds.length; j++) {
    const weight = Math.pow(PROGRESS_RATE_DECAY, recentRounds.length - 1 - j)
    weightedProgressSum += weight * (recentRounds[j].hadMaterialProgress ? 1 : 0)
    weightTotal += weight
  }
  const recentProgressRate = weightTotal > 0 ? weightedProgressSum / weightTotal : 0

  let repairCycleDetected = false
  if (recentRounds.length >= 3) {
    const prev2 = recentRounds[recentRounds.length - 3]
    const prev1 = recentRounds[recentRounds.length - 2]
    if (prev2.hadReadCall && prev1.hadVerificationCall && latestRound.hadSuccessfulMutation) {
      repairCycleDetected = true
    }
  }
  if (!repairCycleDetected && recentRounds.length >= 2) {
    const prev1 = recentRounds[recentRounds.length - 2]
    if (prev1.hadVerificationCall && latestRound.hadSuccessfulMutation) {
      repairCycleDetected = true
    }
  }
  const isInRoundRepair = latestRound.hadSuccessfulMutation && latestRound.hadVerificationCall

  const shouldExtend = recentProgressRate >= 0.5 || repairCycleDetected || isInRoundRepair

  if (!shouldExtend) {
    return {
      decision: "not_needed",
      extensionRounds: 0,
      newLimit: currentLimit,
      recentProgressRate,
      latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
      repairCycleDetected
    }
  }

  let extensionRounds = repairCycleDetected ? 3 : 2
  if (remainingToolBudget > 10) extensionRounds++

  const newLimit = Math.min(currentLimit + extensionRounds, maxAbsoluteLimit)
  extensionRounds = newLimit - currentLimit

  if (extensionRounds <= 0) {
    return {
      decision: "capped",
      extensionRounds: 0,
      newLimit: currentLimit,
      recentProgressRate,
      latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
      repairCycleDetected
    }
  }

  return {
    decision: "extended",
    extensionRounds,
    newLimit,
    extensionReason: repairCycleDetected
      ? "repair_episode"
      : isInRoundRepair
        ? "repair_cycle_active"
        : "sustained_progress",
    recentProgressRate,
    latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
    repairCycleDetected
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

function normalizeFailureDiagnosticText(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 600)
}

function buildFailureDiagnosticKey(call: ToolCallRecord): string | null {
  if (!didToolCallFail(call.isError, call.result)) return null
  const normalizedFailure = normalizeFailureDiagnosticText(extractToolFailureText(call))
  if (normalizedFailure.length === 0) return null
  return `${call.name}:${normalizedFailure}`
}

function extractCommandTokens(args: Record<string, unknown>): string[] {
  const command = typeof args.command === "string" ? args.command : ""
  if (command.trim().length === 0) return []
  return command
    .trim()
    .split(/\s+/)
    .map((t) => t.toLowerCase())
}

function isVerificationToolCall(call: ToolCallRecord): boolean {
  if (call.name !== "run_command") return false
  const tokens = extractCommandTokens(call.args)
  if (tokens.length === 0) return false
  const [command, ...rest] = tokens
  if (VERIFICATION_COMMANDS.has(command)) {
    if (command === "npm" || command === "pnpm" || command === "yarn" || command === "bun") {
      return rest.some((t) => VERIFICATION_TOKENS.has(t))
    }
    if (command === "npx" || command === "uv") {
      return rest.some((t) => VERIFICATION_COMMANDS.has(t) || VERIFICATION_TOKENS.has(t))
    }
    return true
  }
  return tokens.some((t) => VERIFICATION_TOKENS.has(t))
}

function isSuccessfulMutationToolCall(call: ToolCallRecord): boolean {
  if (didToolCallFail(call.isError, call.result)) return false
  if (call.name === "write_file" || call.name === "replace_in_file" || call.name === "append_file")
    return true
  if (call.name !== "run_command") return false
  const tokens = extractCommandTokens(call.args)
  if (tokens.length === 0) return false
  const [command, ...rest] = tokens
  if (command === "git") {
    return rest.some((t) => ["apply", "checkout", "mv", "restore", "rm"].includes(t))
  }
  if (command === "npm" || command === "pnpm" || command === "yarn" || command === "bun") {
    return rest.some((t) => ["add", "dedupe", "install", "remove", "uninstall", "update"].includes(t))
  }
  if (command === "sed" || command === "perl") {
    return rest.some((t) => t === "-i" || t.startsWith("-i"))
  }
  return MUTATING_COMMANDS.has(command)
}
