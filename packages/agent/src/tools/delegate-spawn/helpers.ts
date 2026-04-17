import type { VerificationAttempt } from "../../planner/types.js"
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

export function buildChildExecutionResult(output: string, toolCalls: readonly { name: string; args: Record<string, unknown>; result: string; isError: boolean }[]): import("../../planner/types.js").ChildExecutionResult {
  const mutatedArtifacts = uniqueStrings(toolCalls
    .filter((call) => !call.isError && (call.name === "write_file" || call.name === "replace_in_file" || call.name === "append_file"))
    .map((call) => typeof call.args.path === "string" ? call.args.path : "")
    .map((path) => path.replace(/^\.\//, "")))

  const blockers = uniqueStrings(toolCalls
    .filter((call) => call.isError || /^Error:/i.test(call.result))
    .map((call) => `${call.name}: ${call.result.slice(0, 240)}`))

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
