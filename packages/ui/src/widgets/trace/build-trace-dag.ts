/**
 * Pure Trace → hybrid DAG model.
 *
 * Chronological outline of the agent loop:
 *   Context → Phase* → Call → Work* → Call → …
 *
 * Call = one LLM round-trip (Sent / Received).
 * Work = what happened after that reply (tool runs, nudges, sync, human wait).
 * Phase = planner routing / pipeline / verify / repair spans.
 *
 * Not an OperationLog dump — structural cards in the same dialect as Call.
 */

import type { TraceEntry } from "../../types"

type LlmRequest = Extract<TraceEntry, { kind: "llm-request" }>
type LlmResponse = Extract<TraceEntry, { kind: "llm-response" }>
type SystemPrompt = Extract<TraceEntry, { kind: "system-prompt" }>
type ToolsResolved = Extract<TraceEntry, { kind: "tools-resolved" }>
type ToolCallEntry = Extract<TraceEntry, { kind: "tool-call" }>
type ToolResultEntry = Extract<TraceEntry, { kind: "tool-result" }>
type ToolErrorEntry = Extract<TraceEntry, { kind: "tool-error" }>
export type TraceSqlQuality = Extract<TraceEntry, { kind: "planner-sql-quality" }>

export type TraceToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
  /** Filled when a matching tool-result / tool-error follows in the loop. */
  status?: "running" | "done" | "error"
  resultText?: string
  argsSummary?: string
  argsFormatted?: string
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

export type TracePhaseNode = {
  id: string
  title: string
  summary: string
  status: "running" | "done" | "error"
  lines: string[]
}

export type TraceWorkNote = {
  id: string
  label: string
  text: string
  tone?: "neutral" | "error"
}

export type TraceWorkNode = {
  id: string
  afterCallIndex: number
  title: string
  summary: string
  tools: TraceToolCall[]
  notes: TraceWorkNote[]
}

/** Chronological spine after Context — phases, calls, and between-call work. */
export type TraceSpineEntry =
  | { kind: "phase"; phase: TracePhaseNode }
  | { kind: "call"; callIndex: number }
  | { kind: "work"; work: TraceWorkNode }

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
  toolRunCount: number
  phaseCount: number
}

