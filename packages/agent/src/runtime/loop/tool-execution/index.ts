import { ToolControlDirective, ToolOutcomeSeverity } from "../../../domain/index.js"
/**
 * Per-tool-call execution logic extracted from Agent.run().
 *
 * Handles: circuit breaker checks, parse error detection, mutation guards,
 * kill manager racing, timeout, result enrichment, and artifact tracking.
 *
 * Internals split into ./tool-execution/<module>:
 *   types              — ToolRoundResult, ToolExecContext, normalizeArtifactPath, constants
 *   anti-paste-guard   — extractTruncationFingerprint, extractWritePayload, recordTruncatedQuery
 *   kill-manager       — executeWithKillManager
 *   artifact-tracking  — recordBlockedArtifactFailure, processArtifactOutcome,
 *                        trackWriteVerification, handleReplaceInFileMiss, collectChildToolNames
 *
 * @module
 */

import { asToolCallId } from "../../../domain/types/branded-ids.js"
import { READ_ONLY_TOOL_NAMES } from "../../../domain/types/agent-constants.js"
import { MessageRole } from "../../../domain/enums/message.js"
import * as log from "../../../internal/index.js"
import { compactAtWriteTime } from "../../../memory/index.js"
import type { ToolCallRecord } from "../../../tools/_shared/result.js"
import { buildSemanticToolCallKey, didToolCallFail } from "../../../tools/_shared/result.js"
import { enrichToolResultMetadata as enrichResult } from "../../../tools/_shared/utils/index.js"
import { trackToolCallFailureState } from "../../../tools/_shared/utils/stuck-detection.js"
import { extractWritePayload, recordTruncatedQuery } from "./anti-paste-guard.js"
import {
  collectChildToolNames,
  handleReplaceInFileMiss,
  processArtifactOutcome,
  recordBlockedArtifactFailure,
  trackWriteVerification
} from "./artifact-tracking.js"
import { executeWithKillManager } from "./kill-manager.js"
import {
  ANTIPASTE_MIN_CONTENT_LEN,
  FILE_MUTATION_TOOLS,
  normalizeArtifactPath,
  type ToolExecContext,
  type ToolRoundResult
} from "./types.js"

// Re-export public types/helpers for backwards compatibility.
export { emitToolTrace, readToolTraceContext, TOOL_TRACE_ARG, withToolTraceArgs } from "./trace-context.js"
export type { ToolTraceContext } from "./trace-context.js"
export type { ToolExecContext, ToolRoundResult } from "./types.js"

/**
 * Execute all tool calls from one LLM response round.
 */
