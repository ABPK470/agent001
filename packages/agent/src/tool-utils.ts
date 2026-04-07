/**
 * Tool execution helpers — permission checking, argument parsing/repair,
 * tool execution with timeout racing & transport-failure retry,
 * stuck detection, and progress summary.
 *
 * Ported from agenc-core chat-executor-tool-utils.ts and chat-executor-tool-loop.ts,
 * adapted for agent001's type system.
 *
 * @module
 */

import type { RecoveryHint, ToolCallRecord } from "./recovery.js"
import { buildSemanticToolCallKey, didToolCallFail, extractToolFailureText } from "./recovery.js"

// ============================================================================
// Constants
// ============================================================================

/** Max chars retained per tool call argument payload for replay. */
export const MAX_TOOL_CALL_ARGUMENT_CHARS = 100_000
/** Max chars of raw preview kept when tool-call args are truncated. */
export const MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS = 4_000
/** Max chars kept from a tool result when feeding back into context. */
export const MAX_TOOL_RESULT_CHARS = 100_000
/** Upper bound on additive runtime hint system messages per execution. */
export const MAX_RUNTIME_SYSTEM_HINTS = 4
/** Max repeat identical failing calls / all-fail rounds / semantic duplicate rounds. */
export const MAX_CONSECUTIVE_IDENTICAL_FAILURES = 3
export const MAX_CONSECUTIVE_ALL_FAILED_ROUNDS = 3
export const MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS = 2

const RECOVERY_HINT_PREFIX = "Tool recovery hint:"

/**
 * High-risk tools that MUST NOT be auto-retried unless an explicit
 * idempotency token is provided.
 */
const HIGH_RISK_TOOLS = new Set([
  "run_command",
  "write_file",
  "delete",
  "delegate",
  "delegate_parallel",
])

/** Tools that are always safe to retry on transport failure. */
const SAFE_RETRY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "browse_web",
  "fetch_url",
  "browser_check",
  "think",
])

// ============================================================================
// Tool call permission
// ============================================================================

export type ToolCallAction = "processed" | "skip" | "end_round" | "abort_round" | "abort_loop"

export interface ToolCallPermissionResult {
  readonly action: ToolCallAction
  readonly errorResult?: string
}

/**
 * Check whether a tool call is permitted against the available tool set.
 */
export function checkToolCallPermission(
  toolName: string,
  availableTools: ReadonlySet<string>,
): ToolCallPermissionResult {
  if (!availableTools.has(toolName)) {
    return {
      action: "skip",
      errorResult: JSON.stringify({
        error: `Tool "${toolName}" is not available. Available: ${[...availableTools].join(", ")}`,
      }),
    }
  }
  return { action: "processed" }
}

// ============================================================================
// Argument parsing & repair
// ============================================================================

export type ParseToolCallArgsResult =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }

/**
 * Parse and validate tool call JSON arguments.
 * Returns structured success/error so caller can feed error back to LLM.
 */
export function parseToolCallArguments(
  rawArguments: unknown,
): ParseToolCallArgsResult {
  if (typeof rawArguments === "object" && rawArguments !== null && !Array.isArray(rawArguments)) {
    return { ok: true, args: rawArguments as Record<string, unknown> }
  }
  if (typeof rawArguments === "string") {
    try {
      const parsed = JSON.parse(rawArguments) as unknown
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: "Tool arguments must be a JSON object, not a primitive or array." }
      }
      return { ok: true, args: parsed as Record<string, unknown> }
    } catch (parseErr) {
      return {
        ok: false,
        error: `Invalid tool arguments: ${(parseErr as Error).message}. ` +
          "Break your work into smaller pieces if output was truncated.",
      }
    }
  }
  return { ok: false, error: "Tool arguments must be a JSON object." }
}

/**
 * Truncate oversized tool call arguments for replay in message history.
 */
export function sanitizeToolCallArgumentsForReplay(raw: string): string {
  if (raw.length <= MAX_TOOL_CALL_ARGUMENT_CHARS) return raw
  const preview = raw.slice(0, MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS) + "..."
  return JSON.stringify({
    __truncatedToolCallArgs: true,
    originalChars: raw.length,
    preview,
  })
}

