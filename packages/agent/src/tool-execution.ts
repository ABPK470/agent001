/**
 * Per-tool-call execution logic extracted from Agent.run().
 *
 * Handles: circuit breaker checks, parse error detection, mutation guards,
 * kill manager racing, timeout, result enrichment, and artifact tracking.
 */

import type { AgentLoopState } from "./agent-loop-state.js"
import * as log from "./logger.js"
import type { ToolCallRecord } from "./tool-result.js"
import { buildSemanticToolCallKey, didToolCallFail } from "./tool-result.js"
import {
    enrichToolResultMetadata as enrichResult,
    executeToolWithTimeout,
    trackToolCallFailureState,
} from "./tool-utils.js"
import type { AgentConfig, Message, Tool } from "./types.js"

const FILE_MUTATION_TOOLS = new Set(["write_file", "replace_in_file", "append_file"])

export function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

/** Result of executing all tool calls in one round. */
export interface ToolRoundResult {
  roundToolCalls: ToolCallRecord[]
  failuresThisRound: number
  delegationThisRound: boolean
  forcedAbortRoundMessage: string | null
  forcedAbortLoopMessage: string | null
}

/** Context for tool execution. */
export interface ToolExecContext {
  tools: Map<string, Tool>
  toolList: Tool[]
  state: AgentLoopState
  messages: Message[]
  config: {
    signal: AgentConfig["signal"]
    toolKillManager: AgentConfig["toolKillManager"]
    verbose: boolean
  }
  iteration: number
  allToolCalls: ToolCallRecord[]
}

function recordBlockedArtifactFailure(
  state: AgentLoopState,
  artifactPath: string,
  threshold: number,
  reason: string,
): string | null {
  const normalizedPath = normalizeArtifactPath(artifactPath)
  if (!normalizedPath) return null
  const count = (state.blockedArtifactFailureCounts.get(normalizedPath) ?? 0) + 1
  state.blockedArtifactFailureCounts.set(normalizedPath, count)
  if (count >= threshold) {
    return `${reason} on ${normalizedPath}. Stopping this agent attempt so the parent can retry or replan from a clean state.`
  }
  return null
}

/**
 * Execute all tool calls from one LLM response round.
 */