export async function executeToolRound(
  calls: Array<{
    id: string
    name: string
    arguments: Record<string, unknown> & { __parseError?: boolean; __raw?: string }
  }>,
  ctx: ToolExecContext
): Promise<ToolRoundResult> {
  const { tools, state, messages, config } = ctx
  let failuresThisRound = 0
  let delegationThisRound = false
  // Start true; flip to false as soon as we see ANY delegation that grants the
  // child a mutating tool (or doesn't restrict tools at all).
  let delegationThisRoundWasReadOnly = true
  const roundToolCalls: ToolCallRecord[] = []
  let forcedAbortRoundMessage: string | null = null
  let forcedAbortLoopMessage: string | null = null

  // Circuit breaker check — stop retrying if breaker is open
  const circuitStatus = state.circuitBreaker.getActiveCircuit()
  if (circuitStatus) {
    const cbMsg = `CIRCUIT BREAKER: ${circuitStatus.reason} — change your approach.`
    messages.push({ role: MessageRole.System, content: cbMsg, section: "history" })
    return {
      roundToolCalls,
      failuresThisRound,
      delegationThisRound,
      delegationThisRoundWasReadOnly,
      forcedAbortRoundMessage: cbMsg,
      forcedAbortLoopMessage
    }
  }

  for (const call of calls) {
    if (config.signal?.aborted) {
      return {
        roundToolCalls,
        failuresThisRound,
        delegationThisRound,
        delegationThisRoundWasReadOnly,
        forcedAbortRoundMessage: null,
        forcedAbortLoopMessage: "Agent was cancelled."
      }
    }
    if (config.verbose) log.logToolCall(call.name, call.arguments)

    const semanticKey = buildSemanticToolCallKey(call.name, call.arguments)

    // Per-key circuit breaker check
    const keyBlock = state.circuitBreaker.isKeyBlocked(semanticKey)
    if (keyBlock) {
      const msg = `SKIPPED (circuit blocked): ${keyBlock.reason} Try a different approach for this call.`
      if (config.verbose) log.logToolError(msg)
      messages.push({ role: MessageRole.Tool, toolCallId: asToolCallId(call.id), content: msg, section: "history" })
      roundToolCalls.push({ name: call.name, args: call.arguments, result: msg, isError: true })
      failuresThisRound++
      continue
    }

    const tool = tools.get(call.name)
    if (!tool) {
      const errMsg = `Unknown tool "${call.name}". Available: ${[...tools.keys()].join(", ")}`
      if (config.verbose) log.logToolError(errMsg)
      messages.push({
        role: MessageRole.Tool,
        toolCallId: asToolCallId(call.id),
        content: errMsg,
        section: "history"
      })
      roundToolCalls.push({ name: call.name, args: call.arguments, result: errMsg, isError: true })
      failuresThisRound++
      continue
    }

    // Parse error guard
    if (call.arguments.__parseError) {
      const errMsg =
        `Tool call "${call.name}" failed: the model produced malformed arguments that could not be parsed as JSON. ` +
        `This usually means your output was too large and got cut off. ` +
        `Break the work into smaller pieces — use multiple write_file calls instead of one large one. ` +
        `Raw (truncated): ${String(call.arguments.__raw).slice(0, 200)}...`
      if (config.verbose) log.logToolError(errMsg)
      messages.push({
        role: MessageRole.Tool,
        toolCallId: asToolCallId(call.id),
        content: errMsg,
        section: "history"
      })
      roundToolCalls.push({ name: call.name, args: call.arguments, result: errMsg, isError: true })
      failuresThisRound++
      continue
    }

    // Mutation guard — require read before re-mutation
    const requestedPath =
      typeof call.arguments.path === "string" ? normalizeArtifactPath(String(call.arguments.path)) : ""

    // Anti-paste guard: detect when the model is about to dump a previously
    // truncated query_mssql result into write_file / replace_in_file.
    if (FILE_MUTATION_TOOLS.has(call.name) && state.recentTruncatedQueries.length > 0) {
      const payload = extractWritePayload(call.name, call.arguments)
      if (payload.length >= ANTIPASTE_MIN_CONTENT_LEN) {
        const matched = state.recentTruncatedQueries.find((entry) => payload.includes(entry.fingerprint))
        if (matched) {
          const targetPath = requestedPath || "<your path>"
          const blockedMsg =
            `BLOCKED: this ${call.name} content came from a TRUNCATED query_mssql preview. ` +
            `query_mssql only returns the first ~200 rows; writing this preview produces a broken/partial file.\n` +
            `\n` +
            `→ Make THIS exact next call instead (do not run query_mssql again):\n` +
            `\n` +
            `  export_query_to_file({\n` +
            `    "query": ${JSON.stringify(matched.query)},\n` +
            `    "path": ${JSON.stringify(targetPath)}\n` +
            `  })\n` +
            `\n` +
            `It streams the FULL result set directly to disk and returns a 20-row preview. ` +
            `If the SELECT contains wide JSON/blob columns, narrow it to only the columns the user actually needs first.`
          if (config.verbose) log.logToolError(blockedMsg)
          messages.push({
            role: MessageRole.Tool,
            toolCallId: asToolCallId(call.id),
            content: blockedMsg,
            section: "history"
          })
          roundToolCalls.push({
            name: call.name,
            args: call.arguments,
            result: blockedMsg,
            isError: true,
            outcome: {
              ok: false,
              summary: `Anti-paste guard: blocked ${call.name} of truncated query result`,
              severity: ToolOutcomeSeverity.Recoverable,
              directive: ToolControlDirective.AbortRound,
              errorCode: "truncated_query_paste_blocked",
              details: [
                `Use export_query_to_file with query=${JSON.stringify(matched.query)} path=${JSON.stringify(targetPath)}.`
              ]
            }
          })
          // One-shot: clear matched entry so a deliberate retry isn't permanently blocked.
          state.recentTruncatedQueries = state.recentTruncatedQueries.filter((e) => e !== matched)
          failuresThisRound++
          forcedAbortRoundMessage = `Anti-paste guard: call export_query_to_file with the SQL above instead of ${call.name}.`
          break
        }
      }
    }

    if (
      FILE_MUTATION_TOOLS.has(call.name) &&
      requestedPath &&
      state.artifactsRequiringReadBeforeMutation.has(requestedPath)
    ) {
      const blockedMsg =
        `MUTATION BLOCKED for ${requestedPath} — you must read the current artifact before attempting another mutation.\n` +
        "  - The previous mutation on this artifact produced a structured integrity failure.\n" +
        "  - Use read_file on the exact same path first, then plan a targeted repair from the current file state."
      if (config.verbose) log.logToolError(blockedMsg)
      messages.push({
        role: MessageRole.Tool,
        toolCallId: asToolCallId(call.id),
        content: blockedMsg,
        section: "history"
      })
      roundToolCalls.push({
        name: call.name,
        args: call.arguments,
        result: blockedMsg,
        isError: true,
        outcome: {
          ok: false,
          summary: `MUTATION BLOCKED for ${requestedPath}`,
          severity: ToolOutcomeSeverity.Recoverable,
          directive: ToolControlDirective.AbortRound,
          errorCode: "artifact_inspection_required",
          details: ["Use read_file on the same artifact before any further write/replace/append attempt."],
          artifacts: [{ path: requestedPath, preservedExisting: true, requiresReadBeforeMutation: true }]
        }
      })
      failuresThisRound++
      forcedAbortLoopMessage = recordBlockedArtifactFailure(
        state,
        requestedPath,
        3,
        "Repeated mutation-blocked attempts"
      )
      forcedAbortRoundMessage = `Artifact guard triggered for ${requestedPath}. Read the current file before retrying any mutation.`
      break
    }

    // Execute with kill manager racing
    const {
      result: execResult,
      killed,
      killMessage
    } = await executeWithKillManager(call, tool, {
      ...config,
      iteration: ctx.iteration
    })

    if (killed) {
      const msg = `[TOOL KILLED BY USER] ${killMessage}`
      if (config.verbose) log.logToolError(msg)
      messages.push({ role: MessageRole.Tool, toolCallId: asToolCallId(call.id), content: msg, section: "history" })
      roundToolCalls.push({ name: call.name, args: call.arguments, result: msg, isError: true })
      failuresThisRound++
      continue
    }

    if (execResult.isError) {
      if (config.verbose) log.logToolError(execResult.result)
      messages.push({
        role: MessageRole.Tool,
        toolCallId: asToolCallId(call.id),
        content: execResult.result,
        section: "history"
      })
      roundToolCalls.push({
        name: call.name,
        args: call.arguments,
        result: execResult.result,
        isError: true,
        outcome: execResult.outcome
      })
      // No-amnesia hook: persist the result so a later turn can ground on it.
      // Wrapped in try/catch — a persistence failure must never break the
      // agent loop.
      try {
        config.onToolResult?.({
          iteration: ctx.iteration,
          toolCallId: asToolCallId(call.id),
          toolName: call.name,
          args: call.arguments,
          result: execResult.result,
          isError: true,
          messages
        })
      } catch (e) {
        log.logError(`onToolResult hook threw (ignored): ${e instanceof Error ? e.message : String(e)}`)
      }
      failuresThisRound++
      state.circuitBreaker.recordFailure(semanticKey, call.name)
      trackToolCallFailureState(true, semanticKey, state.toolLoopState)

      handleReplaceInFileMiss(
        call,
        execResult,
        requestedPath,
        state,
        forcedAbortLoopMessage,
        forcedAbortRoundMessage,
        (loop, round) => {
          forcedAbortLoopMessage = loop
          forcedAbortRoundMessage = round
        }
      )
    } else {
      const enriched = enrichResult(execResult.result, {})
      const compactedForHistory = compactAtWriteTime(call.name, enriched)
      const semanticFailure = execResult.outcome ? !execResult.outcome.ok : didToolCallFail(false, enriched)
      if (config.verbose) log.logToolResult(enriched)
      messages.push({
        role: MessageRole.Tool,
        toolCallId: asToolCallId(call.id),
        content: compactedForHistory,
        section: "history"
      })
      roundToolCalls.push({
        name: call.name,
        args: call.arguments,
        result: enriched,
        isError: semanticFailure,
        outcome: execResult.outcome
      })
      // No-amnesia hook: persist the (enriched) result before continuing.
      // We persist BOTH success and semantic-failure outcomes — knowing a
      // prior tool failed is itself ground truth the next turn needs.
      try {
        config.onToolResult?.({
          iteration: ctx.iteration,
          toolCallId: asToolCallId(call.id),
          toolName: call.name,
          args: call.arguments,
          result: enriched,
          isError: semanticFailure,
          messages
        })
      } catch (e) {
        log.logError(`onToolResult hook threw (ignored): ${e instanceof Error ? e.message : String(e)}`)
      }

      if (semanticFailure) {
        failuresThisRound++
        state.circuitBreaker.recordFailure(semanticKey, call.name)
        trackToolCallFailureState(true, semanticKey, state.toolLoopState)

        handleReplaceInFileMiss(
          call,
          { result: enriched },
          requestedPath,
          state,
          forcedAbortLoopMessage,
          forcedAbortRoundMessage,
          (loop, round) => {
            forcedAbortLoopMessage = loop
            forcedAbortRoundMessage = round
          }
        )
      } else {
        state.circuitBreaker.clearPattern(semanticKey)
        trackToolCallFailureState(false, semanticKey, state.toolLoopState)
      }

      // Capture truncation fingerprints from query_mssql so the anti-paste
      // guard above can recognize copy-pasted truncated output on later turns.
      if (call.name === "query_mssql") {
        recordTruncatedQuery(state, enriched, call.arguments)
      }

      if (
        (call.name === "delegate" || call.name === "delegate_parallel") &&
        (tools.has("delegate") || tools.has("delegate_parallel"))
      ) {
        delegationThisRound = true
        // Inspect the child's tool whitelist. If absent OR contains any
        // non-read-only tool, treat the delegation as potentially mutating.
        const childTools = collectChildToolNames(call.arguments)
        if (childTools === null || childTools.some((t) => !READ_ONLY_TOOL_NAMES.has(t))) {
          delegationThisRoundWasReadOnly = false
        }
      }

      // Artifact tracking
      const artifactAbort = processArtifactOutcome(call, execResult, state)
      if (artifactAbort && !forcedAbortLoopMessage) forcedAbortLoopMessage = artifactAbort

      // Track write-without-verify
      trackWriteVerification(call, execResult, state)

      // Abort directives
      if (execResult.outcome?.directive === ToolControlDirective.AbortLoop && !forcedAbortLoopMessage) {
        forcedAbortLoopMessage = execResult.outcome.summary
      } else if (
        execResult.outcome?.directive === ToolControlDirective.AbortRound &&
        !forcedAbortRoundMessage
      ) {
        forcedAbortRoundMessage = execResult.outcome.summary
      }

      if (forcedAbortLoopMessage || forcedAbortRoundMessage) break
    }
  }

  return {
    roundToolCalls,
    failuresThisRound,
    delegationThisRound,
    delegationThisRoundWasReadOnly,
    forcedAbortRoundMessage,
    forcedAbortLoopMessage
  }
}
