/**
 * Pure Trace → hybrid DAG model.
 *
 * Spine = LLM round-trips (calls). Branches = tool calls from each response.
 * Preamble = system prompt + tools available (what the model was given as
 * context). SQL quality is per-call telemetry — attached to calls, not here.
 */

import type { TraceEntry } from "../../types"

type LlmRequest = Extract<TraceEntry, { kind: "llm-request" }>
type LlmResponse = Extract<TraceEntry, { kind: "llm-response" }>
type SystemPrompt = Extract<TraceEntry, { kind: "system-prompt" }>
type ToolsResolved = Extract<TraceEntry, { kind: "tools-resolved" }>
export type TraceSqlQuality = Extract<TraceEntry, { kind: "planner-sql-quality" }>

export type TraceToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type TracePromptMessage = {
  role: string
  content: string | null
  toolCalls: TraceToolCall[]
  toolCallId: string | null
  speaker: string
  detail?: string
}

export type TraceCallNode = {
  /** 0-based display index (Call N = index + 1). */
  index: number
  iteration: number
  messageCount: number
  toolCount: number
  messages: TracePromptMessage[]
  content: string | null
  toolBranches: TraceToolCall[]
  durationMs: number | null
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  } | null
  headline: string
  askedUser: boolean
  waiting: boolean
  sqlQuality: TraceSqlQuality[]
}

export type TracePreamble = {
  systemPrompt: string | null
  tools: Array<{
    name: string
    description: string
    parameters?: Record<string, unknown>
  }>
}

export type TraceDagStats = {
  callCount: number
  promptTokens: number
  completionTokens: number
  totalDuration: number
}

export type TraceDag = {
  preamble: TracePreamble
  calls: TraceCallNode[]
  stats: TraceDagStats
  hasData: boolean
}

export type TraceCallSearchHit = {
  reasons: string[]
  inHistory: boolean
  inReply: boolean
}

function historySpeaker(role: string): string {
  if (role === "assistant") return "Agent"
  if (role === "system") return "System"
  if (role === "user") return "User"
  if (role === "tool") return "Tool result"
  return role
}

/**
 * Label a history row. ask_user answers are tool-role messages — show as
 * “User answer”, not a generic tool result.
 */
export function historyRowLabel(
  msg: { role: string; toolCallId: string | null; toolCalls: TraceToolCall[] },
  messages: Array<{ role: string; toolCalls: TraceToolCall[] }>,
  index: number,
): { speaker: string; detail?: string } {
  if (msg.role !== "tool") return { speaker: historySpeaker(msg.role) }
  for (let i = index - 1; i >= 0; i--) {
    const prev = messages[i]!
    if (prev.role !== "assistant") continue
    const tc = prev.toolCalls.find((t) => t.id === msg.toolCallId)
    if (!tc) continue
    if (tc.name === "ask_user") {
      return { speaker: "User answer", detail: "via ask_user" }
    }
    return { speaker: "Tool result", detail: tc.name }
  }
  return { speaker: "Tool result" }
}

export function replyHeadline(res: LlmResponse | null): string {
  if (!res) return "Waiting…"
  if (res.toolCalls.length > 0) {
    const names = res.toolCalls.map((t) => t.name)
    if (names.length === 1) return names[0]!
    if (names.length === 2) return `${names[0]}, ${names[1]}`
    return `${names[0]}, ${names[1]} +${names.length - 2}`
  }
  if (res.content) return "Final answer"
  return "Empty reply"
}

function pairLlmCalls(trace: TraceEntry[]): Array<{
  request: LlmRequest
  response: LlmResponse | null
}> {
  const requests = trace.filter((e): e is LlmRequest => e.kind === "llm-request")
  const responses = trace.filter((e): e is LlmResponse => e.kind === "llm-response")
  const responseByIter = new Map<number, LlmResponse>()
  for (const response of responses) {
    if (!responseByIter.has(response.iteration)) {
      responseByIter.set(response.iteration, response)
    }
  }
  return requests.map((request, i) => ({
    request,
    response: responseByIter.get(request.iteration) ?? responses[i] ?? null,
  }))
}

function enrichMessages(messages: LlmRequest["messages"]): TracePromptMessage[] {
  return messages.map((msg, index) => {
    const label = historyRowLabel(msg, messages, index)
    return {
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolCallId: msg.toolCallId,
      speaker: label.speaker,
      ...(label.detail ? { detail: label.detail } : {}),
    }
  })
}