// ============================================================================
// Tool execution with timeout racing & transport-failure retry
// ============================================================================

export interface ToolExecutionConfig {
  /** Timeout for a single tool call in ms. 0 = no timeout. */
  readonly toolCallTimeoutMs: number
  /** Max transport-failure retries. */
  readonly maxRetries: number
  /** AbortSignal for external cancellation. */
  readonly signal?: AbortSignal
}

export interface ToolExecutionResult {
  readonly result: string
  readonly isError: boolean
  readonly toolFailed: boolean
  readonly timedOut: boolean
  readonly retryCount: number
  readonly retrySuppressedReason?: string
  readonly durationMs: number
}

/**
 * Execute a tool call with timeout racing and transport-failure retry.
 *
 * - Timeout: races the tool execution against a configurable timeout.
 * - Transport retry: transient errors (timeout, network, connection refused)
 *   are retried for safe tools; high-risk tools only retry with idempotency key.
 * - Semantic failures are never retried.
 */
export async function executeToolWithTimeout(
  toolName: string,
  args: Record<string, unknown>,
  execute: (a: Record<string, unknown>) => Promise<string>,
  config: ToolExecutionConfig,
): Promise<ToolExecutionResult> {
  const toolStart = Date.now()
  let result = JSON.stringify({ error: "Tool execution failed" })
  let isError = false
  let toolFailed = false
  let timedOut = false
  let retrySuppressedReason: string | undefined
  let retryCount = 0

  const maxRetries = Math.max(0, config.maxRetries)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const toolCallPromise = (async (): Promise<{
      result: string; isError: boolean; timedOut: boolean; threw: boolean
    }> => {
      try {
        const value = await execute(args)
        return { result: value, isError: false, timedOut: false, threw: false }
      } catch (toolErr) {
        return {
          result: JSON.stringify({ error: (toolErr as Error).message }),
          isError: true,
          timedOut: false,
          threw: true,
        }
      }
    })()

    const timeoutMs = config.toolCallTimeoutMs
    const timeoutPromise = timeoutMs > 0
      ? new Promise<{
          result: string; isError: boolean; timedOut: boolean; threw: boolean
        }>((resolve) => {
          timeoutHandle = setTimeout(() => {
            resolve({
              result: JSON.stringify({ error: `Tool "${toolName}" timed out after ${timeoutMs}ms` }),
              isError: true,
              timedOut: true,
              threw: false,
            })
          }, timeoutMs)
        })
      : undefined

    const outcome = timeoutPromise
      ? await Promise.race([toolCallPromise, timeoutPromise])
      : await toolCallPromise

    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)

    result = outcome.result
    isError = outcome.isError
    timedOut = outcome.timedOut

    toolFailed = didToolCallFail(isError, result)

    if (!toolFailed) break

    // Determine if this is a transport failure (retryable)
    const failureText = extractToolFailureText({ name: toolName, args, result, isError: true })
    const transportFailure = timedOut || outcome.threw || isLikelyTransportFailure(failureText)

    if (!transportFailure) break
    if (attempt >= maxRetries) break
    if (config.signal?.aborted) break

    // Check retry safety
    if (HIGH_RISK_TOOLS.has(toolName)) {
      const hasIdempotency = typeof args.idempotencyKey === "string" && args.idempotencyKey.trim().length > 0
      if (!hasIdempotency) {
        retrySuppressedReason = `Suppressed auto-retry for high-risk tool "${toolName}" without idempotencyKey`
        break
      }
    } else if (!SAFE_RETRY_TOOLS.has(toolName)) {
      retrySuppressedReason = `Suppressed auto-retry for potentially side-effecting tool "${toolName}"`
      break
    }

    retryCount++
  }

  const durationMs = Date.now() - toolStart
  return { result, isError, toolFailed, timedOut, retryCount, retrySuppressedReason, durationMs }
}

/**
 * Detect likely transport/infrastructure failures that warrant retry.
 */