export async function executeToolRound(
  calls: Array<{
    id: string
    name: string
    arguments: Record<string, unknown> & { __parseError?: boolean; __raw?: string }
  }>,
  ctx: ToolExecContext,
): Promise<ToolRoundResult> {
  const { tools, state, messages, config } = ctx
  let failuresThisRound = 0
  let delegationThisRound = false
  const roundToolCalls: ToolCallRecord[] = []
  let forcedAbortRoundMessage: string | null = null
  let forcedAbortLoopMessage: string | null = null

  // Circuit breaker check — stop retrying if breaker is open
  const circuitStatus = state.circuitBreaker.getActiveCircuit()
  if (circuitStatus) {
    const cbMsg = `CIRCUIT BREAKER: ${circuitStatus.reason} — change your approach.`
    messages.push({ role: "system", content: cbMsg, section: "history" })
    return { roundToolCalls, failuresThisRound, delegationThisRound, forcedAbortRoundMessage: cbMsg, forcedAbortLoopMessage }
  }

  for (const call of calls) {
    if (config.signal?.aborted) {
      return { roundToolCalls, failuresThisRound, delegationThisRound, forcedAbortRoundMessage: null, forcedAbortLoopMessage: "Agent was cancelled." }
    }
    if (config.verbose) log.logToolCall(call.name, call.arguments)

    const semanticKey = buildSemanticToolCallKey(call.name, call.arguments)

    // Per-key circuit breaker check
    const keyBlock = state.circuitBreaker.isKeyBlocked(semanticKey)
    if (keyBlock) {
      const msg = `SKIPPED (circuit blocked): ${keyBlock.reason} Try a different approach for this call.`
      if (config.verbose) log.logToolError(msg)
      messages.push({ role: "tool", toolCallId: call.id, content: msg, section: "history" })
      roundToolCalls.push({ name: call.name, args: call.arguments, result: msg, isError: true })
      failuresThisRound++
      continue
    }

    const tool = tools.get(call.name)
    if (!tool) {
      const errMsg = `Unknown tool "${call.name}". Available: ${[...tools.keys()].join(", ")}`
      if (config.verbose) log.logToolError(errMsg)
      messages.push({ role: "tool", toolCallId: call.id, content: errMsg, section: "history" })
      roundToolCalls.push({ name: call.name, args: call.arguments, result: errMsg, isError: true })
      failuresThisRound++
      continue
    }

    // Parse error guard
    if (call.arguments.__parseError) {
      const errMsg = `Tool call "${call.name}" failed: the model produced malformed arguments that could not be parsed as JSON. ` +
        `This usually means your output was too large and got cut off. ` +
        `Break the work into smaller pieces — use multiple write_file calls instead of one large one. ` +
        `Raw (truncated): ${String(call.arguments.__raw).slice(0, 200)}...`
      if (config.verbose) log.logToolError(errMsg)
      messages.push({ role: "tool", toolCallId: call.id, content: errMsg, section: "history" })
      roundToolCalls.push({ name: call.name, args: call.arguments, result: errMsg, isError: true })
      failuresThisRound++
      continue
    }

    // Mutation guard — require read before re-mutation
    const requestedPath = typeof call.arguments.path === "string"
      ? normalizeArtifactPath(String(call.arguments.path))
      : ""
    if (FILE_MUTATION_TOOLS.has(call.name) && requestedPath && state.artifactsRequiringReadBeforeMutation.has(requestedPath)) {
      const blockedMsg =
        `MUTATION BLOCKED for ${requestedPath} — you must read the current artifact before attempting another mutation.\n` +
        "  - The previous mutation on this artifact produced a structured integrity failure.\n" +
        "  - Use read_file on the exact same path first, then plan a targeted repair from the current file state."
      if (config.verbose) log.logToolError(blockedMsg)
      messages.push({ role: "tool", toolCallId: call.id, content: blockedMsg, section: "history" })
      roundToolCalls.push({
        name: call.name, args: call.arguments, result: blockedMsg, isError: true,
        outcome: {
          ok: false,
          summary: `MUTATION BLOCKED for ${requestedPath}`,
          severity: "recoverable",
          directive: "abort_round",
          errorCode: "artifact_inspection_required",
          details: ["Use read_file on the same artifact before any further write/replace/append attempt."],
          artifacts: [{ path: requestedPath, preservedExisting: true, requiresReadBeforeMutation: true }],
        },
      })
      failuresThisRound++
      forcedAbortLoopMessage = recordBlockedArtifactFailure(state, requestedPath, 3, "Repeated mutation-blocked attempts")
      forcedAbortRoundMessage = `Artifact guard triggered for ${requestedPath}. Read the current file before retrying any mutation.`
      break
    }

    // Execute with kill manager racing
    const { result: execResult, killed, killMessage } = await executeWithKillManager(
      call, tool, config,
    )

    if (killed) {
      const msg = `[TOOL KILLED BY USER] ${killMessage}`
      if (config.verbose) log.logToolError(msg)
      messages.push({ role: "tool", toolCallId: call.id, content: msg, section: "history" })
      roundToolCalls.push({ name: call.name, args: call.arguments, result: msg, isError: true })
      failuresThisRound++
      continue
    }

    if (execResult.isError) {
      if (config.verbose) log.logToolError(execResult.result)
      messages.push({ role: "tool", toolCallId: call.id, content: execResult.result, section: "history" })
      roundToolCalls.push({ name: call.name, args: call.arguments, result: execResult.result, isError: true, outcome: execResult.outcome })
      failuresThisRound++
      state.circuitBreaker.recordFailure(semanticKey, call.name)
      trackToolCallFailureState(true, semanticKey, state.toolLoopState)

      handleReplaceInFileMiss(call, execResult, requestedPath, state, forcedAbortLoopMessage, forcedAbortRoundMessage, (loop, round) => {
        forcedAbortLoopMessage = loop
        forcedAbortRoundMessage = round
      })
    } else {
      const enriched = enrichResult(execResult.result, {})
      const semanticFailure = execResult.outcome ? !execResult.outcome.ok : didToolCallFail(false, enriched)
      if (config.verbose) log.logToolResult(enriched)
      messages.push({ role: "tool", toolCallId: call.id, content: enriched, section: "history" })
      roundToolCalls.push({
        name: call.name, args: call.arguments, result: enriched,
        isError: semanticFailure, outcome: execResult.outcome,
      })

      if (semanticFailure) {
        failuresThisRound++
        state.circuitBreaker.recordFailure(semanticKey, call.name)
        trackToolCallFailureState(true, semanticKey, state.toolLoopState)

        handleReplaceInFileMiss(call, { result: enriched }, requestedPath, state, forcedAbortLoopMessage, forcedAbortRoundMessage, (loop, round) => {
          forcedAbortLoopMessage = loop
          forcedAbortRoundMessage = round
        })
      } else {
        state.circuitBreaker.clearPattern(semanticKey)
        trackToolCallFailureState(false, semanticKey, state.toolLoopState)
      }

      if (call.name === "delegate" || call.name === "delegate_parallel") {
        delegationThisRound = true
      }

      // Artifact tracking
      const artifactAbort = processArtifactOutcome(call, execResult, state)
      if (artifactAbort && !forcedAbortLoopMessage) forcedAbortLoopMessage = artifactAbort

      // Track write-without-verify
      trackWriteVerification(call, execResult, state)

      // Abort directives
      if (execResult.outcome?.directive === "abort_loop" && !forcedAbortLoopMessage) {
        forcedAbortLoopMessage = execResult.outcome.summary
      } else if (execResult.outcome?.directive === "abort_round" && !forcedAbortRoundMessage) {
        forcedAbortRoundMessage = execResult.outcome.summary
      }

      if (forcedAbortLoopMessage || forcedAbortRoundMessage) break
    }
  }

  return { roundToolCalls, failuresThisRound, delegationThisRound, forcedAbortRoundMessage, forcedAbortLoopMessage }
}

