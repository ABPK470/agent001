import type { VerificationAttempt } from "../../application/core/planner.js"
import { uniqueStrings } from "../delegate-paths.js"

export interface ChildSpec {
  goal: string
  agentId?: string
  instructions?: string
  tools?: string[]
  maxIterations?: number
}

export function buildVerificationAttempts(toolCalls: readonly { name: string; args: Record<string, unknown>; result: string; isError: boolean }[]): VerificationAttempt[] {
  return toolCalls
    .filter((call) => call.name === "browser_check" || call.name === "read_file" || call.name === "run_command")
    .map((call) => ({
      toolName: call.name,
      target: typeof call.args.path === "string"
        ? call.args.path
        : typeof call.args.command === "string"
          ? call.args.command
          : undefined,
      success: !call.isError && !/^Error:/i.test(call.result) && !/\b(?:Uncaught Exceptions|Console Errors|Network Failures|SyntaxError|failed?)\b/i.test(call.result),
      summary: call.result.slice(0, 240),
    }))
}

export function buildChildExecutionResult(output: string, toolCalls: readonly { name: string; args: Record<string, unknown>; result: string; isError: boolean }[]): import("../../application/core/planner.js").ChildExecutionResult {
  const mutatedArtifacts = uniqueStrings(toolCalls
    .filter((call) => !call.isError && (call.name === "write_file" || call.name === "replace_in_file" || call.name === "append_file"))
    .map((call) => typeof call.args.path === "string" ? call.args.path : "")
    .map((path) => path.replace(/^\.\//, "")))

  // A path-level error is resolved if a later successful write touched the same artifact.
  const resolvedPaths = new Set(
    toolCalls
      .filter((call) => !call.isError && !/^Error:/i.test(call.result) &&
        (call.name === "write_file" || call.name === "replace_in_file" || call.name === "append_file"))
      .map((call) => typeof call.args.path === "string" ? call.args.path.replace(/^\.\//,  "") : "")
      .filter(Boolean)
  )
  const blockers = uniqueStrings(
    toolCalls
      .filter((call) => {
        if (!call.isError && !/^Error:/i.test(call.result)) return false
        const path = typeof call.args.path === "string" ? call.args.path.replace(/^\.\//,  "") : ""
        if (path && resolvedPaths.has(path)) return false
        return true
      })
      .map((call) => `${call.name}: ${call.result.slice(0, 240)}`)
  )

  return {
    status: blockers.length > 0
      ? (mutatedArtifacts.length > 0 ? "blocked" : "failed")
      : "success",
    summary: output.slice(0, 400),
    producedArtifacts: mutatedArtifacts,
    modifiedArtifacts: mutatedArtifacts,
    verificationAttempts: buildVerificationAttempts(toolCalls),
    unresolvedBlockers: blockers,
  }
}