export type TraceDag = {
  preamble: TracePreamble
  calls: TraceCallNode[]
  spine: TraceSpineEntry[]
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

function parseToolArgs(argsFormatted: string): Record<string, unknown> {
  try {
    const v = JSON.parse(argsFormatted) as unknown
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { raw: argsFormatted }
  } catch {
    return argsFormatted ? { raw: argsFormatted } : {}
  }
}

function humanizeStep(name: string): string {
  return name.replace(/_/g, " ")
}

function phaseFromEntry(
  entry: TraceEntry,
  index: number,
): TracePhaseNode | null {
  switch (entry.kind) {
    case "planning_preflight":
      return { id: `phase-preflight-${index}`, title: "Plan", summary: "Preparing…", status: "running", lines: [] }
    case "planner-decision": {
      const direct = !entry.shouldPlan || entry.route === "direct"
      return {
        id: `phase-decision-${index}`,
        title: direct ? "Direct" : "Plan",
        summary: entry.reason || (direct ? "tool loop" : "orchestrated"),
        status: "done",
        lines: entry.score != null ? [`score ${entry.score}`] : [],
      }
    }
    case "planner-generating":
      return { id: `phase-generating-${index}`, title: "Plan", summary: "Generating plan…", status: "running", lines: [] }
    case "planner-plan-generated":
      return {
        id: `phase-plan-${index}`,
        title: "Plan",
        summary: `${entry.stepCount} step${entry.stepCount !== 1 ? "s" : ""}`,
        status: "done",
        lines: [],
      }
    case "planner-pipeline-start":
      return {
        id: `phase-pipeline-${entry.attempt}`,
        title: "Pipeline",
        summary: entry.attempt > 1 ? `attempt ${entry.attempt}` : "running",
        status: "running",
        lines: [],
      }
    case "planner-pipeline-end":
      return {
        id: `phase-pipeline-end-${index}`,
        title: "Pipeline",
        summary: `${entry.completedSteps}/${entry.totalSteps} steps`,
        status: entry.status === "success" ? "done" : "error",
        lines: [],
      }
    case "planner-step-start":
      return {
        id: `phase-step-${entry.stepName}`,
        title: humanizeStep(entry.stepName),
        summary: "running",
        status: "running",
        lines: [],
      }
    case "planner-step-end": {
      const ok = entry.status === "pass" || entry.status === "success"
      return {
        id: `phase-step-${entry.stepName}`,
        title: humanizeStep(entry.stepName),
        summary: ok ? "done" : entry.error || "failed",
        status: ok ? "done" : "error",
        lines: entry.durationMs != null ? [`${entry.durationMs}ms`] : [],
      }
    }
    case "planner-delegation-start":
      return {
        id: `phase-step-${entry.stepName}`,
        title: humanizeStep(entry.stepName),
        summary: "delegating",
        status: "running",
        lines: entry.tools.slice(0, 4),
      }
    case "planner-delegation-iteration":
      return {
        id: `phase-step-${entry.stepName}`,
        title: humanizeStep(entry.stepName),
        summary: `iteration ${entry.iteration}/${entry.maxIterations}`,
        status: "running",
        lines: entry.toolNames?.slice(0, 3) ?? [],
      }
    case "planner-delegation-end":
      return {
        id: `phase-step-${entry.stepName}`,
        title: humanizeStep(entry.stepName),
        summary: entry.status === "done" ? "done" : entry.error || "failed",
        status: entry.status === "done" ? "done" : "error",
        lines: [],
      }
    case "planner-verification":
      return {
        id: `phase-verify-${index}`,
        title: "Verifying",
        summary: entry.overall,
        status:
          entry.overall === "pass" ? "done" : entry.overall === "fail" ? "error" : "running",
        lines: [],
      }
    case "planner-repair-plan":
      return {
        id: `phase-repair-${entry.attempt}`,
        title: "Repairing",
        summary: `attempt ${entry.attempt}`,
        status: "running",
        lines: [],
      }
    case "direct_loop_fallback":
      return { id: `phase-direct-${index}`, title: "Direct", summary: "tool loop", status: "done", lines: [] }
    default:
      return null
  }
}

function mergePhase(prev: TracePhaseNode | null, next: TracePhaseNode): TracePhaseNode {
  if (!prev || prev.id !== next.id) return next
  return {
    ...next,
    lines: [...prev.lines, ...next.lines].filter((v, i, a) => a.indexOf(v) === i).slice(0, 6),
  }
}

function applyToolResult(
  tools: TraceToolCall[],
  entry: ToolResultEntry | ToolErrorEntry,
): TraceToolCall[] {
  const status: "done" | "error" = entry.kind === "tool-error" ? "error" : "done"
  const id = entry.toolCallId || entry.invocationId
  if (!id) return tools
  let hit = false
  const next = tools.map((t) => {
    if (t.id !== id && t.id !== entry.invocationId && t.id !== entry.toolCallId) return t
    hit = true
    return { ...t, status, resultText: entry.text }
  })
  if (hit) return next
  return next.concat({
    id,
    name: "tool",
    arguments: {},
    status,
    resultText: entry.text,
  })
}

function workTitle(tools: TraceToolCall[], notes: TraceWorkNote[]): string {
  if (tools.length === 0 && notes.length > 0) return notes[0]!.label
  if (tools.length === 1) return tools[0]!.name
  if (tools.length > 1) return `${tools.length} tools`
  return "Work"
}

function workSummary(tools: TraceToolCall[], notes: TraceWorkNote[]): string {
  const bits: string[] = []
  const done = tools.filter((t) => t.status === "done").length
  const err = tools.filter((t) => t.status === "error").length
  const run = tools.filter((t) => t.status === "running" || !t.status).length
  if (tools.length > 0) {
    if (err) bits.push(`${err} failed`)
    if (done) bits.push(`${done} done`)
    if (run) bits.push(`${run} running`)
  }
  if (notes.length > 0) bits.push(`${notes.length} note${notes.length !== 1 ? "s" : ""}`)
  return bits.join(" · ") || "between calls"
}

/** Build the hybrid DAG view-model from a raw trace stream. */
export function buildTraceDag(trace: TraceEntry[]): TraceDag {
  const systemPrompt =
    trace.find((e): e is SystemPrompt => e.kind === "system-prompt")?.text ?? null
  const toolsResolved = trace.find((e): e is ToolsResolved => e.kind === "tools-resolved")
  const sqlQuality = trace.filter((e): e is TraceSqlQuality => e.kind === "planner-sql-quality")

  const paired = pairLlmCalls(trace)
  const calls: TraceCallNode[] = paired.map(({ request, response }, index) => {
    const toolBranches = (response?.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: "running" as const,
    }))
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

  const callByIteration = new Map(calls.map((c) => [c.iteration, c]))
  const spine: TraceSpineEntry[] = []
  let openPhase: TracePhaseNode | null = null
  let openWork: TraceWorkNode | null = null
  let lastCallIndex = -1
  let workSeq = 0

  function flushPhase() {
    if (!openPhase) return
    // Skip bare Direct routing chips — noise in the outline.
    if (!(openPhase.title === "Direct" && openPhase.lines.length === 0)) {
      spine.push({ kind: "phase", phase: openPhase })
    }
    openPhase = null
  }

  function flushWork() {
    if (!openWork) return
    if (openWork.tools.length > 0 || openWork.notes.length > 0) {
      openWork.title = workTitle(openWork.tools, openWork.notes)
      openWork.summary = workSummary(openWork.tools, openWork.notes)
      spine.push({ kind: "work", work: openWork })
      // Mirror execution status onto the preceding call’s Next branches.
      const call = calls[openWork.afterCallIndex]
      if (call) {
        call.toolBranches = call.toolBranches.map((branch) => {
          const exec = openWork!.tools.find(
            (t) => t.id === branch.id || t.name === branch.name,
          )
          return exec
            ? {
                ...branch,
                status: exec.status,
                resultText: exec.resultText,
                argsSummary: exec.argsSummary,
                argsFormatted: exec.argsFormatted,
                arguments:
                  Object.keys(exec.arguments).length > 0 ? exec.arguments : branch.arguments,
              }
            : branch
        })
      }
    }
    openWork = null
  }

  function ensureWork(afterCallIndex: number): TraceWorkNode {
    if (openWork && openWork.afterCallIndex === afterCallIndex) return openWork
    flushWork()
    workSeq += 1
    openWork = {
      id: `work-${afterCallIndex}-${workSeq}`,
      afterCallIndex,
      title: "Work",
      summary: "",
      tools: [],
      notes: [],
    }
    return openWork
  }

  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i]!

    if (entry.kind === "llm-request") {
      flushPhase()
      flushWork()
      const call = callByIteration.get(entry.iteration)
      if (call) {
        spine.push({ kind: "call", callIndex: call.index })
        lastCallIndex = call.index
      }
      continue
    }

    if (entry.kind === "llm-response" || entry.kind === "system-prompt" || entry.kind === "tools-resolved") {
      continue
    }

    if (entry.kind === "planner-sql-quality") {
      continue
    }

    const phase = phaseFromEntry(entry, i)
    if (phase) {
      flushWork()
      openPhase = mergePhase(openPhase, phase)
      if (phase.status === "done" || phase.status === "error") {
        // Close completed phases so the next distinct phase starts fresh.
        if (
          entry.kind === "planner-pipeline-end" ||
          entry.kind === "planner-step-end" ||
          entry.kind === "planner-delegation-end" ||
          entry.kind === "planner-plan-generated" ||
          entry.kind === "planner-decision" ||
          entry.kind === "direct_loop_fallback" ||
          (entry.kind === "planner-verification" &&
            (entry.overall === "pass" || entry.overall === "fail"))
        ) {
          flushPhase()
        }
      }
      continue
    }

    if (lastCallIndex < 0) continue

    if (entry.kind === "tool-call") {
      const work = ensureWork(lastCallIndex)
      const tc = entry as ToolCallEntry
      const id = tc.toolCallId || tc.invocationId
      const existing = work.tools.findIndex((t) => t.id === id || t.id === tc.invocationId)
      const row: TraceToolCall = {
        id,
        name: tc.tool,
        arguments: parseToolArgs(tc.argsFormatted),
        status: "running",
        argsSummary: tc.argsSummary,
        argsFormatted: tc.argsFormatted,
      }
      if (existing >= 0) work.tools[existing] = { ...work.tools[existing]!, ...row }
      else work.tools.push(row)
      continue
    }

    if (entry.kind === "tool-result" || entry.kind === "tool-error") {
      const work = ensureWork(lastCallIndex)
      work.tools = applyToolResult(work.tools, entry)
      continue
    }

    if (entry.kind === "nudge") {
      const work = ensureWork(lastCallIndex)
      work.notes.push({
        id: `nudge-${i}`,
        label: entry.tag || "Nudge",
        text: entry.message,
      })
      continue
    }

    if (entry.kind === "sync-progress") {
      const work = ensureWork(lastCallIndex)
      work.notes.push({
        id: `sync-${entry.invocationId}-${i}`,
        label: entry.headline || entry.tool || "Sync",
        text: entry.detail || entry.status,
      })
      continue
    }

    if (entry.kind === "user-input-request") {
      const work = ensureWork(lastCallIndex)
      work.notes.push({
        id: `ask-${i}`,
        label: "Waiting on user",
        text: entry.question,
      })
      continue
    }

    if (entry.kind === "user-input-response") {
      const work = ensureWork(lastCallIndex)
      work.notes.push({
        id: `answer-${i}`,
        label: "User answered",
        text: entry.text,
      })
      continue
    }

    if (entry.kind === "error" && entry.text !== "Run cancelled by user") {
      const work = ensureWork(lastCallIndex)
      work.notes.push({
        id: `err-${i}`,
        label: "Error",
        text: entry.text,
        tone: "error",
      })
    }
  }

  flushPhase()
  flushWork()

  // Mark unanswered tool branches still running only if call is waiting;
  // otherwise leave as-is after work merge.
  for (const call of calls) {
    if (!call.waiting) {
      call.toolBranches = call.toolBranches.map((t) =>
        t.status === "running" && t.resultText == null ? { ...t, status: undefined } : t,
      )
    }
  }

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

  const toolRunCount = spine.reduce(
    (n, e) => (e.kind === "work" ? n + e.work.tools.length : n),
    0,
  )
  const phaseCount = spine.filter((e) => e.kind === "phase").length

  const hasData =
    Boolean(systemPrompt) ||
    preamble.tools.length > 0 ||
    calls.length > 0 ||
    sqlQuality.length > 0 ||
    spine.length > 0

  return {
    preamble,
    calls,
    spine,
    stats: {
      callCount: calls.length,
      promptTokens,
      completionTokens,
      totalDuration,
      toolRunCount,
      phaseCount,
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
