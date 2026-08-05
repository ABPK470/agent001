import type { TraceEntry } from "@mia/shared-types"

/** Close an open ask_user prompt when a run ends without a user answer. */
export function settleTraceOnCancel(trace: TraceEntry[]): TraceEntry[] {
  const hasRequest = trace.some((entry) => entry.kind === "user-input-request")
  const hasResponse = trace.some((entry) => entry.kind === "user-input-response")
  if (!hasRequest || hasResponse) return trace
  return trace.concat({ kind: "user-input-response", text: "Run cancelled by user" })
}

export function isCancelRaceFailureError(message: string | null | undefined): boolean {
  if (!message) return false
  const text = message.toLowerCase()
  return (
    text.includes("cancelled")
    || text.includes("canceled")
    || text.includes("abort")
    || text.includes("approval denied")
  )
}