export function isLikelyTransportFailure(errorText: string): boolean {
  const lower = errorText.toLowerCase()
  return (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("network") ||
    lower.includes("transport")
  )
}

/**
 * Classify a tool as high-risk (has side effects).
 */
export function isHighRiskToolCall(toolName: string): boolean {
  return HIGH_RISK_TOOLS.has(toolName)
}

/**
 * Classify a tool as safe to retry on transport failure.
 */
export function isToolRetrySafe(toolName: string): boolean {
  return SAFE_RETRY_TOOLS.has(toolName)
}

// ============================================================================
// Stuck-loop detection
// ============================================================================

/** Mutable state for per-call failure tracking within a tool round. */
export interface ToolLoopState {
  lastFailKey: string
  consecutiveFailCount: number
}

/** Mutable state for cross-round stuck detection. */
export interface RoundStuckState {
  consecutiveAllFailedRounds: number
  lastRoundSemanticKey: string
  consecutiveSemanticDuplicateRounds: number
}

export interface StuckDetectionResult {
  readonly shouldBreak: boolean
  readonly reason?: string
}

/**
 * Track per-call consecutive failure counting within the tool loop.
 */
export function trackToolCallFailureState(
  toolFailed: boolean,
  semanticToolKey: string,
  loopState: ToolLoopState,
): void {
  const failKey = toolFailed ? semanticToolKey : ""
  if (toolFailed && failKey === loopState.lastFailKey) {
    loopState.consecutiveFailCount++
  } else {
    loopState.lastFailKey = failKey
    loopState.consecutiveFailCount = toolFailed ? 1 : 0
  }
}

/**
 * Check for stuck tool-loop patterns across rounds.
 *
 * Three levels:
 *   1. Per-call: N identical failing calls
 *   2. Per-round: N consecutive all-failed rounds
 *   3. Semantic: N consecutive rounds with same semantic key set (regardless of success)
 */
export function checkToolLoopStuckDetection(
  roundCalls: readonly ToolCallRecord[],
  loopState: ToolLoopState,
  stuckState: RoundStuckState,
): StuckDetectionResult {
  // Level 1: per-call identical failure
  if (loopState.consecutiveFailCount >= MAX_CONSECUTIVE_IDENTICAL_FAILURES) {
    return {
      shouldBreak: true,
      reason: "Detected repeated semantically-equivalent failing tool calls",
    }
  }

  if (roundCalls.length === 0) return { shouldBreak: false }

  // Level 2: all-failed rounds
  const roundFailures = roundCalls.filter(c => didToolCallFail(c.isError, c.result)).length
  if (roundFailures === roundCalls.length) {
    stuckState.consecutiveAllFailedRounds++
  } else {
    stuckState.consecutiveAllFailedRounds = 0
  }
  if (stuckState.consecutiveAllFailedRounds >= MAX_CONSECUTIVE_ALL_FAILED_ROUNDS) {
    return {
      shouldBreak: true,
      reason: `All tool calls failed for ${MAX_CONSECUTIVE_ALL_FAILED_ROUNDS} consecutive rounds`,
    }
  }

  // Level 3: semantic duplicate rounds (same tools + args, regardless of success/failure)
  const roundSemanticKey = roundCalls
    .map(c => buildSemanticToolCallKey(c.name, c.args))
    .sort()
    .join("|")
  if (roundSemanticKey.length > 0 && roundSemanticKey === stuckState.lastRoundSemanticKey) {
    stuckState.consecutiveSemanticDuplicateRounds++
  } else {
    stuckState.consecutiveSemanticDuplicateRounds = 0
  }
  stuckState.lastRoundSemanticKey = roundSemanticKey
  if (stuckState.consecutiveSemanticDuplicateRounds >= MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS) {
    return {
      shouldBreak: true,
      reason: "Detected repeated semantically equivalent tool rounds with no material progress",
    }
  }

  return { shouldBreak: false }
}

// ============================================================================
// Tool round progress summary (for budget extension decisions)
// ============================================================================