// ── Internal helpers ────────────────────────────────────────────

async function executeWithKillManager(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  tool: Tool,
  config: { signal: AgentConfig["signal"]; toolKillManager: AgentConfig["toolKillManager"] },
): Promise<{
  result: Awaited<ReturnType<typeof executeToolWithTimeout>>
  killed: boolean
  killMessage: string
}> {
  const killManager = config.toolKillManager
  const killPromise = killManager?.register(call.id, call.name)

  if (killPromise) {
    const raceResult = await Promise.race([
      executeToolWithTimeout(
        call.name, call.arguments, (a) => tool.execute(a),
        { toolCallTimeoutMs: 0, maxRetries: 1, signal: config.signal },
      ).then((r) => ({ kind: "exec" as const, value: r })),
      killPromise.then((msg: string) => ({ kind: "kill" as const, value: msg })),
    ])
    killManager!.unregister(call.id)

    if (raceResult.kind === "kill") {
      return {
        result: { result: "", isError: true, timedOut: false, retryCount: 0, toolFailed: false, durationMs: 0 },
        killed: true,
        killMessage: raceResult.value,
      }
    }
    return { result: raceResult.value, killed: false, killMessage: "" }
  }

  const result = await executeToolWithTimeout(
    call.name, call.arguments, (a) => tool.execute(a),
    { toolCallTimeoutMs: 0, maxRetries: 1, signal: config.signal },
  )
  return { result, killed: false, killMessage: "" }
}