/** Build the hybrid DAG view-model from a raw trace stream. */
export function buildTraceDag(trace: TraceEntry[]): TraceDag {
  const systemPrompt =
    trace.find((e): e is SystemPrompt => e.kind === "system-prompt")?.text ?? null
  const toolsResolved = trace.find((e): e is ToolsResolved => e.kind === "tools-resolved")
  const sqlQuality = trace.filter((e): e is TraceSqlQuality => e.kind === "planner-sql-quality")

  const paired = pairLlmCalls(trace)
  const calls: TraceCallNode[] = paired.map(({ request, response }, index) => {
    const toolBranches = response?.toolCalls ?? []
    const usage = response?.usage ?? null
    return {
      index,
      iteration: request.iteration,
      messageCount: request.messageCount,
      toolCount: request.toolCount,
      messages: enrichMessages(request.messages),
      content: response?.content ?? null,
      toolBranches,
      durationMs: response?.durationMs ?? null,
      usage,
      headline: replyHeadline(response),
      askedUser: toolBranches.some((t) => t.name === "ask_user"),
      waiting: response == null,
      sqlQuality: sqlQuality.filter((s) => s.iteration === request.iteration),
    }
  })

  let promptTokens = 0
  let completionTokens = 0
  let totalDuration = 0
  for (const c of calls) {
    if (c.durationMs != null) totalDuration += c.durationMs
    if (c.usage) {
      promptTokens += c.usage.promptTokens
      completionTokens += c.usage.completionTokens
    }
  }

  const preamble: TracePreamble = {
    systemPrompt,
    tools: toolsResolved?.tools ?? [],
  }

  const hasData =
    Boolean(systemPrompt) ||
    preamble.tools.length > 0 ||
    calls.length > 0 ||
    sqlQuality.length > 0

  return {
    preamble,
    calls,
    stats: {
      callCount: calls.length,
      promptTokens,
      completionTokens,
      totalDuration,
    },
    hasData,
  }
}

/** Where a call matched the filter — shown so search feels intentional. */
export function searchCall(
  call: TraceCallNode,
  rawQuery: string,
): TraceCallSearchHit | null {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return null

  const reasons: string[] = []
  let inHistory = false
  let inReply = false
  const callNo = call.index + 1
  const iterNo = call.iteration + 1

  if (q === String(callNo) || q === `call ${callNo}` || q === `#${callNo}`) {
    reasons.push(`Call ${callNo}`)
  }
  if (q === `iteration ${iterNo}` || q === `iter ${iterNo}` || q === `i${iterNo}`) {
    reasons.push(`Iteration ${iterNo}`)
  } else if (q === String(iterNo) && !reasons.includes(`Call ${callNo}`)) {
    reasons.push(`Iteration ${iterNo}`)
  }

  for (const tc of call.toolBranches) {
    if (tc.name.toLowerCase().includes(q)) {
      reasons.push(`tool ${tc.name}`)
      inReply = true
    }
    if (tc.id.toLowerCase().includes(q)) {
      reasons.push("tool call id")
      inReply = true
    }
    const args = JSON.stringify(tc.arguments).toLowerCase()
    if (args.includes(q) && !reasons.some((r) => r.startsWith("tool "))) {
      reasons.push(`tool args (${tc.name})`)
      inReply = true
    }
  }
  if (call.content?.toLowerCase().includes(q)) {
    reasons.push("agent reply")
    inReply = true
  }
  if (call.headline.toLowerCase().includes(q) && !inReply) {
    reasons.push("outcome")
    inReply = true
  }

  for (const msg of call.messages) {
    if (msg.content?.toLowerCase().includes(q)) {
      inHistory = true
      break
    }
    if (
      msg.role.toLowerCase().includes(q) ||
      msg.speaker.toLowerCase().includes(q)
    ) {
      inHistory = true
      break
    }
    if (msg.toolCallId?.toLowerCase().includes(q)) {
      reasons.push("tool call id")
      inHistory = true
      break
    }
    for (const tc of msg.toolCalls) {
      if (tc.name.toLowerCase().includes(q) || tc.id.toLowerCase().includes(q)) {
        if (tc.id.toLowerCase().includes(q)) reasons.push("tool call id")
        inHistory = true
        break
      }
    }
    if (inHistory) break
  }
  if (inHistory && !reasons.includes("history")) reasons.push("history")

  if (reasons.length === 0) return null
  return { reasons: reasons.slice(0, 3), inHistory, inReply }
}

export function messagePreview(msg: TracePromptMessage): string {
  if (msg.toolCalls.length > 0) {
    return `called ${msg.toolCalls.map((t) => t.name).join(", ")}`
  }
  if (msg.content) {
    const line = msg.content.replace(/\s+/g, " ").trim()
    return line.length > 100 ? `${line.slice(0, 99)}…` : line
  }
  if (msg.toolCallId) return `for ${msg.toolCallId.slice(0, 12)}`
  return "empty"
}
