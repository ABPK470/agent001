import type { TraceCallNode, TraceSqlQuality } from "./build-trace-dag"

export function formatCharCount(n: number): string {
  return n.toLocaleString()
}

/** UI badge for SQL check phase — executed runs read as "validated". */
export function sqlQualityPhaseLabel(phase: TraceSqlQuality["phase"]): string {
  if (phase === "executed") return "validated"
  if (phase === "blocked") return "blocked"
  if (phase === "failed") return "failed"
  return phase
}

/** Operator-facing validation code label. */
export function sqlQualityValidationLabel(code: string | null | undefined): string | null {
  if (!code) return null
  if (code === "read_only_tool") return "tool read-only"
  return code
}

export function shortLine(text: string, max = 72): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (!line) return ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function callSentSummary(call: TraceCallNode): string {
  const n = call.messages.length
  const firstUser = call.messages.find((m) => m.role === "user" || m.speaker === "User")
  const peek = firstUser?.content ? shortLine(firstUser.content, 48) : ""
  if (peek) return `${n} messages · ${peek}`
  return `${n} message${n === 1 ? "" : "s"} to model`
}

export function callReceivedSummary(call: TraceCallNode): string {
  if (call.waiting) return "Waiting…"
  if (call.content) return shortLine(call.content, 56) || "Final answer"
  if (call.toolBranches.length > 0) {
    return call.toolBranches.map((t) => t.name).join(", ")
  }
  return "Empty reply"
}