function handleReplaceInFileMiss(
  call: { name: string; arguments: Record<string, unknown> },
  execResult: { result: string },
  requestedPath: string,
  state: AgentLoopState,
  currentLoopAbort: string | null,
  currentRoundAbort: string | null,
  setAborts: (loop: string | null, round: string | null) => void,
): void {
  if (
    call.name === "replace_in_file"
    && requestedPath
    && /old_string not found/i.test(execResult.result)
  ) {
    state.artifactsRequiringReadBeforeMutation.add(requestedPath)
    const repeatedMissAbort = recordBlockedArtifactFailure(state, requestedPath, 3, "Repeated replace_in_file old_string misses")
    let newLoop = currentLoopAbort
    let newRound = currentRoundAbort
    if (repeatedMissAbort && !newLoop) newLoop = repeatedMissAbort
    if (!newRound) {
      newRound =
        `replace_in_file could not find the requested text in ${requestedPath}. ` +
        "Read the current file and switch to an exact-match repair or full-file rewrite if the content has drifted."
    }
    setAborts(newLoop, newRound)
  }
}

function processArtifactOutcome(
  call: { name: string; arguments: Record<string, unknown> },
  execResult: Awaited<ReturnType<typeof executeToolWithTimeout>>,
  state: AgentLoopState,
): string | null {
  let abortMessage: string | null = null

  for (const artifact of execResult.outcome?.artifacts ?? []) {
    const normalizedPath = normalizeArtifactPath(artifact.path)
    if (!normalizedPath) continue
    if (artifact.requiresReadBeforeMutation) {
      state.artifactsRequiringReadBeforeMutation.add(normalizedPath)
    } else {
      state.artifactsRequiringReadBeforeMutation.delete(normalizedPath)
      state.fatalArtifactFailureCounts.delete(normalizedPath)
      state.blockedArtifactFailureCounts.delete(normalizedPath)
    }
  }

  if (execResult.outcome?.severity === "fatal") {
    for (const artifact of execResult.outcome.artifacts ?? []) {
      const normalizedPath = normalizeArtifactPath(artifact.path)
      if (!normalizedPath) continue
      const count = (state.fatalArtifactFailureCounts.get(normalizedPath) ?? 0) + 1
      state.fatalArtifactFailureCounts.set(normalizedPath, count)
      if (count >= 2 && !abortMessage) {
        abortMessage =
          `Repeated fatal mutation failures on ${normalizedPath}. Stopping this agent attempt so the parent can retry or replan from a clean state.`
      }
      if (!abortMessage) {
        abortMessage = recordBlockedArtifactFailure(state, normalizedPath, 3, "Repeated blocked mutation failures")
      }
    }
  } else if (
    execResult.outcome?.errorCode === "artifact_incomplete_mutation"
    || execResult.outcome?.errorCode === "artifact_inspection_required"
  ) {
    for (const artifact of execResult.outcome.artifacts ?? []) {
      if (abortMessage) break
      abortMessage = recordBlockedArtifactFailure(
        state,
        artifact.path,
        3,
        "Repeated incomplete/blocked mutation failures",
      )
    }
  }

  return abortMessage
}

function trackWriteVerification(
  call: { name: string; arguments: Record<string, unknown> },
  execResult: Awaited<ReturnType<typeof executeToolWithTimeout>>,
  state: AgentLoopState,
): void {
  if (call.name === "write_file") {
    const writePath = String(call.arguments.path ?? "")
    const preservedExisting = execResult.outcome?.artifacts?.some((a) => a.preservedExisting) ?? false
    if (/\.(js|jsx|ts|tsx|py|html?|css|json)$/i.test(writePath) && !preservedExisting) {
      state.wroteUnverifiedFiles = true
      if (/\.(js|jsx|ts|tsx|py)$/i.test(writePath)) {
        state.writtenButNotReread.add(writePath)
      }
    }
  }
  if (call.name === "read_file") {
    state.wroteUnverifiedFiles = false
    const readPath = String(call.arguments.path ?? "")
    state.writtenButNotReread.delete(readPath)
    state.artifactsRequiringReadBeforeMutation.delete(normalizeArtifactPath(readPath))
  }
  if (call.name === "run_command" || call.name === "browser_check") {
    state.wroteUnverifiedFiles = false
  }
}