// Strip ANSI escapes for diagnostic key normalization
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

/** Tokens that indicate a verification/check command. */
const VERIFICATION_TOKENS = new Set([
  "build", "check", "compile", "coverage", "lint", "test", "typecheck", "verify",
])

/** Commands that, when leading, indicate a verification invocation. */
const VERIFICATION_COMMANDS = new Set([
  "cargo", "deno", "go", "gradle", "jest", "mvn", "node", "npm", "npx",
  "pnpm", "python", "python3", "pytest", "ruff", "tsc", "uv", "vitest",
  "yarn", "bun",
])

/** Commands that indicate workspace mutations. */
const MUTATING_COMMANDS = new Set([
  "cp", "git", "install", "mkdir", "mv", "perl", "rm", "sed", "touch",
])

export interface ToolRoundProgressSummary {
  readonly durationMs: number
  readonly totalCalls: number
  readonly successfulCalls: number
  readonly newSuccessfulSemanticKeys: number
  readonly newVerificationFailureDiagnosticKeys: number
  readonly hadSuccessfulMutation: boolean
  readonly hadVerificationCall: boolean
  readonly hadMaterialProgress: boolean
}

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
  seenVerificationFailureDiagnosticKeys: Set<string>,
): ToolRoundProgressSummary {
  let successfulCalls = 0
  let newSuccessfulSemanticKeys = 0
  let newVerificationFailureDiagnosticKeys = 0
  let hadSuccessfulMutation = false
  let hadVerificationCall = false

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
    hadMaterialProgress: newSuccessfulSemanticKeys > 0 || newVerificationFailureDiagnosticKeys > 0,
  }
}

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
  return command.trim().split(/\s+/).map(t => t.toLowerCase())
}

function isVerificationToolCall(call: ToolCallRecord): boolean {
  if (call.name !== "run_command") return false
  const tokens = extractCommandTokens(call.args)
  if (tokens.length === 0) return false
  const [command, ...rest] = tokens
  if (VERIFICATION_COMMANDS.has(command)) {
    if (command === "npm" || command === "pnpm" || command === "yarn" || command === "bun") {
      return rest.some(t => VERIFICATION_TOKENS.has(t))
    }
    if (command === "npx" || command === "uv") {
      return rest.some(t => VERIFICATION_COMMANDS.has(t) || VERIFICATION_TOKENS.has(t))
    }
    return true
  }
  return tokens.some(t => VERIFICATION_TOKENS.has(t))
}

function isSuccessfulMutationToolCall(call: ToolCallRecord): boolean {
  if (didToolCallFail(call.isError, call.result)) return false
  if (call.name === "write_file" || call.name === "delete") return true
  if (call.name !== "run_command") return false
  const tokens = extractCommandTokens(call.args)
  if (tokens.length === 0) return false
  const [command, ...rest] = tokens
  if (command === "git") {
    return rest.some(t => ["apply", "checkout", "mv", "restore", "rm"].includes(t))
  }
  if (command === "npm" || command === "pnpm" || command === "yarn" || command === "bun") {
    return rest.some(t => ["add", "dedupe", "install", "remove", "uninstall", "update"].includes(t))
  }
  if (command === "sed" || command === "perl") {
    return rest.some(t => t === "-i" || t.startsWith("-i"))
  }
  return MUTATING_COMMANDS.has(command)
}

// ============================================================================
// Tool loop recovery message builder
// ============================================================================

/**
 * Build recovery hint messages for injection after a tool round.
 * Respects the max runtime system hint cap.
 */
export function buildToolLoopRecoveryMessages(
  recoveryHints: readonly RecoveryHint[],
  maxRuntimeSystemHints: number,
  currentRuntimeHintCount: number,
): Array<{ role: "system"; content: string }> {
  const messages: Array<{ role: "system"; content: string }> = []
  if (maxRuntimeSystemHints <= 0) return messages
  let hintCount = currentRuntimeHintCount
  for (const hint of recoveryHints) {
    if (hintCount >= maxRuntimeSystemHints) break
    messages.push({
      role: "system",
      content: `${RECOVERY_HINT_PREFIX} ${hint.message}`,
    })
    hintCount++
  }
  return messages
}

