import type { VerificationAttempt } from "../../core/plan.js"
import { uniqueStrings } from "../delegate-paths.js"

type ChildToolCall = {
  name: string
  args: Record<string, unknown>
  result: string
  isError: boolean
}

function toolCallFailed(call: ChildToolCall): boolean {
  return call.isError || /^Error:/i.test(call.result)
}

function toolCallSucceeded(call: ChildToolCall): boolean {
  return !toolCallFailed(call)
}

export function buildVerificationAttempts(
  toolCalls: readonly ChildToolCall[],
): VerificationAttempt[] {
  return toolCalls
    .filter((call) => call.name === "read_file" || call.name === "run_command")
    .map((call) => ({
      toolName: call.name,
      target:
        typeof call.args.path === "string"
          ? call.args.path
          : typeof call.args.command === "string"
            ? call.args.command
            : undefined,
      success:
        toolCallSucceeded(call) &&
        !/\b(?:Uncaught Exceptions|Console Errors|Network Failures|SyntaxError|failed?)\b/i.test(
          call.result,
        ),
      summary: call.result.slice(0, 240),
    }))
}

/**
 * Summarize a child agent loop for planner reconciliation.
 *
 * Path-level write errors are cleared when a later write succeeds on the
 * same path. Same-tool errors (e.g. empty search_catalog) are cleared when
 * a later call to that tool succeeds — otherwise one bad probe becomes a
 * permanent unresolved_blocker even after the child recovered.
 */
export function buildChildExecutionResult(
  output: string,
  toolCalls: readonly ChildToolCall[],
): import("../../core/plan.js").ChildExecutionResult {
  const mutatedArtifacts = uniqueStrings(
    toolCalls
      .filter(
        (call) =>
          toolCallSucceeded(call) &&
          (call.name === "write_file" ||
            call.name === "replace_in_file" ||
            call.name === "append_file"),
      )
      .map((call) => (typeof call.args.path === "string" ? call.args.path : ""))
      .map((path) => path.replace(/^\.\//, "")),
  )

  const resolvedPaths = new Set(
    toolCalls
      .filter(
        (call) =>
          toolCallSucceeded(call) &&
          (call.name === "write_file" ||
            call.name === "replace_in_file" ||
            call.name === "append_file"),
      )
      .map((call) =>
        typeof call.args.path === "string" ? call.args.path.replace(/^\.\//, "") : "",
      )
      .filter(Boolean),
  )

  const blockers = uniqueStrings(
    toolCalls
      .map((call, index) => ({ call, index }))
      .filter(({ call, index }) => {
        if (!toolCallFailed(call)) return false
        const path =
          typeof call.args.path === "string" ? call.args.path.replace(/^\.\//, "") : ""
        if (path && resolvedPaths.has(path)) return false
        const laterOk = toolCalls
          .slice(index + 1)
          .some((later) => later.name === call.name && toolCallSucceeded(later))
        if (laterOk) return false
        return true
      })
      .map(({ call }) => `${call.name}: ${call.result.slice(0, 240)}`),
  )

  return {
    status: blockers.length > 0 ? (mutatedArtifacts.length > 0 ? "blocked" : "failed") : "success",
    summary: output.slice(0, 400),
    producedArtifacts: mutatedArtifacts,
    modifiedArtifacts: mutatedArtifacts,
    verificationAttempts: buildVerificationAttempts(toolCalls),
    unresolvedBlockers: blockers,
  }
}
