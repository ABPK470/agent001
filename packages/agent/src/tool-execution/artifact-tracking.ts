/**
 * Artifact-tracking helpers used by `executeToolRound` to record
 * mutation outcomes, count repeat failures, route replace_in_file
 * misses through "must read before re-mutate", and detect when the
 * model writes to source files without verifying them.
 *
 * @module
 */

import type { AgentLoopState } from "../agent-loop-state.js"
import { executeToolWithTimeout } from "../tool-utils.js"
import { normalizeArtifactPath } from "./types.js"

export function recordBlockedArtifactFailure(
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
 * Pull the child tool whitelist from a delegate / delegate_parallel call.
 * Returns null if no whitelist was provided (child gets all tools — must be
 * treated as potentially mutating).
 */
export function collectChildToolNames(args: Record<string, unknown>): string[] | null {
  // delegate: { tools: string[] }
  if (Array.isArray(args.tools)) {
    return (args.tools as unknown[]).map((t) => String(t))
  }
  // delegate_parallel: { tasks: [{ tools: string[] }, ...] }
  if (Array.isArray(args.tasks)) {
    const all: string[] = []
    let anyMissing = false
    for (const t of args.tasks as unknown[]) {
      if (t && typeof t === "object" && Array.isArray((t as Record<string, unknown>).tools)) {
        for (const n of (t as { tools: unknown[] }).tools) all.push(String(n))
      } else {
        anyMissing = true
      }
    }
    if (anyMissing) return null
    return all
  }
  return null
}

export function handleReplaceInFileMiss(
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

export function processArtifactOutcome(
  _call: { name: string; arguments: Record<string, unknown> },
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

export function trackWriteVerification(
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