// ============================================================================
// Tool round budget extension
// ============================================================================

export interface ToolRoundBudgetExtensionResult {
  readonly decision: "extended" | "capped" | "not_needed"
  readonly extensionRounds: number
  readonly newLimit: number
  readonly extensionReason?: string
  readonly recentProgressRate: number
  readonly latestRoundHadMaterialProgress: boolean
}

/**
 * Evaluate whether the tool round budget should be extended based on
 * recent progress metrics.
 *
 * Extension happens when:
 *   1. Recent rounds show material progress (new semantic keys or verification diagnostics)
 *   2. The latest round had mutations + verification (active repair cycle)
 *   3. Not already at the hard cap
 */
export function evaluateToolRoundBudgetExtension(params: {
  readonly currentLimit: number
  readonly maxAbsoluteLimit: number
  readonly recentRounds: readonly ToolRoundProgressSummary[]
  readonly remainingToolBudget: number
}): ToolRoundBudgetExtensionResult {
  const { currentLimit, maxAbsoluteLimit, recentRounds, remainingToolBudget } = params

  if (currentLimit >= maxAbsoluteLimit) {
    return { decision: "capped", extensionRounds: 0, newLimit: currentLimit, recentProgressRate: 0, latestRoundHadMaterialProgress: false }
  }
  if (recentRounds.length === 0) {
    return { decision: "not_needed", extensionRounds: 0, newLimit: currentLimit, recentProgressRate: 0, latestRoundHadMaterialProgress: false }
  }

  const latestRound = recentRounds[recentRounds.length - 1]
  const recentProgressRate = recentRounds.filter(r => r.hadMaterialProgress).length / recentRounds.length

  // Extension: if recent progress is being made, extend by 2-4 more rounds
  const isRepairCycleOpen = latestRound.hadSuccessfulMutation && latestRound.hadVerificationCall
  const shouldExtend = recentProgressRate >= 0.5 || isRepairCycleOpen

  if (!shouldExtend) {
    return {
      decision: "not_needed",
      extensionRounds: 0,
      newLimit: currentLimit,
      recentProgressRate,
      latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
    }
  }

  // Extension size: 2 base + 1 if repair cycle is active + 1 if remaining budget allows
  let extensionRounds = 2
  if (isRepairCycleOpen) extensionRounds++
  if (remainingToolBudget > 10) extensionRounds++

  const newLimit = Math.min(currentLimit + extensionRounds, maxAbsoluteLimit)
  extensionRounds = newLimit - currentLimit

  if (extensionRounds <= 0) {
    return { decision: "capped", extensionRounds: 0, newLimit: currentLimit, recentProgressRate, latestRoundHadMaterialProgress: latestRound.hadMaterialProgress }
  }

  return {
    decision: "extended",
    extensionRounds,
    newLimit,
    extensionReason: isRepairCycleOpen ? "repair_cycle_active" : "material_progress",
    recentProgressRate,
    latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
  }
}

// ============================================================================
// Enrichment helpers
// ============================================================================

/**
 * Enrich a JSON tool result with additional metadata fields.
 */
export function enrichToolResultMetadata(
  result: string,
  metadata: Record<string, unknown>,
): string {
  try {
    const parsed = JSON.parse(result) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result
    return JSON.stringify({ ...(parsed as Record<string, unknown>), ...metadata })
  } catch {
    return result
  }
}

/**
 * Generate a fallback final content from tool call records when the LLM
 * produced no final response text.
 */
export function generateFallbackContent(toolCalls: readonly ToolCallRecord[]): string | undefined {
  if (toolCalls.length === 0) return undefined
  const lastSuccessful = [...toolCalls].reverse().find(c => !didToolCallFail(c.isError, c.result))
  if (lastSuccessful) {
    return `Task completed. Last successful tool call: ${lastSuccessful.name}`
  }
  return "Task attempted but all tool calls failed. See tool results for details."
}
