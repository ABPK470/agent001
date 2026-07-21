import type { TraceCallNode } from "./build-trace-dag"

export function formatCharCount(n: number): string {
  return n.toLocaleString()
}

export function shortLine(text: string, max = 72): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (!line) return ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function callSentSummary(call: TraceCallNode): string {
  const n = call.messageCount
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
